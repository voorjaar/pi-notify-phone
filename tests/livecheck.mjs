#!/usr/bin/env node
/**
 * Live lifecycle check.
 *
 * Unit tests prove the decisions; this proves the shipped extension: it drives real Pi sessions
 * through the goal lifecycle and prints the notifications pi-notify actually delivered, read back
 * from the send log.
 *
 * Two session shapes are used on purpose, because they exercise different parts:
 *   print - one `pi -p` run. The agent settles right after create_goal, so the goal is always open
 *           at settlement. A goal can still be completed in one run when the model emits both tool
 *           calls in the same reply.
 *   rpc   - one long-lived session with several prompts, so several runs settle while one goal stays
 *           open. That is the shape the suppressTaskNotify gate exists for.
 *
 * Usage:
 *   node tests/livecheck.mjs                # against the installed pi-notify extension
 *   node tests/livecheck.mjs --local        # against ./src/index.ts (only when pi-notify is NOT
 *                                           #   also installed as a package, or Pi aborts the load
 *                                           #   with a tool-name conflict)
 *   node tests/livecheck.mjs --keep         # keep scratch dirs and the raw event streams
 *   node tests/livecheck.mjs --timeout 240  # per-scenario wall clock in seconds
 *
 * Every notification is pushed to the configured device, so this check is loud on purpose.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const useLocal = argv.includes("--local");
const keepScratch = argv.includes("--keep");
const onlyAt = argv.indexOf("--only");
const onlyFilter = onlyAt >= 0 && argv[onlyAt + 1] ? argv[onlyAt + 1].toLowerCase() : undefined;
const timeoutAt = argv.indexOf("--timeout");
const timeoutSeconds = timeoutAt >= 0 && argv[timeoutAt + 1] ? Number(argv[timeoutAt + 1]) : 240;

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

const OPEN_GOAL_PROMPT = [
	"Call create_goal with objective 'Write one short file', then write that file.",
	"Do NOT call update_goal: the goal must still be open when this run ends.",
	"Do not ask questions.",
].join(" ");

const SECOND_RPC_PROMPT = "Write a file named notes.md containing one short line. Do not call update_goal.";

const COMPLETE_GOAL_PROMPT = "Call update_goal with status 'complete' and a one-sentence reason. Do nothing else.";

const SCENARIOS = [
	{
		name: "rpc, goal completed in a later run, gate off",
		kind: "rpc",
		completeGoal: true,
		env: { PI_NOTIFY_SUPPRESS_TASK_NOTIFY: "0" },
		lifecycle: { goalStarts: 1, goalCompletesAtLeast: 1, runEndsAtLeast: 1 },
		flaky: true,
		informational: true,
		note: "goal started, goal complete in the second run, and settled runs reported as well",
	},
	{
		name: "print, goal left open, gate off",
		kind: "print",
		prompt: OPEN_GOAL_PROMPT,
		env: { PI_NOTIFY_SUPPRESS_TASK_NOTIFY: "0" },
		expect: ["goal_start", "task_complete"],
		note: "print mode settles right after create_goal, so the goal is open at settlement",
	},
	{
		name: "print, goal left open, gate on",
		kind: "print",
		prompt: OPEN_GOAL_PROMPT,
		env: { PI_NOTIFY_SUPPRESS_TASK_NOTIFY: "1" },
		expect: ["goal_start"],
		note: "the same run, with the gate on: only the goal event survives",
	},
	{
		name: "rpc, several runs settle while one goal stays open, gate off",
		kind: "rpc",
		env: { PI_NOTIFY_SUPPRESS_TASK_NOTIFY: "0" },
		lifecycle: { goalStarts: 1, runEndsAtLeast: 1 },
		informational: true,
		note: "every settled run reports, even the ones that settle mid-goal",
	},
	{
		name: "rpc, several runs settle while one goal stays open, gate on",
		kind: "rpc",
		env: { PI_NOTIFY_SUPPRESS_TASK_NOTIFY: "1" },
		lifecycle: { goalStarts: 1, runEndsExactly: 0 },
		informational: true,
		note: "the same session shape, silenced: nothing reports while the goal is open",
	},
];

function logBytes() {
	if (!existsSync(logFile)) return Buffer.alloc(0);
	return readFileSync(logFile);
}

function parseLogText(text) {
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

/**
 * Sends are fire-and-forget inside the extension and other Pi sessions write to the same log. The log is
 * also capped and rewritten, so a byte offset captured before a run can point past the end of the file:
 * the window is the wall-clock span of the run, and sends are matched by the project name they carry.
 * The read repeats until the window stops growing, because a send is logged when its HTTP request lands.
 */
function sendsSince(sinceMs, sessionTag, settleSeconds = 12) {
	const deadline = Date.now() + settleSeconds * 1000;
	let previous = -1;
	for (;;) {
		const window = parseLogText(logBytes().toString("utf8")).filter((send) => typeof send.ts === "number" && send.ts >= sinceMs);
		const tagged = window.filter((send) => typeof send.body === "string" && send.body.includes(`session: ${sessionTag}`));
		const settledAt = Date.now() >= deadline;
		if (tagged.length === previous || settledAt) {
			return { sends: tagged.length > 0 ? tagged : window, untagged: tagged.length === 0 };
		}
		previous = tagged.length;
		spawnSync("sleep", ["1"]);
	}
}

function extensionArgs() {
	const args = [];
	if (useLocal) args.push("-e", join(REPO, "src", "index.ts"), "-ne");
	return args;
}

function scenarioEnv(scenario) {
	return { ...process.env, ...COMMON_ENV, ...scenario.env };
}

/** Tool calls are blocks inside a finished assistant message; turn_end repeats it, so dedupe by call id. */
function collectToolCalls(event, found) {
	if (event?.type !== "message_end") return;
	const message = event.message;
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (typeof block?.type !== "string" || !block.type.toLowerCase().includes("tool")) continue;
		const name = typeof block.name === "string" ? block.name : "unknown";
		const key = `${name}:${block.id ?? ""}`;
		if (found.seen.has(key)) continue;
		found.seen.add(key);
		found.counts.set(name, (found.counts.get(name) ?? 0) + 1);
	}
}

function parseTools(stdout) {
	const found = { seen: new Set(), counts: new Map() };
	for (const line of stdout.split("\n")) {
		try {
			collectToolCalls(JSON.parse(line), found);
		} catch {
			/* not a protocol record */
		}
	}
	return found.counts;
}

function runPrint(scenario, sessionTag, cwd) {
	const sinceMs = Date.now();
	const args = ["--mode", "json", ...extensionArgs(), "-p", scenario.prompt];
	const result = spawnSync("pi", args, {
		cwd,
		encoding: "utf8",
		timeout: timeoutSeconds * 1000,
		maxBuffer: 64 * 1024 * 1024,
		env: scenarioEnv(scenario),
	});
	const stdout = result.stdout ?? "";
	return {
		exitCode: result.status,
		killed: Boolean(result.signal),
		stderrTail: (result.stderr ?? "").trim().split("\n").slice(-3).join("\n"),
		stream: stdout,
		tools: parseTools(stdout),
		...sendsSince(sinceMs, sessionTag),
	};
}

/** One rpc session, two prompts, so two runs settle while the goal is still open. */
function runRpc(scenario, sessionTag, cwd) {
	const sinceMs = Date.now();
	const child = spawn("pi", ["--mode", "rpc", ...extensionArgs()], { cwd, env: scenarioEnv(scenario) });

	const found = { seen: new Set(), counts: new Map() };
	const events = [];
	const failures = [];
	const waits = [];
	let buffer = "";
	let settled = 0;

	child.stdout.on("data", (chunk) => {
		buffer += chunk.toString("utf8");
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
			if (!line) continue;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			events.push(event);
			collectToolCalls(event, found);
			if (event.type === "response" && event.success === false) failures.push(event.error ?? "command failed");
			if (event.type === "agent_settled") settled += 1;
		}
	});

	const stderr = [];
	child.stderr.on("data", (chunk) => stderr.push(chunk.toString("utf8")));

	const write = (record) => child.stdin.write(`${JSON.stringify(record)}\n`);
	const clearWaits = () => {
		for (const poll of waits) clearInterval(poll);
		waits.length = 0;
	};
	// Polling a counter avoids losing a settle that lands between two awaits, which would otherwise
	// hang until the scenario timeout. The cap keeps a busy goal-continuation session from eating it.
	const waitForToolCall = (name, capSeconds) =>
		new Promise((resolve) => {
			const startedAt = Date.now();
			const poll = setInterval(() => {
				if (found.counts.has(name) || (Date.now() - startedAt) / 1000 > capSeconds) {
					clearInterval(poll);
					resolve();
				}
			}, 250);
			waits.push(poll);
		});
	const waitSettled = (capSeconds) =>
		new Promise((resolve) => {
			const base = settled;
			const startedAt = Date.now();
			const poll = setInterval(() => {
				if (settled > base || (Date.now() - startedAt) / 1000 > capSeconds) {
					clearInterval(poll);
					resolve();
				}
			}, 250);
			waits.push(poll);
		});

	const finish = () => {
		clearWaits();
		child.stdin.end();
		spawnSync("sleep", ["1"]);
		child.kill("SIGTERM");
		return {
			exitCode: 0,
			killed: false,
			stderrTail: stderr.join("").trim().split("\n").slice(-3).join("\n"),
			failures,
			stream: events.map((event) => JSON.stringify(event)).join("\n"),
			tools: found.counts,
			...sendsSince(sinceMs, sessionTag),
		};
	};

	const steps = (async () => {
		write({ id: "step-1", type: "prompt", message: OPEN_GOAL_PROMPT });
		await waitSettled(timeoutSeconds - 90);
		// A goal continuation is usually already running, so queue rather than interrupt.
		const step2 = scenario.completeGoal ? COMPLETE_GOAL_PROMPT : SECOND_RPC_PROMPT;
		write({ id: "step-2", type: "prompt", message: step2, streamingBehavior: "followUp" });
		if (scenario.completeGoal) {
			await waitForToolCall("update_goal", 60);
		}
		await waitSettled(45);
		return finish();
	})();

	const deadline = new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutSeconds * 1000));

	return Promise.race([
		steps,
		deadline.then((reason) => {
			child.kill("SIGKILL");
			return {
				exitCode: null,
				killed: true,
				timeout: reason,
				stderrTail: stderr.join("").trim().split("\n").slice(-3).join("\n"),
				failures,
				stream: events.map((event) => JSON.stringify(event)).join("\n"),
				tools: found.counts,
				...sendsSince(sinceMs, sessionTag),
			};
		}),
	]);
}

/**
 * Order-insensitive: the log records when a delivery resolved, not when the event fired, so two sends
 * from one run can appear in either order. What is asserted is which scenarios fired at all.
 */
function judgeSequence(actual, expect) {
	const sorted = (list) => [...list].sort();
	const a = sorted(actual);
	const e = sorted(expect);
	const pass = a.length === e.length && a.every((scope, index) => scope === e[index]);
	return { pass, detail: `expected: ${e.join(", ")}\n  actual:   ${a.join(", ") || "none"}` };
}

/**
 * The rpc verdict counts run-end sends instead of their order: the log records deliveries, deliveries
 * are async, and whether a busy goal session settles again is model-driven. What the gate decides is
 * how many of them exist while the goal is open.
 */
function judgeLifecycle(sends, want) {
	const goalStarts = sends.filter((s) => s.scope === "goal_start").length;
	const goalCompletes = sends.filter((s) => s.scope === "goal_complete").length;
	const runEnds = sends.filter((s) => s.scope === "task_complete" || s.scope === "task_failed").length;
	const ok =
		goalStarts === want.goalStarts &&
		(want.goalCompletesAtLeast === undefined || goalCompletes >= want.goalCompletesAtLeast) &&
		(want.runEndsExactly !== undefined ? runEnds === want.runEndsExactly : runEnds >= want.runEndsAtLeast);
	const detail = [
		`goal started: ${goalStarts} (want ${want.goalStarts})`,
		`goal complete: ${goalCompletes} (want ${want.goalCompletesAtLeast === undefined ? "not asserted" : `at least ${want.goalCompletesAtLeast}`})`,
		`run end: ${runEnds} (want ${want.runEndsExactly !== undefined ? `exactly ${want.runEndsExactly}` : `at least ${want.runEndsAtLeast}`})`,
	].join("\n  ");
	return { pass: ok, detail };
}

function judge(scenario, run) {
	const actual = run.sends.map((send) => send.scope);
	return scenario.lifecycle ? judgeLifecycle(run.sends, scenario.lifecycle) : judgeSequence(actual, scenario.expect);
}

async function runScenario(scenario) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-notify-live-"));
	const tag = cwd.split("/").pop();
	const run = scenario.kind === "rpc" ? await runRpc(scenario, tag, cwd) : runPrint(scenario, tag, cwd);
	const streamPath = join(tmpdir(), `${tag}.jsonl`);
	writeFileSync(streamPath, run.stream);
	run.cwd = cwd;
	run.streamPath = streamPath;
	run.tag = tag;
	if (!keepScratch) rmSync(cwd, { recursive: true, force: true });
	return run;
}

async function main() {
	console.log("pi-notify live lifecycle check");
	console.log(`log: ${logFile}`);
	console.log(`extension: ${useLocal ? join(REPO, "src", "index.ts") : "installed pi-notify package"}`);
	console.log(`timeout: ${timeoutSeconds}s per scenario\n`);

	if (!existsSync(logFile)) {
		console.log(`No send log at ${logFile} yet. Run one pi session that sends a notification first.\n`);
	}

	const scenarios = onlyFilter ? SCENARIOS.filter((s) => s.name.toLowerCase().includes(onlyFilter)) : SCENARIOS;
	if (scenarios.length === 0) {
		console.log(`No scenario matches "${onlyFilter}".`);
		process.exit(1);
	}

	let failures = 0;
	for (const scenario of scenarios) {
		console.log(`=== ${scenario.name} (${scenario.note})`);
		let run = await runScenario(scenario);
		let verdict = judge(scenario, run);

		// Whether the model obeys a prompt is model variance, not a regression: retry once.
		if (!verdict.pass && scenario.flaky) {
			console.log(`  retrying once (model variance)`);
			run = await runScenario(scenario);
			verdict = judge(scenario, run);
		}

		if (run.timeout) console.log(`  pi ${run.timeout} after ${timeoutSeconds}s`);
		else if (run.exitCode !== 0 && run.exitCode !== null) console.log(`  pi exited with ${run.exitCode}`);
		if (run.stderrTail) console.log(`  stderr: ${run.stderrTail}`);
		if (run.failures?.length > 0) console.log(`  failed rpc commands: ${run.failures.join(" | ")}`);

		const tools = [...run.tools.entries()].map(([name, count]) => `${name}=${count}`).join(" ");
		console.log(`  tools called: ${tools || "none"}`);
		if (run.untagged) console.log(`  note: no send carried the session tag ${run.tag}; showing every send in the window`);

		const start = run.sends[0]?.ts;
		for (const send of run.sends) {
			const offset = start ? `+${Math.round((send.ts - start) / 1000)}s` : "+0s";
			const state = send.ok ? "ok" : `FAILED${send.detail ? ` (${send.detail})` : ""}`;
			console.log(`  ${offset}  ${send.scope}  "${send.title}"  ${state}`);
		}

		if (!verdict.pass && !scenario.informational) failures += 1;
		console.log(`  ${verdict.detail}`);
		console.log(`  stream:   ${run.streamPath}`);
		const label = verdict.pass ? "PASS" : scenario.informational ? "NOTED (model-driven, not a gate)" : "FAIL";
		console.log(`  ${label}\n`);
	}

	const gating = scenarios.filter((s) => !s.informational).length;
	console.log(`${gating - failures}/${gating} gating scenarios passed (${scenarios.length - gating} informational)`);
	process.exit(failures > 0 ? 1 : 0);
}

main();
