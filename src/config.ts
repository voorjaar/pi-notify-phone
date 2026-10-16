/**
 * Layered configuration loading for pi-notify. Pure module: no Pi imports.
 *
 * Layers, later ones win:
 *   1. defaults
 *   2. <agentDir>/pi-notify.json        personal, keeps device keys out of the repo
 *   3. <cwd>/.pi/pi-notify.json         per-project override
 *   4. PI_NOTIFY_* environment variables
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDuration, parseWhen } from "./time.ts";
import type {
	BarkAlgorithm,
	ConfigLayer,
	ConfigProblems,
	LoadedConfig,
	NotifyConfig,
	NotifyLevel,
	NotifyScope,
	ProviderName,
	ScheduleEntry,
	StatusColor,
} from "./types.ts";

export const PERSONAL_CONFIG_FILE = "pi-notify.json";
export const PROJECT_CONFIG_FILE = "pi-notify.json";
export const SCHEDULE_FILE = "pi-notify-schedule.json";

export const ALL_SCOPES: NotifyScope[] = [
	"task_start",
	"task_complete",
	"task_failed",
	"question",
	"goal_start",
	"goal_complete",
	"goal_blocked",
	"goal_paused",
	"bg_start",
	"bg_complete",
	"bg_failed",
	"tool_error",
	"ui_prompt",
	"reminder",
	"manual",
];

/** Defaults: a scenario that only says "something began" starts off, results start on. */
export const DEFAULT_SCOPES: Record<NotifyScope, boolean> = {
	task_start: false,
	task_complete: true,
	task_failed: true,
	question: true,
	goal_start: false,
	goal_complete: true,
	goal_blocked: true,
	goal_paused: true,
	bg_start: false,
	bg_complete: true,
	bg_failed: true,
	tool_error: false,
	ui_prompt: true,
	reminder: true,
	manual: true,
};

/** Group names that set several scopes at once, so `goal:off` keeps working after the split. */
export const SCOPE_GROUPS: Record<string, NotifyScope[]> = {
	goal: ["goal_start", "goal_complete", "goal_blocked", "goal_paused"],
	bg: ["bg_start", "bg_complete", "bg_failed"],
};

/** Theme tokens the footer status may be painted with. */
export const STATUS_COLORS: StatusColor[] = ["accent", "success", "warning", "error", "muted", "mdCode", "mdLink"];

const BARK_ALGORITHMS: BarkAlgorithm[] = [
	"aes-128-cbc",
	"aes-192-cbc",
	"aes-256-cbc",
	"aes-128-gcm",
	"aes-192-gcm",
	"aes-256-gcm",
];

export function resolveAgentDir(env: Record<string, string | undefined> = process.env): string {
	const override = env.PI_CODING_AGENT_DIR;
	if (override && override.trim() !== "") return override;
	return join(homedir(), ".pi", "agent");
}

export function defaultConfig(agentDir: string): NotifyConfig {
	return {
		provider: "bark",
		enabled: true,
		titlePrefix: "Pi",
		includeSession: true,
		statusColor: "accent",
		timeoutMs: 8000,
		retries: 2,
		retryDelayMs: 1500,
		barkEncryptionDefaultAlgorithm: "aes-128-cbc",
		bark: {
			keys: [],
			baseUrl: "https://api.day.app",
			group: "pi",
			level: { info: "active", warning: "timeSensitive", critical: "critical" },
			callOnCritical: true,
			autoCopy: false,
			ttlSeconds: 0,
			encryption: { enabled: false, algorithm: "aes-128-cbc" },
		},
		ntfy: {
			server: "https://ntfy.sh",
			markdown: false,
			priority: { info: 3, warning: 4, critical: 5 },
			tags: ["pi"],
			encryption: { enabled: false },
		},
		auto: {
			enabled: true,
			scopes: { ...DEFAULT_SCOPES },
			minRunSeconds: 0,
			goalMinSeconds: 0,
			suppressTaskNotify: false,
			throttleSeconds: 15,
			maxBodyChars: 900,
			notifyAborted: false,
		},
		maxLateMs: 6 * 60 * 60 * 1000,
		logFile: join(agentDir, "pi-notify-log.jsonl"),
		logEnabled: true,
		schedules: [],
		scheduleFile: join(agentDir, SCHEDULE_FILE),
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge: plain objects merge recursively, everything else is replaced. */
export function mergeConfig(base: NotifyConfig, patch: Record<string, unknown>): NotifyConfig {
	const out: NotifyConfig = { ...base };
	// SAFETY: every NotifyConfig field is an enumerable string key, so the shallow copy can be
	// addressed as a dictionary while merging and read back as the same NotifyConfig shape.
	const view = out as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		if (key === "schedules") continue; // handled separately
		const current = view[key];
		if (isPlainObject(current) && isPlainObject(value)) {
			view[key] = { ...current, ...mergeNested(current, value) };
		} else {
			view[key] = value;
		}
	}
	return out;
}

function mergeNested(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		const before = out[key];
		if (isPlainObject(before) && isPlainObject(value)) {
			out[key] = mergeNested(before, value);
		} else {
			out[key] = value;
		}
	}
	return out;
}

function readJsonFile(path: string): { data?: Record<string, unknown>; error?: string } {
	if (!existsSync(path)) return {};
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return { error: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isPlainObject(parsed)) return { error: `${path} must contain a JSON object` };
		return { data: parsed };
	} catch (error) {
		return { error: `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function boolFromEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const text = value.trim().toLowerCase();
	if (text === "" ) return undefined;
	if (["1", "true", "yes", "on"].includes(text)) return true;
	if (["0", "false", "no", "off"].includes(text)) return false;
	return undefined;
}

function numFromEnv(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) ? parsed : undefined;
}

function scopesFromEnv(value: string | undefined): Partial<Record<NotifyScope, boolean>> | undefined {
	if (value === undefined) return undefined;
	const text = value.trim().toLowerCase();
	if (text === "" ) return undefined;
	if (text === "all") {
		const all: Partial<Record<NotifyScope, boolean>> = {};
		for (const scope of ALL_SCOPES) all[scope] = true;
		return all;
	}
	if (text === "none") {
		const none: Partial<Record<NotifyScope, boolean>> = {};
		for (const scope of ALL_SCOPES) none[scope] = false;
		return none;
	}
	const scopes: Partial<Record<NotifyScope, boolean>> = {};
	for (const part of text.split(/[,\s]+/).filter(Boolean)) {
		// Two spellings: `noquestion` and `question:off`. `goal` and `bg` are group names.
		const colon = part.indexOf(":");
		const name = colon >= 0 ? part.slice(0, colon) : part;
		const state = colon >= 0 ? part.slice(colon + 1) : "";
		let negated = false;
		if (state === "off" || state === "false" || state === "0") negated = true;
		else if (state !== "on" && state !== "true" && state !== "1") negated = name.startsWith("no");
		const key = state ? name : negated ? name.slice(2) : name;
		if (state && state !== "on" && state !== "true" && state !== "1" && state !== "off" && state !== "false" && state !== "0") return undefined;
		const targets = SCOPE_GROUPS[key] ?? (ALL_SCOPES.includes(key as NotifyScope) ? [key as NotifyScope] : undefined);
		if (!targets) return undefined;
		for (const scope of targets) scopes[scope] = !negated;
	}
	return Object.keys(scopes).length > 0 ? scopes : undefined;
}

function envLayerPatch(env: Record<string, string | undefined>): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	const provider = env.PI_NOTIFY_PROVIDER;
	if (provider === "bark" || provider === "ntfy") patch.provider = provider;
	const enabled = boolFromEnv(env.PI_NOTIFY_ENABLED);
	if (enabled !== undefined) patch.enabled = enabled;
	const title = env.PI_NOTIFY_TITLE;
	if (title) patch.titlePrefix = title;
	const statusColor = env.PI_NOTIFY_STATUS_COLOR;
	if (statusColor && STATUS_COLORS.includes(statusColor as StatusColor)) patch.statusColor = statusColor;

	const bark: Record<string, unknown> = {};
	if (env.PI_NOTIFY_BARK_KEY) bark.keys = env.PI_NOTIFY_BARK_KEY.split(",").map((k) => k.trim()).filter(Boolean);
	if (env.PI_NOTIFY_BARK_BASE_URL) bark.baseUrl = env.PI_NOTIFY_BARK_BASE_URL;
	if (env.PI_NOTIFY_BARK_GROUP) bark.group = env.PI_NOTIFY_BARK_GROUP;
	if (env.PI_NOTIFY_BARK_SOUND) bark.sound = env.PI_NOTIFY_BARK_SOUND;
	if (env.PI_NOTIFY_BARK_ICON) bark.icon = env.PI_NOTIFY_BARK_ICON;
	const barkEncryption: Record<string, unknown> = {};
	const barkEncrypt = boolFromEnv(env.PI_NOTIFY_BARK_ENCRYPT);
	if (barkEncrypt !== undefined) barkEncryption.enabled = barkEncrypt;
	if (env.PI_NOTIFY_BARK_ENCRYPT_KEY) barkEncryption.key = env.PI_NOTIFY_BARK_ENCRYPT_KEY;
	if (env.PI_NOTIFY_BARK_ENCRYPT_IV) barkEncryption.iv = env.PI_NOTIFY_BARK_ENCRYPT_IV;
	if (env.PI_NOTIFY_BARK_ENCRYPT_ALGORITHM) barkEncryption.algorithm = env.PI_NOTIFY_BARK_ENCRYPT_ALGORITHM;
	if (Object.keys(barkEncryption).length > 0) bark.encryption = barkEncryption;
	if (Object.keys(bark).length > 0) patch.bark = bark;

	const ntfy: Record<string, unknown> = {};
	if (env.PI_NOTIFY_NTFY_SERVER) ntfy.server = env.PI_NOTIFY_NTFY_SERVER;
	if (env.PI_NOTIFY_NTFY_TOPIC) ntfy.topic = env.PI_NOTIFY_NTFY_TOPIC;
	if (env.PI_NOTIFY_NTFY_TOKEN) ntfy.token = env.PI_NOTIFY_NTFY_TOKEN;
	if (env.PI_NOTIFY_NTFY_USER) ntfy.user = env.PI_NOTIFY_NTFY_USER;
	if (env.PI_NOTIFY_NTFY_PASSWORD) ntfy.password = env.PI_NOTIFY_NTFY_PASSWORD;
	const ntfyEncryption: Record<string, unknown> = {};
	const ntfyEncrypt = boolFromEnv(env.PI_NOTIFY_NTFY_ENCRYPT);
	if (ntfyEncrypt !== undefined) ntfyEncryption.enabled = ntfyEncrypt;
	if (env.PI_NOTIFY_NTFY_ENCRYPT_KEY) ntfyEncryption.key = env.PI_NOTIFY_NTFY_ENCRYPT_KEY;
	if (Object.keys(ntfyEncryption).length > 0) ntfy.encryption = ntfyEncryption;
	if (Object.keys(ntfy).length > 0) patch.ntfy = ntfy;

	const auto: Record<string, unknown> = {};
	const autoEnabled = boolFromEnv(env.PI_NOTIFY_AUTO_ENABLED ?? env.PI_NOTIFY_AUTO);
	if (autoEnabled !== undefined) auto.enabled = autoEnabled;
	const scopes = scopesFromEnv(env.PI_NOTIFY_AUTO_SCOPES);
	if (scopes !== undefined) auto.scopes = scopes;
	const minRun = numFromEnv(env.PI_NOTIFY_MIN_RUN_SECONDS);
	if (minRun !== undefined) auto.minRunSeconds = minRun;
	const goalMin = numFromEnv(env.PI_NOTIFY_GOAL_MIN_SECONDS);
	if (goalMin !== undefined) auto.goalMinSeconds = goalMin;
	const goalGate = boolFromEnv(env.PI_NOTIFY_SUPPRESS_TASK_NOTIFY);
	if (goalGate !== undefined) auto.suppressTaskNotify = goalGate;
	const throttle = numFromEnv(env.PI_NOTIFY_THROTTLE_SECONDS);
	if (throttle !== undefined) auto.throttleSeconds = throttle;
	if (Object.keys(auto).length > 0) patch.auto = auto;

	return patch;
}

export function normalizeConfig(config: NotifyConfig): NotifyConfig {
	const out: NotifyConfig = { ...config };
	out.provider = (out.provider === "ntfy" ? "ntfy" : "bark") as ProviderName;
	out.timeoutMs = positiveNumber(out.timeoutMs, 8000);
	out.retries = Math.max(0, Math.floor(Number(out.retries) || 0));
	out.retryDelayMs = Math.max(0, Math.floor(Number(out.retryDelayMs) || 0));
	out.titlePrefix = typeof out.titlePrefix === "string" && out.titlePrefix.trim() !== "" ? out.titlePrefix : "Pi";
	out.statusColor = STATUS_COLORS.includes(out.statusColor) ? out.statusColor : "accent";
	out.auto.minRunSeconds = Number.isFinite(out.auto.minRunSeconds) ? Math.max(0, out.auto.minRunSeconds) : 0;
	out.auto.goalMinSeconds = Number.isFinite(out.auto.goalMinSeconds) ? Math.max(0, out.auto.goalMinSeconds) : 0;
	out.auto.suppressTaskNotify = out.auto.suppressTaskNotify === true;
	out.auto.throttleSeconds = Number.isFinite(out.auto.throttleSeconds) ? Math.max(0, out.auto.throttleSeconds) : 15;
	out.auto.maxBodyChars = positiveNumber(out.auto.maxBodyChars, 900);
	out.barkEncryptionDefaultAlgorithm = BARK_ALGORITHMS.includes(out.barkEncryptionDefaultAlgorithm)
		? out.barkEncryptionDefaultAlgorithm
		: "aes-128-cbc";

	const keys = Array.isArray(out.bark.keys) ? out.bark.keys.map((k) => String(k).trim()).filter(Boolean) : [];
	if (typeof out.bark.key === "string" && out.bark.key.trim() !== "") keys.push(out.bark.key.trim());
	out.bark.keys = Array.from(new Set(keys));
	out.bark.baseUrl = String(out.bark.baseUrl || "https://api.day.app").replace(/\/+$/, "");
	out.bark.group = typeof out.bark.group === "string" && out.bark.group.trim() !== "" ? out.bark.group : "pi";
	out.bark.ttlSeconds = Number.isFinite(Number(out.bark.ttlSeconds)) ? Math.max(0, Math.floor(Number(out.bark.ttlSeconds))) : 0;
	out.bark.level = normalizeLevels(out.bark.level);
	out.bark.encryption.algorithm = BARK_ALGORITHMS.includes(out.bark.encryption.algorithm)
		? out.bark.encryption.algorithm
		: out.barkEncryptionDefaultAlgorithm;

	out.ntfy.server = String(out.ntfy.server || "https://ntfy.sh").replace(/\/+$/, "");
	if (!/^https?:\/\//.test(out.ntfy.server)) out.ntfy.server = `https://${out.ntfy.server}`;
	out.ntfy.topic = typeof out.ntfy.topic === "string" ? out.ntfy.topic.trim() : "";
	out.ntfy.priority = normalizePriorities(out.ntfy.priority);
	out.ntfy.tags = Array.isArray(out.ntfy.tags) ? out.ntfy.tags.map((t) => String(t).trim()).filter(Boolean) : [];

	const scopes = { ...out.auto.scopes };
	for (const scope of ALL_SCOPES) {
		if (typeof scopes[scope] !== "boolean") scopes[scope] = DEFAULT_SCOPES[scope];
	}
	out.auto.scopes = scopes;
	return out;
}

function normalizeLevels(input: unknown): Record<NotifyLevel, string> {
	const base: Record<NotifyLevel, string> = { info: "active", warning: "timeSensitive", critical: "critical" };
	if (!isPlainObject(input)) return base;
	const allowed = new Set(["active", "timeSensitive", "passive", "critical"]);
	for (const level of ["info", "warning", "critical"] as NotifyLevel[]) {
		const value = input[level];
		if (typeof value === "string" && allowed.has(value)) base[level] = value;
	}
	return base;
}

function normalizePriorities(input: unknown): Record<NotifyLevel, number> {
	const base: Record<NotifyLevel, number> = { info: 3, warning: 4, critical: 5 };
	if (!isPlainObject(input)) return base;
	for (const level of ["info", "warning", "critical"] as NotifyLevel[]) {
		const value = Number(input[level]);
		if (Number.isFinite(value) && value >= 1 && value <= 5) base[level] = Math.round(value);
	}
	return base;
}

function positiveNumber(value: unknown, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseScheduleEntries(patch: Record<string, unknown> | undefined, now: number): ScheduleEntry[] {
	const raw = patch?.schedules;
	if (!Array.isArray(raw)) return [];
	const entries: ScheduleEntry[] = [];
	for (const item of raw) {
		if (!isPlainObject(item)) continue;
		const body = typeof item.body === "string" ? item.body.trim() : "";
		if (body === "") continue;
		const id = typeof item.id === "string" && item.id.trim() !== "" ? item.id.trim() : `cfg-${entries.length + 1}`;
		const everyMs = typeof item.every === "string" ? parseDuration(item.every) ?? 0 : 0;
		let dueAt = Number.NaN;
		if (typeof item.at === "string") dueAt = parseWhen(item.at, now) ?? Number.NaN;
		if (!Number.isFinite(dueAt)) {
			if (everyMs > 0) dueAt = now + everyMs;
			else continue;
		}
		entries.push({
			id,
			body,
			title: typeof item.title === "string" ? item.title : undefined,
			level: item.level === "warning" || item.level === "critical" ? item.level : "info",
			dueAt,
			everyMs,
			createdAt: now,
			source: "config",
		});
	}
	return entries;
}

export interface LoadConfigOptions {
	cwd: string;
	agentDir?: string;
	env?: Record<string, string | undefined>;
	now?: number;
}

export function loadConfig(options: LoadConfigOptions): LoadedConfig {
	const env = options.env ?? process.env;
	const agentDir = options.agentDir ?? resolveAgentDir(env);
	const now = options.now ?? Date.now();
	const layers: ConfigLayer[] = [];

	const personalPath = join(agentDir, PERSONAL_CONFIG_FILE);
	const projectPath = join(options.cwd, ".pi", PROJECT_CONFIG_FILE);
	const projectLocalPath = join(options.cwd, ".pi", `${PROJECT_CONFIG_FILE.replace(/\.json$/, "")}.local.json`);

	let config = defaultConfig(agentDir);
	const patches: Array<Record<string, unknown>> = [];

	for (const path of [personalPath, projectPath, projectLocalPath]) {
		const { data, error } = readJsonFile(path);
		layers.push({ path, loaded: data !== undefined, error });
		if (data) patches.push(data);
	}

	const envPatch = envLayerPatch(env);
	if (Object.keys(envPatch).length > 0) layers.push({ path: "env:PI_NOTIFY_*", loaded: true });

	let schedulePatch: Record<string, unknown> | undefined;
	for (const patch of [...patches, envPatch]) {
		if (Array.isArray(patch.schedules)) schedulePatch = patch;
		config = mergeConfig(config, patch);
	}

	config = normalizeConfig(config);
	config.schedules = parseScheduleEntries(schedulePatch, now);

	return { config, layers, problems: findProblems(config, layers) };
}

export function findProblems(config: NotifyConfig, layers: ConfigLayer[]): ConfigProblems {
	const fatal: string[] = [];
	const warnings: string[] = [];

	for (const layer of layers) {
		if (layer.error) warnings.push(layer.error);
	}

	if (config.provider === "bark") {
		if (config.bark.keys.length === 0) fatal.push("bark: no device key configured (bark.key / PI_NOTIFY_BARK_KEY)");
		if (config.bark.encryption.enabled) {
			const key = config.bark.encryption.key ?? "";
			const required = keyBytesRequired(config.bark.encryption.algorithm);
			if (key === "") fatal.push("bark: encryption enabled but bark.encryption.key is missing");
			else if (Buffer.byteLength(key, "utf8") !== required) {
				warnings.push(
					`bark: encryption key is ${Buffer.byteLength(key, "utf8")} bytes but ${config.bark.encryption.algorithm} needs ${required}`,
				);
			}
			const iv = config.bark.encryption.iv;
			if (iv && isGcm(config.bark.encryption.algorithm) && Buffer.byteLength(iv, "utf8") !== 12) {
				warnings.push(`bark: iv should be 12 bytes for ${config.bark.encryption.algorithm}`);
			}
		}
	} else {
		if (!config.ntfy.topic) fatal.push("ntfy: no topic configured (ntfy.topic / PI_NOTIFY_NTFY_TOPIC)");
		if (config.ntfy.topic && !/^[-_A-Za-z0-9]{1,64}$/.test(config.ntfy.topic)) {
			fatal.push("ntfy: topic may only contain letters, numbers, underscores and dashes (max 64 chars)");
		}
		if (config.ntfy.encryption.enabled && !config.ntfy.encryption.key) {
			fatal.push("ntfy: encryption enabled but ntfy.encryption.key is missing");
		}
		if (config.ntfy.user && !config.ntfy.password) warnings.push("ntfy: ntfy.user set without ntfy.password");
		if (!config.ntfy.server.startsWith("https://") && (config.ntfy.token || config.ntfy.password)) {
			warnings.push("ntfy: credentials sent over plain HTTP; use an https server");
		}
	}

	if (!config.enabled) warnings.push("notifications are disabled (enabled=false); /notify on to re-enable");
	return { fatal, warnings };
}

export function keyBytesRequired(algorithm: BarkAlgorithm): number {
	if (algorithm.includes("128")) return 16;
	if (algorithm.includes("192")) return 24;
	return 32;
}

export function isGcm(algorithm: BarkAlgorithm): boolean {
	return algorithm.includes("gcm");
}
