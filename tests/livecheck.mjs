#!/usr/bin/env node
/**
 * Live lifecycle check.
 *
 * Unit tests prove the decisions; this proves the shipped extension: it drives real Pi sessions
 * through the whole lifecycle (goal started -> run settles -> goal complete) and prints the
 * notifications pi-notify actually delivered, read back from the send log.
 *
 * Usage:
 *   node tests/livecheck.mjs                # against the installed pi-notify extension
 *   node tests/livecheck.mjs --local        # against ./src/index.ts (only when pi-notify is NOT
 *                                           #   also installed as a package, or Pi aborts the load
 *                                           #   with a tool-name conflict)
 *   node tests/livecheck.mjs --keep         # keep the scratch project directories
 *   node tests/livecheck.mjs --timeout 420  # per-scenario wall clock in seconds
 *
 * Every notification lands on the configured device, so this check is loud on purpose.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const useLocal = argv.includes("--local");
const keepScratch = argv.includes("--keep");
const timeoutAt = argv.indexOf("--timeout");
const timeoutSeconds = timeoutAt >= 0 && argv[timeoutAt + 1] ? Number(argv[timeoutAt + 1]) : 300;

const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME || tmpdir(), ".pi", "agent");
const logFile = join(agentDir, "pi-notify-log.jsonl");

/** Notifications are pushed, so every scenario neutralizes the personal timing knobs. */
const COMMON_ENV = {
	PI_NOTIFY_AUTO: "1",
	PI_NOTIFY_AUTO_SCOPES: "goal,task_complete,task_failed",
	PI_NOTIFY_MIN_RUN_SECONDS: "0",
	PI_NOTIFY_GOAL_MIN_SECONDS: "0",
	PI_NOTIFY_THROTTLE_SECONDS: "0",
};

const GOAL_PROMPT = [
	"Lifecycle test. Do exactly this, in order:",
	"1. Call create_goal with objective 'Write a lifecycle probe file'.",
	"2. Write a file named probe.md containing one short line.",
	"3. Call update_goal with status 'complete' and a one-sentence reason.",
	"Do not ask questions and do not do anything else.",
].join(" ");

const OPEN_GOAL_PROMPT = [
	"Lifecycle test. Do exactly this, in order:",
	"1. Call create_goal with objective 'Keep a goal open'.",
	"2. Write a file named probe.md containing one short line.",
	"3. Do NOT call update_goal: the goal must stay open when this run ends.",
	"Do not ask questions and do not do anything else.",
].join(" ");

const SCENARIOS = [
	{
		name: "lifecycle, gate off",
		env: { PI_NOTIFY_SUPPRESS_TASK_NOTIFY: "0" },
		prompt: GOAL_PROMPT,
		expect: ["goal", "goal", "task_complete"],
		note: "goal started, goal complete, then the run end is announced as well",
	},
	{
		name: "open goal, gate off",
		env: { PI_NOTIFY_SUPPRESS_TASK_NOTIFY: "0" },
		prompt: OPEN_GOAL_PROMPT,
		expect: ["goal", "task_complete"],
		note: "the goal is still open at settlement, and the gate is off",
	},
	{
		name: "open goal, gate on",
		env: { PI_NOTIFY_SUPPRESS_TASK_NOTIFY: "1" },
		prompt: OPEN_GOAL_PROMPT,
		expect: ["goal"],
		note: "the gate silences the run end while a goal is running",
	},
];

function readLog() {
	if (!existsSync(logFile)) return "";
	return readFileSync(logFile, "utf8");
}

function parseLog(text) {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return undefined;
			}
		})
		.filter(Boolean);
}

/** pi --mode json reports the tools the model actually called. */
function toolNames(stdout) {
	const found = new Map();
	for (const line of stdout.split("\n")) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		const byName = event?.toolUsage?.byName ?? event?.stats?.toolUsage?.byName;
		if (byName && typeof byName === "object") {
			for (const [name, count] of Object.entries(byName)) found.set(name, (found.get(name) ?? 0) + Number(count ?? 1));
		}
	}
	for (const name of ["create_goal", "update_goal"]) {
		if (!found.has(name) && stdout.includes(`"${name}"`)) found.set(name, 1);
	}
	return found;
}

function runScenario(scenario) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-notify-live-"));
	const before = Buffer.byteLength(readLog());
	const args = ["--mode", "json", "-p", scenario.prompt];
	if (useLocal) args.unshift("-e", join(REPO, "src", "index.ts"));

	const result = spawnSync("pi", args, {
		cwd,
		encoding: "utf8",
		timeout: timeoutSeconds * 1000,
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, ...COMMON_ENV, ...scenario.env },
	});
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";

	const sends = parseLog(readLog().slice(before));
	const tools = toolNames(stdout);
	if (!keepScratch) rmSync(cwd, { recursive: true, force: true });

	return {
		cwd,
		exitCode: result.status,
		killed: result.signal !== undefined && result.signal !== null,
		sends,
		tools,
		stderrTail: stderr.trim().split("\n").slice(-3).join("\n"),
	};
}

function main() {
	console.log(`pi-notify live lifecycle check`);
	console.log(`log: ${logFile}`);
	console.log(`extension: ${useLocal ? join(REPO, "src", "index.ts") : "installed pi-notify package"}`);
	console.log(`timeout: ${timeoutSeconds}s per scenario\n`);

	if (!existsSync(logFile)) {
		console.log(`No send log at ${logFile} yet. Run one pi session that sends a notification first.`);
	}

	let failures = 0;
	for (const scenario of SCENARIOS) {
		console.log(`=== ${scenario.name} (${scenario.note})`);
		const run = runScenario(scenario);

		if (run.exitCode !== 0 || run.killed) {
			console.log(`  pi exited with ${run.killed ? "timeout" : run.exitCode}`);
			if (run.stderrTail) console.log(`  stderr: ${run.stderrTail}`);
		}
		const tools = [...run.tools.entries()].map(([name, count]) => `${name}=${count}`).join(" ");
		console.log(`  goal tools called: ${tools || "none"}`);

		const start = run.sends[0]?.ts;
		for (const send of run.sends) {
			const offset = start ? `+${Math.round((send.ts - start) / 1000)}s` : "+0s";
			const state = send.ok ? "ok" : `FAILED${send.detail ? ` (${send.detail})` : ""}`;
			console.log(`  ${offset}  ${send.scope}  "${send.title}"  ${state}`);
		}

		const actual = run.sends.map((send) => send.scope);
		const pass = actual.length === scenario.expect.length && actual.every((scope, index) => scope === scenario.expect[index]);
		if (!pass) failures += 1;
		console.log(`  expected: ${scenario.expect.join(", ")}`);
		console.log(`  actual:   ${actual.join(", ") || "none"}`);
		console.log(`  ${pass ? "PASS" : "FAIL"}\n`);
	}

	console.log(`${SCENARIOS.length - failures}/${SCENARIOS.length} scenarios passed`);
	process.exit(failures > 0 ? 1 : 0);
}

main();
