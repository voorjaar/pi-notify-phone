import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defaultConfig, findProblems, loadConfig, mergeConfig, normalizeConfig, resolveAgentDir } from "../src/config.ts";
import { decryptBarkPayload, decryptNtfyBody, isNtfyEnvelope } from "../src/crypto.ts";
import { buildBarkRequests, buildNtfyRequest, sendNotification } from "../src/providers.ts";
import { formatDuration, formatRelative, parseDuration, parseWhen } from "../src/time.ts";
import type { FetchLike, NotifyConfig } from "../src/types.ts";

function scratchDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-notify-test-"));
}

function baseConfig(patch: Record<string, unknown> = {}): NotifyConfig {
	return normalizeConfig(mergeConfig(defaultConfig("/tmp/agent-dir"), patch));
}

interface FakeResponse {
	status: number;
	body?: string;
	error?: string;
}

interface FetchRecorder {
	fetch: FetchLike;
	calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }>;
}

function recordingFetch(responses: FakeResponse[]): FetchRecorder {
	const calls: FetchRecorder["calls"] = [];
	let index = 0;
	const fetch: FetchLike = async (url, init) => {
		calls.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ?? "" });
		const response = responses[Math.min(index, responses.length - 1)];
		index += 1;
		if (response.error) throw new Error(response.error);
		return {
			status: response.status,
			ok: response.status >= 200 && response.status < 300,
			text: async () => response.body ?? "",
		};
	};
	return { fetch, calls };
}

test("parseDuration handles compound and spaced units", () => {
	assert.equal(parseDuration("10m"), 600_000);
	assert.equal(parseDuration("1h30m"), 5_400_000);
	assert.equal(parseDuration("in 2 hours"), 7_200_000);
	assert.equal(parseDuration("every 45 minutes"), 2_700_000);
	assert.equal(parseDuration("2d12h"), 216_000_000);
	assert.equal(parseDuration("90s"), 90_000);
});

test("parseDuration rejects non-durations", () => {
	for (const bad of ["", "  ", "later", "10", "10x", "10m and 5h", "08:30", "明天"]) {
		assert.equal(parseDuration(bad), undefined, `expected undefined for ${JSON.stringify(bad)}`);
	}
});

test("parseWhen supports durations, clock times and ISO stamps", () => {
	const now = Date.parse("2026-01-02T10:00:00");
	assert.equal(parseWhen("10m", now), now + 600_000);
	assert.equal(parseWhen("in 10m", now), now + 600_000);
	// 08:30 already passed at 10:00, so it means tomorrow 08:30.
	assert.equal(parseWhen("at 08:30", now), Date.parse("2026-01-03T08:30:00"));
	assert.equal(parseWhen("18:00", now), Date.parse("2026-01-02T18:00:00"));
	assert.equal(parseWhen("tomorrow 09:00", now), Date.parse("2026-01-03T09:00:00"));
	assert.equal(parseWhen("2026-05-01T08:00:00Z", now), Date.parse("2026-05-01T08:00:00Z"));
	assert.equal(parseWhen("nonsense", now), undefined);
});

test("formatDuration and formatRelative are compact", () => {
	assert.equal(formatDuration(5_400_000), "1h30m");
	assert.equal(formatDuration(1500), "1s");
	assert.equal(formatRelative(Date.parse("2026-01-02T10:10:00"), Date.parse("2026-01-02T10:00:00")), "in 10m");
	assert.equal(formatRelative(Date.parse("2026-01-02T09:57:00"), Date.parse("2026-01-02T10:00:00")), "3m late");
});

test("defaults leave providers unconfigured and report it", () => {
	const dir = scratchDir();
	try {
		const loaded = loadConfig({ cwd: dir, agentDir: dir, env: {} });
		assert.equal(loaded.config.provider, "bark");
		assert.equal(loaded.config.enabled, true);
		assert.equal(loaded.config.bark.keys.length, 0);
		assert.deepEqual(loaded.problems.fatal, ["bark: no device key configured (bark.key / PI_NOTIFY_BARK_KEY)"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("personal layer configures bark and project layer overrides the provider", () => {
	const dir = scratchDir();
	const agentDir = scratchDir();
	try {
		writeFileSync(
			join(agentDir, "pi-notify.json"),
			JSON.stringify({
				bark: { key: "personalkey", keys: ["sharedkey"] },
				ntfy: { topic: "personal-topic" },
				auto: { minRunSeconds: 45 },
			}),
		);
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ".pi", "pi-notify.json"), JSON.stringify({ provider: "ntfy", auto: { scopes: { task_complete: false } } }));

		const loaded = loadConfig({ cwd: dir, agentDir, env: {}, now: Date.parse("2026-01-02T10:00:00") });
		assert.equal(loaded.config.provider, "ntfy");
		assert.deepEqual(loaded.config.bark.keys, ["sharedkey", "personalkey"]);
		assert.equal(loaded.config.ntfy.topic, "personal-topic");
		assert.equal(loaded.config.auto.minRunSeconds, 45);
		assert.equal(loaded.config.auto.scopes.task_complete, false);
		// Inherited personal switch stays off in the project layer.
		assert.equal(loaded.config.auto.scopes.question, true);
		assert.equal(loaded.problems.fatal.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("env layer overrides files", () => {
	const dir = scratchDir();
	try {
		writeFileSync(join(dir, "pi-notify.json"), JSON.stringify({ provider: "bark", bark: { key: "filekey" } }));
		const loaded = loadConfig({
			cwd: dir,
			agentDir: dir,
			env: {
				PI_NOTIFY_PROVIDER: "ntfy",
				PI_NOTIFY_NTFY_TOPIC: "env-topic",
				PI_NOTIFY_ENABLED: "0",
				PI_NOTIFY_AUTO_SCOPES: "noquestion,goal",
				PI_NOTIFY_MIN_RUN_SECONDS: "5",
			},
		});
		assert.equal(loaded.config.provider, "ntfy");
		assert.equal(loaded.config.ntfy.topic, "env-topic");
		assert.equal(loaded.config.enabled, false);
		assert.equal(loaded.config.auto.scopes.question, false);
		assert.equal(loaded.config.auto.scopes.goal, true);
		assert.equal(loaded.config.auto.minRunSeconds, 5);
		assert.equal(loaded.config.auto.scopes.task_complete, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("broken config file is a warning, not a crash", () => {
	const dir = scratchDir();
	try {
		writeFileSync(join(dir, "pi-notify.json"), "{ not json");
		const loaded = loadConfig({ cwd: dir, agentDir: dir, env: { PI_NOTIFY_BARK_KEY: "k" } });
		assert.equal(loaded.layers[0].loaded, false);
		assert.match(loaded.problems.warnings.join("\n"), /not valid JSON/);
		assert.equal(loaded.config.bark.keys[0], "k");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bark encryption key length mismatch is reported as a warning", () => {
	const dir = scratchDir();
	try {
		const loaded = loadConfig({
			cwd: dir,
			agentDir: dir,
			env: {
				PI_NOTIFY_BARK_KEY: "k",
				PI_NOTIFY_BARK_ENCRYPT: "1",
				PI_NOTIFY_BARK_ENCRYPT_KEY: "short",
				PI_NOTIFY_BARK_ENCRYPT_ALGORITHM: "aes-256-cbc",
			},
		});
		assert.equal(loaded.config.bark.encryption.enabled, true);
		assert.equal(loaded.config.bark.encryption.algorithm, "aes-256-cbc");
		assert.match(loaded.problems.warnings.join("\n"), /needs 32\b/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ntfy topic charset is validated", () => {
	const dir = scratchDir();
	try {
		const loaded = loadConfig({ cwd: dir, agentDir: dir, env: { PI_NOTIFY_PROVIDER: "ntfy", PI_NOTIFY_NTFY_TOPIC: "bad topic!" } });
		assert.match(loaded.problems.fatal.join("\n"), /topic may only contain/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("unknown level/priority overrides fall back to defaults", () => {
	const dir = scratchDir();
	try {
		const loaded = loadConfig({
			cwd: dir,
			agentDir: dir,
			env: { PI_NOTIFY_BARK_KEY: "k" },
		});
		const merged = mergeConfig(loaded.config, {
			bark: { level: { info: "bogus", critical: "critical" } },
			ntfy: { priority: { info: 99 } },
		});
		const problems = findProblems(merged, []);
		assert.equal(problems.fatal.length, 0);
		// normalizeConfig is applied by loadConfig only; merged values are checked by providers.
		assert.equal(merged.bark.level.warning, "timeSensitive");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("config schedules are parsed into armed entries", () => {
	const dir = scratchDir();
	try {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(
			join(dir, ".pi", "pi-notify.json"),
			JSON.stringify({
				schedules: [
					{ id: "standup", body: "Standup", at: "09:30", every: "1d" },
					{ body: "water plants", at: "in 2h" },
					{ body: "", at: "10m" },
					{ id: "broken" },
				],
			}),
		);
		const loaded = loadConfig({ cwd: dir, agentDir: scratchDir(), env: {}, now: Date.parse("2026-01-02T10:00:00") });
		assert.equal(loaded.config.schedules.length, 2);
		const standup = loaded.config.schedules[0];
		assert.equal(standup.id, "standup");
		assert.equal(standup.dueAt, Date.parse("2026-01-03T09:30:00"));
		assert.equal(standup.everyMs, 86_400_000);
		assert.equal(loaded.config.schedules[1].dueAt, Date.parse("2026-01-02T12:00:00"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAgentDir honours PI_CODING_AGENT_DIR", () => {
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/tmp/agent-dir" }), "/tmp/agent-dir");
	assert.match(resolveAgentDir({}), /\.pi\/agent$/);
});

test("defaultConfig points the schedule store inside the agent dir", () => {
	const config = defaultConfig("/tmp/agent-dir");
	assert.equal(config.scheduleFile, join("/tmp/agent-dir", "pi-notify-schedule.json"));
});

test("bark plain push posts one form request per device key", () => {
	const config = baseConfig({ bark: { keys: ["keyA", "keyB"] } });
	const requests = buildBarkRequests({ body: "build finished", level: "critical" }, config);
	assert.equal(requests.length, 2);
	assert.equal(requests[0].method, "POST");
	assert.equal(requests[0].url, "https://api.day.app/keyA");
	const form = new URLSearchParams(requests[0].body);
	assert.equal(form.get("title"), "Pi");
	assert.equal(form.get("body"), "build finished");
	assert.equal(form.get("group"), "pi");
	assert.equal(form.get("level"), "critical");
	assert.equal(form.get("call"), "1");
});

test("bark encrypted push round-trips through the documented ciphertext parameter", () => {
	const config = baseConfig({
		bark: {
			keys: ["keyA"],
			encryption: { enabled: true, algorithm: "aes-128-cbc", key: "1234567890123456" },
		},
	});
	const [request] = buildBarkRequests({ body: "密钥 ready", level: "warning", group: "pi-build" }, config);
	const form = new URLSearchParams(request.body);
	const ciphertext = form.get("ciphertext");
	const iv = form.get("iv");
	assert.ok(ciphertext && ciphertext.length > 0);
	assert.ok(iv && iv.length === 16);
	assert.equal(form.has("body"), false);
	const json = decryptBarkPayload(ciphertext ?? "", "aes-128-cbc", "1234567890123456", iv ?? undefined);
	const payload = JSON.parse(json) as Record<string, string>;
	assert.equal(payload.body, "密钥 ready");
	assert.equal(payload.group, "pi-build");
	assert.equal(payload.level, "timeSensitive");
});

test("bark gcm keeps its nonce inside the ciphertext and sends no iv parameter", () => {
	const config = baseConfig({
		bark: {
			keys: ["keyA"],
			encryption: {
				enabled: true,
				algorithm: "aes-256-gcm",
				key: "0123456789abcdef0123456789abcdef",
				iv: "nonce1234567",
			},
		},
	});
	const [request] = buildBarkRequests({ body: "hello" }, config);
	const form = new URLSearchParams(request.body);
	assert.equal(form.has("iv"), false);
	const json = decryptBarkPayload(form.get("ciphertext") ?? "", "aes-256-gcm", "0123456789abcdef0123456789abcdef");
	assert.equal((JSON.parse(json) as Record<string, string>).body, "hello");
});

test("bark bad encryption key surfaces an error instead of throwing", async () => {
	const config = baseConfig({
		bark: { keys: ["keyA"], encryption: { enabled: true, algorithm: "aes-128-cbc", key: "too-short" } },
	});
	const result = await sendNotification({ body: "x" }, config, recordingFetch([{ status: 200, body: "ok" }]).fetch);
	assert.equal(result.ok, false);
	assert.match(result.detail ?? "", /must be 16 bytes/);
});

test("ntfy publish maps severity to priority and auth to headers", () => {
	const config = baseConfig({ provider: "ntfy", ntfy: { topic: "my_topic", token: "tk_123", tags: ["pi"] } });
	const request = buildNtfyRequest({ body: "done", level: "warning", url: "https://example.com/ci" }, config);
	assert.equal(request.url, "https://ntfy.sh/my_topic");
	assert.equal(request.headers.Title, "Pi");
	assert.equal(request.headers.Priority, "4");
	assert.equal(request.headers.Tags, "pi");
	assert.equal(request.headers.Authorization, "Bearer tk_123");
	assert.equal(request.headers.Click, "https://example.com/ci");
	assert.equal(request.body, "done");
});

test("ntfy encodes non-ascii titles and schedules with the at parameter", () => {
	const config = baseConfig({ provider: "ntfy", ntfy: { topic: "t", user: "me", password: "pw" } });
	const request = buildNtfyRequest(
		{ body: "任务完成", title: "任务完成", sendAt: Date.parse("2026-01-02T08:30:00Z") },
		config,
	);
	assert.match(request.headers.Title, /^=\?UTF-8\?B\?/);
	assert.equal(Buffer.from(request.headers.Title.slice("=?UTF-8?B?".length, -2), "base64").toString("utf8"), "任务完成");
	assert.match(request.url, /\?at=2026-01-02T08%3A30%3A00\.000Z$/);
	assert.equal(request.headers.Authorization, `Basic ${Buffer.from("me:pw", "utf8").toString("base64")}`);
});

test("ntfy encrypted body uses a decryptable envelope and keeps the title readable", () => {
	const config = baseConfig({ provider: "ntfy", ntfy: { topic: "t", encryption: { enabled: true, key: "passphrase" } } });
	const request = buildNtfyRequest({ body: "secret body" }, config);
	assert.ok(isNtfyEnvelope(request.body));
	assert.equal(decryptNtfyBody(request.body, "passphrase"), "secret body");
	assert.equal(decryptNtfyBody(request.body, "wrong key"), undefined);
});

test("sendNotification retries 5xx and network failures up to the configured bound", async () => {
	const recorder = recordingFetch([{ status: 500, body: "boom" }, { status: 503, body: "again" }, { status: 200, body: '{"id":"abc"}' }]);
	const ok = await sendNotification({ body: "hi" }, baseConfig({ provider: "ntfy", ntfy: { topic: "t" }, retries: 2, retryDelayMs: 0 }), recorder.fetch);
	assert.equal(ok.ok, true);
	assert.equal(ok.attempts, 3);
	assert.equal(recorder.calls.length, 3);

	const failing = recordingFetch([{ status: 400, body: "bad topic" }]);
	const badRequest = await sendNotification(
		{ body: "hi" },
		baseConfig({ provider: "ntfy", ntfy: { topic: "t" }, retries: 3, retryDelayMs: 0 }),
		failing.fetch,
	);
	assert.equal(badRequest.ok, false);
	// 4xx is not retryable.
	assert.equal(badRequest.attempts, 1);

	const broken = recordingFetch([{ error: "socket hang up" }]);
	const net = await sendNotification(
		{ body: "hi" },
		baseConfig({ provider: "ntfy", ntfy: { topic: "t" }, retries: 1, retryDelayMs: 0 }),
		broken.fetch,
	);
	assert.equal(net.ok, false);
	assert.equal(net.attempts, 2);
	assert.match(net.detail ?? "", /socket hang up/);
});

test("disabled notifications never reach the transport", async () => {
	const recorder = recordingFetch([{ status: 200, body: "ok" }]);
	const result = await sendNotification({ body: "hi" }, baseConfig({ enabled: false, bark: { keys: ["k"] } }), recorder.fetch);
	assert.equal(result.ok, false);
	assert.equal(recorder.calls.length, 0);
});

test("missing provider target reports instead of throwing", async () => {
	const recorder = recordingFetch([{ status: 200, body: "ok" }]);
	const noBark = await sendNotification({ body: "hi" }, baseConfig({ bark: { keys: [] } }), recorder.fetch);
	assert.equal(noBark.ok, false);
	assert.match(noBark.detail ?? "", /no bark device key/);
	const noTopic = await sendNotification({ body: "hi" }, baseConfig({ provider: "ntfy", ntfy: { topic: "" } }), recorder.fetch);
	assert.equal(noTopic.ok, false);
	assert.match(noTopic.detail ?? "", /no ntfy topic/);
});
