/**
 * pi-notify: send notifications to the user from Pi.
 *
 * Providers: Bark (https://bark.day.app) and ntfy (https://docs.ntfy.sh).
 * Scenarios: task finished or failed, a question is waiting for the user, goal events,
 * reminders the user asks for, and scheduled/recurring notifications.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NotifyBus, decideRunEnd, readNotifyLog } from "./src/bus.ts";
import { loadConfig, resolveAgentDir } from "./src/config.ts";
import { decryptNtfyBody, isNtfyEnvelope } from "./src/crypto.ts";
import { sendNotification } from "./src/providers.ts";
import { ReminderScheduler, fileStore } from "./src/scheduler.ts";
import { formatDuration, formatRelative, formatWhen, parseDuration, parseWhen } from "./src/time.ts";
import type { FetchLike, NotifyConfig, NotifyLevel, NotifyRequest, NotifyScope, ScheduleEntry, SendResult } from "./src/types.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(EXT_DIR, "skills", "notify", "SKILL.md");

const SCOPES: NotifyScope[] = ["task_complete", "task_failed", "question", "goal", "tool_error", "ui_prompt", "reminder", "manual"];

const fetchImpl: FetchLike = async (url, init) => {
	const response = await fetch(url, init);
	return { status: response.status, ok: response.ok, text: () => response.text() };
};

interface RunState {
	startedAt: number;
	turns: number;
	toolErrors: number;
	lastError?: string;
	lastStopReason?: string;
}

export default function (pi: ExtensionAPI) {
	let config: NotifyConfig = loadConfig({ cwd: process.cwd(), agentDir: resolveAgentDir() }).config;
	let problems = loadConfig({ cwd: process.cwd(), agentDir: resolveAgentDir() }).problems;
	let latestCtx: ExtensionContext | undefined;
	let scheduler: ReminderScheduler | undefined;
	let run: RunState = { startedAt: 0, turns: 0, toolErrors: 0 };
	let goalStartedAt = 0;
	let goalActive = false;

	const bus: NotifyBus = new NotifyBus(config, {
		transport: (req): Promise<SendResult> => sendNotification(req, bus.getConfig(), fetchImpl),
		sessionName: () => basename(latestCtx?.cwd ?? process.cwd()),
		onEvent: (message, level) => latestCtx?.ui.notify(message, level),
	});

	function refreshContext(ctx: ExtensionContext): void {
		latestCtx = ctx;
		bus.setConfig(config);
	}

	function reloadContextConfig(ctx: ExtensionContext): void {
		const loaded = loadConfig({ cwd: ctx.cwd, agentDir: resolveAgentDir() });
		config = loaded.config;
		problems = loaded.problems;
		bus.setConfig(config);
	}

	const timerHandles = new Map<string, ReturnType<typeof setTimeout>>();
	let timerSeq = 0;

	function armScheduler(ctx: ExtensionContext): void {
		scheduler?.dispose();
		scheduler = new ReminderScheduler({
			store: fileStore(config.scheduleFile),
			clock: {
				now: () => Date.now(),
				setTimeout: (fn, ms) => {
					timerSeq += 1;
					const id = String(timerSeq);
					timerHandles.set(id, setTimeout(fn, ms));
					return { id };
				},
				clearTimeout: (handle) => {
					const handle2 = timerHandles.get(handle.id);
					if (handle2 !== undefined) clearTimeout(handle2);
					timerHandles.delete(handle.id);
				},
			},
			deliver: async (entry, late) => {
				const meta = late ? [`due ${formatWhen(entry.dueAt)}, delivered ${formatRelative(entry.dueAt, Date.now())}`] : [];
				await bus.send({
					scope: "reminder",
					title: entry.title ?? "Reminder",
					body: entry.body,
					level: entry.level ?? "info",
					meta,
				});
			},
			maxLateMs: config.maxLateMs,
			onEvent: (message, level) => ctx.ui.notify(message, level),
		});
		for (const entry of config.schedules) {
			scheduler.add({ id: entry.id, body: entry.body, title: entry.title, level: entry.level, dueAt: entry.dueAt, everyMs: entry.everyMs, source: "config" });
		}
		scheduler.arm();
	}

	function reminders(): ScheduleEntry[] {
		return scheduler?.list() ?? [];
	}

	function statusLine(): string {
		const pending = reminders().length;
		const provider = config.provider;
		const state = config.enabled ? (config.auto.enabled ? "on" : "manual only") : "off";
		const muted = bus.mutedUntil > Date.now();
		return `notify ${provider} ${state}${muted ? " (muted)" : ""}${pending ? ` · ${pending} reminders` : ""}`;
	}

	function reportSend(scope: NotifyScope, result: SendResult, ctx: ExtensionContext): void {
		if (scope === "manual") return;
		if (!result.ok && result.attempts > 0) ctx.ui.notify(`pi-notify: ${result.detail ?? "send failed"}`, "warning");
	}

	function notify(scope: NotifyScope, input: Omit<NotifyRequest, "scope">, ctx: ExtensionContext): void {
		void bus.send({ scope, ...input }).then((result) => reportSend(scope, result, ctx));
	}

	// ---- lifecycle -----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		refreshContext(ctx);
		reloadContextConfig(ctx);
		armScheduler(ctx);
		run = { startedAt: 0, turns: 0, toolErrors: 0 };
		goalStartedAt = 0;
		goalActive = false;
		if (problems.fatal.length > 0) {
			ctx.ui.notify(`pi-notify: ${problems.fatal.join(" · ")} - see /notify status`, "warning");
		}
		ctx.ui.setStatus("pi-notify", statusLine());
	});

	pi.on("session_shutdown", async () => {
		scheduler?.dispose();
		scheduler = undefined;
		latestCtx?.ui.setStatus("pi-notify", undefined);
	});

	pi.on("resources_discover", async () => ({ skillPaths: [SKILL_PATH] }));

	pi.on("agent_start", async () => {
		run = { startedAt: Date.now(), turns: 0, toolErrors: 0 };
	});

	pi.on("turn_start", async () => {
		run.turns += 1;
	});

	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "assistant") {
			// A goal continuation turn means a goal is still running in this session.
			const content = (message as { content?: unknown }).content;
			const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
			if (text.includes("pi_goal_continuation")) goalActive = true;
			return;
		}
		run.lastStopReason = message.stopReason;
		if (message.errorMessage) run.lastError = message.errorMessage;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) run.toolErrors += 1;
		if (event.isError && config.auto.scopes.tool_error) {
			notify("tool_error", { title: "Tool failed", body: `${event.toolName} failed`, level: "warning" }, ctx);
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "ask_user_question") {
			const questions = Array.isArray(event.input?.questions) ? event.input.questions : [];
			const first = questions[0] as { question?: string } | undefined;
			const count = questions.length;
			notify(
				"question",
				{
					title: count > 1 ? `${count} questions waiting` : "Question waiting",
					body: first?.question ?? "Pi is waiting for your answer.",
					level: "warning",
				},
				ctx,
			);
			return;
		}
		if (event.toolName === "update_goal") {
			const status = typeof event.input?.status === "string" ? event.input.status : "";
			const reason = typeof event.input?.reason === "string" ? event.input.reason : `The current goal is ${status}.`;
			if (status === "complete") {
				const startedAt = goalStartedAt || run.startedAt || Date.now();
				const seconds = Math.round((Date.now() - startedAt) / 1000);
				// A goal that finished immediately is usually something the user is already watching.
				if (seconds >= config.auto.goalMinSeconds) {
					notify("goal", { title: "Goal complete", body: reason, meta: [`goal ran ${formatDuration(seconds * 1000)}`], level: "info" }, ctx);
				}
				goalStartedAt = 0;
				goalActive = false;
				return;
			}
			if (status === "blocked" || status === "paused") {
				goalActive = false;
				notify("goal", { title: `Goal ${status}`, body: reason, level: "warning" }, ctx);
			} else if (status !== "") {
				goalActive = true;
			}
			return;
		}
		if (event.toolName === "create_goal") {
			goalStartedAt = Date.now();
			goalActive = true;
			notify("goal", { title: "Goal started", body: "A new goal is running.", level: "info" }, ctx);
		}
	});

	pi.on("ui_prompt_start", async (event, ctx) => {
		notify("ui_prompt", { title: "Waiting for input", body: event.title ? `${event.kind}: ${event.title}` : `Pi is waiting for ${event.kind} input.`, level: "warning" }, ctx);
	});

	pi.on("agent_settled", async (event, ctx) => {
		const startedAt = run.startedAt || Date.now();
		const seconds = Math.round((Date.now() - startedAt) / 1000);
		const failed = Boolean(run.lastError) || run.lastStopReason === "error";

		const decision = decideRunEnd({ goalActive, aborted: event.aborted, failed, seconds }, config.auto);
		if (!decision) return;

		if (decision.scope === "task_failed") {
			if (event.aborted) {
				notify("task_failed", { title: "Run aborted", body: `The run was aborted after ${formatDuration(seconds * 1000)}.`, level: "warning" }, ctx);
				return;
			}
			notify("task_failed", { title: "Task failed", body: run.lastError ?? "The run ended with an error.", meta: [`${run.turns} turns, ${formatDuration(seconds * 1000)}`, `tool errors: ${run.toolErrors}`], level: "warning" }, ctx);
			return;
		}

		notify(
			"task_complete",
			{
				title: "Task finished",
				body: `Finished after ${formatDuration(seconds * 1000)} (${run.turns} turns).`,
				meta: run.toolErrors > 0 ? [`tool errors: ${run.toolErrors}`] : [],
			},
			ctx,
		);
	});

	// ---- tools ---------------------------------------------------------------

	const notifyTool = defineTool({
		name: "notify",
		label: "Notify",
		description:
			"Send the user a notification on their phone (Bark or ntfy). Use for task results the user asked to be notified about, and to remind the user of something at a time they named. Supports one-shot and recurring schedules.",
		promptSnippet: "Send or schedule a phone notification for the user",
		promptGuidelines: [
			"Use notify when the user asks to be reminded of something, or explicitly asks to be notified when work finishes.",
			"Use `in` for relative times (\"10m\", \"2h\") and `at` for absolute times (\"08:30\", \"2026-01-02T09:00\", \"tomorrow 09:00\").",
			"Use `every` to repeat a notification; omit it for a one-shot reminder.",
		],
		parameters: Type.Object({
			body: Type.String({ description: "Notification text" }),
			title: Type.Optional(Type.String({ description: "Notification title; defaults to the configured title" })),
			level: Type.Optional(Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("critical")])),
			group: Type.Optional(Type.String({ description: "Provider grouping key" })),
			url: Type.Optional(Type.String({ description: "URL to open when the notification is tapped" })),
			sound: Type.Optional(Type.String({ description: "Provider sound (Bark sound name)" })),
			in: Type.Optional(Type.String({ description: "Deliver after this duration, e.g. \"10m\", \"1h30m\"" })),
			at: Type.Optional(Type.String({ description: "Deliver at this time, e.g. \"08:30\", \"tomorrow 09:00\", ISO date-time" })),
			every: Type.Optional(Type.String({ description: "Repeat every this duration, e.g. \"1d\"" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			refreshContext(ctx);
			const level = (params.level ?? "info") as NotifyLevel;
			const everyMs = params.every ? parseDuration(params.every) : undefined;
			if (params.every && everyMs === undefined) {
				return toolResult(`every "${params.every}" is not a duration. Use forms like 10m, 1h30m, 1d.`, { ok: false, error: "bad_every" });
			}
			const when = params.at ? parseWhen(params.at, Date.now()) : params.in ? parseDuration(params.in) : undefined;
			if ((params.at || params.in) && when === undefined) {
				return toolResult(`time "${params.at ?? params.in}" is not a duration or clock time. Use 10m, 08:30, or an ISO date-time.`, { ok: false, error: "bad_time" });
			}

			if (when === undefined) {
				const result = await bus.send({ scope: "manual", body: params.body, title: params.title, level, group: params.group, url: params.url, sound: params.sound });
				return toolResult(result.ok ? `sent: ${result.detail ?? "ok"}` : `not sent: ${result.detail}`, { ok: result.ok, provider: result.provider, encrypted: result.encrypted });
			}

			const dueAt = params.at ? (when as number) : Date.now() + (when as number);
			const scheduleProviderServer = config.provider === "ntfy" && everyMs === undefined && config.ntfy.encryption.enabled === false;
			if (scheduleProviderServer) {
				const result = await bus.send({ scope: "reminder", body: params.body, title: params.title ?? "Reminder", level, group: params.group, url: params.url, sendAt: dueAt });
				if (result.ok) {
					return toolResult(`scheduled on the ntfy server for ${formatWhen(dueAt)}`, { ok: true, scheduledAt: dueAt, onServer: true });
				}
			}
			if (!scheduler) armScheduler(ctx);
			const entry = scheduler?.add({ body: params.body, title: params.title ?? "Reminder", level, dueAt, everyMs: everyMs ?? 0, source: "tool" });
			if (!entry) return toolResult("scheduler is unavailable; the reminder was not stored", { ok: false, error: "no_scheduler" });
			return toolResult(
				`scheduled ${entry.id} for ${formatWhen(entry.dueAt)}${entry.everyMs > 0 ? ` every ${formatDuration(entry.everyMs)}` : ""} (${formatRelative(entry.dueAt, Date.now())})`,
				{ ok: true, id: entry.id, scheduledAt: entry.dueAt, everyMs: entry.everyMs },
			);
		},
	});

	const remindersTool = defineTool({
		name: "notify_reminders",
		label: "Reminders",
		description: "List, cancel, or clear the notifications pi-notify has scheduled.",
		promptSnippet: "List or cancel scheduled notifications",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("cancel"), Type.Literal("clear")]),
			id: Type.Optional(Type.String({ description: "Reminder id for action=cancel" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			refreshContext(ctx);
			if (!scheduler) armScheduler(ctx);
			if (params.action === "list") {
				const entries = reminders();
				if (entries.length === 0) return toolResult("no scheduled notifications", { count: 0 });
				return toolResult(
					entries.map((entry) => `${entry.id}  ${formatWhen(entry.dueAt)}${entry.everyMs ? ` every ${formatDuration(entry.everyMs)}` : ""}  ${entry.body}`).join("\n"),
					{ count: entries.length },
				);
			}
			if (params.action === "cancel") {
				if (!params.id) return toolResult("cancel needs an id", { ok: false, error: "missing_id" });
				const removed = scheduler?.cancel(params.id) ?? false;
				return toolResult(removed ? `cancelled ${params.id}` : `no reminder with id ${params.id}`, { ok: removed });
			}
			const removed = scheduler?.clear() ?? 0;
			return toolResult(`cleared ${removed} scheduled notification(s)`, { ok: true, removed });
		},
	});

	const notifyStatusTool = defineTool({
		name: "notify_status",
		label: "Notify status",
		description: "Report how pi-notify is configured: provider, switches, pending reminders, and the last send attempts.",
		promptSnippet: "Check how notifications are configured before promising one",
		promptGuidelines: [
			"Call notify_status before telling the user that a notification will arrive, so you can say whether notifications are actually enabled.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			refreshContext(ctx);
			reloadContextConfig(ctx);
			const recent = readNotifyLog(config.logFile, 5);
			const history = recent.length === 0 ? "no send history yet" : recent.map((entry) => `${entry.ok ? "sent" : entry.detail ?? "failed"} ${entry.scope}`).join(", ");
			return toolResult(`${describeStatus()}\nlast sends: ${history}`, { ok: problems.fatal.length === 0 });
		},
	});

	pi.registerTool(notifyTool);
	pi.registerTool(remindersTool);
	pi.registerTool(notifyStatusTool);

	// ---- command -------------------------------------------------------------

	pi.registerCommand("notify", {
		description: "Send, schedule, and control notifications (notify [on|off|status|test|send|schedule|list|cancel|clear|provider|scope|tasknotify|mute|log|decrypt])",
		getArgumentCompletions(argumentPrefix) {
			const prefix = (argumentPrefix ?? "").toLowerCase();
			const options = [
				"on",
				"off",
				"auto on",
				"auto off",
				"status",
				"test",
				"send <text>",
				"schedule <when> <text> [every <dur>]",
				"list",
				"cancel <id>",
				"clear",
				"provider bark",
				"provider ntfy",
				"scope <name> on|off",
				"tasknotify on|off",
				"mute [minutes]",
				"unmute",
				"log [n]",
				"decrypt <text>",
			];
			const values = options.filter((option) => option.startsWith(prefix));
			return values.map((value) => ({ value, label: value }));
		},
		async handler(args: string, ctx: ExtensionContext & { waitForIdle?: () => Promise<void> }) {
			const parts = (args ?? "").trim().length > 0 ? (args as string).trim().split(/\s+/) : [];
			refreshContext(ctx);
			reloadContextConfig(ctx);
			if (!scheduler) armScheduler(ctx);
			const sub = (parts[0] ?? "status").toLowerCase();

			if (sub === "on" || sub === "off") {
				config.enabled = sub === "on";
				bus.setConfig(config);
				ctx.ui.notify(`pi-notify ${sub} (this session). Edit pi-notify.json to make it permanent.`, "info");
				ctx.ui.setStatus("pi-notify", statusLine());
				return;
			}
			if (sub === "auto") {
				const state = (parts[1] ?? "").toLowerCase();
				if (state !== "on" && state !== "off") {
					ctx.ui.notify("usage: /notify auto on|off", "warning");
					return;
				}
				config.auto.enabled = state === "on";
				bus.setConfig(config);
				ctx.ui.notify(`automatic notifications ${state}; manual sends stay ${config.auto.scopes.manual ? "on" : "off"}`, "info");
				ctx.ui.setStatus("pi-notify", statusLine());
				return;
			}
			if (sub === "scope") {
				const scope = parts[1] as NotifyScope | undefined;
				const state = (parts[2] ?? "").toLowerCase();
				if (!scope || !SCOPES.includes(scope) || (state !== "on" && state !== "off")) {
					ctx.ui.notify(`usage: /notify scope <${SCOPES.join("|")}> on|off`, "warning");
					return;
				}
				config.auto.scopes[scope] = state === "on";
				bus.setConfig(config);
				ctx.ui.notify(`scope ${scope} ${state}`, "info");
				return;
			}
			if (sub === "tasknotify") {
				const state = (parts[1] ?? "").toLowerCase();
				if (state !== "on" && state !== "off") {
					ctx.ui.notify("usage: /notify tasknotify on|off", "warning");
					return;
				}
				config.auto.suppressTaskNotify = state === "on";
				bus.setConfig(config);
				ctx.ui.notify(
					`run-end notifications while a goal runs: ${state === "on" ? "suppressed" : "enabled"}. Edit pi-notify.json to make it permanent.`,
					"info",
				);
				ctx.ui.setStatus("pi-notify", statusLine());
				return;
			}
			if (sub === "provider") {
				const provider = (parts[1] ?? "").toLowerCase();
				if (provider !== "bark" && provider !== "ntfy") {
					ctx.ui.notify("usage: /notify provider bark|ntfy", "warning");
					return;
				}
				config.provider = provider;
				bus.setConfig(config);
				problems = reloadProblems();
				ctx.ui.notify(`provider is ${provider}${problems.fatal.length ? ` (${problems.fatal.join(" · ")})` : ""}`, problems.fatal.length ? "warning" : "info");
				ctx.ui.setStatus("pi-notify", statusLine());
				return;
			}
			if (sub === "test") {
				const result = await bus.send({ scope: "manual", title: "pi-notify test", body: `provider ${config.provider}${config.provider === "bark" ? ` key ${describeBarkKeys()}` : ` topic ${config.ntfy.topic}`}${config.enabled && config.auto.enabled ? "" : " (manual send)"}`, level: "info" });
				ctx.ui.notify(result.ok ? `sent: ${result.detail}` : `failed: ${result.detail}`, result.ok ? "info" : "error");
				return;
			}
			if (sub === "send") {
				const body = parts.slice(1).join(" ");
				if (!body) {
					ctx.ui.notify("usage: /notify send <text>", "warning");
					return;
				}
				const result = await bus.send({ scope: "manual", body, level: "info" });
				ctx.ui.notify(result.ok ? `sent: ${result.detail}` : `not sent: ${result.detail}`, result.ok ? "info" : "error");
				return;
			}
			if (sub === "schedule") {
				const rest = parts.slice(1).join(" ");
				const parsed = splitSchedule(rest);
				if (!parsed) {
					ctx.ui.notify("usage: /notify schedule <when> <text> [every <duration>]   e.g. /notify schedule 20m stretch", "warning");
					return;
				}
				const entry = scheduler?.add({ body: parsed.text, title: "Reminder", level: "info", dueAt: parsed.dueAt, everyMs: parsed.everyMs, source: "command" });
				if (!entry) {
					ctx.ui.notify("scheduler unavailable", "error");
					return;
				}
				ctx.ui.setStatus("pi-notify", statusLine());
				ctx.ui.notify(`scheduled ${entry.id} for ${formatWhen(entry.dueAt)}${entry.everyMs > 0 ? ` every ${formatDuration(entry.everyMs)}` : ""} (${formatRelative(entry.dueAt, Date.now())})`, "info");
				return;
			}
			if (sub === "list") {
				const entries = reminders();
				if (entries.length === 0) {
					ctx.ui.notify("no scheduled notifications", "info");
					return;
				}
				ctx.ui.notify(entries.map((entry) => `${entry.id}  ${formatWhen(entry.dueAt)}${entry.everyMs ? ` every ${formatDuration(entry.everyMs)}` : ""}  ${entry.body}`).join("\n"), "info");
				return;
			}
			if (sub === "cancel") {
				const id = parts[1];
				if (!id) {
					ctx.ui.notify("usage: /notify cancel <id>", "warning");
					return;
				}
				ctx.ui.notify(scheduler?.cancel(id) ? `cancelled ${id}` : `no reminder with id ${id}`, "info");
				ctx.ui.setStatus("pi-notify", statusLine());
				return;
			}
			if (sub === "clear") {
				const removed = scheduler?.clear() ?? 0;
				ctx.ui.setStatus("pi-notify", statusLine());
				ctx.ui.notify(`cleared ${removed} scheduled notification(s)`, "info");
				return;
			}
			if (sub === "mute") {
				const raw = Number(parts[1] ?? 30);
				const minutes = Number.isFinite(raw) ? Math.min(24 * 60, Math.max(1, Math.floor(raw))) : 30;
				bus.setMute(Date.now() + minutes * 60 * 1000);
				ctx.ui.setStatus("pi-notify", statusLine());
				ctx.ui.notify(`automatic notifications muted for ${minutes} min; manual sends still work`, "info");
				return;
			}
			if (sub === "unmute") {
				bus.setMute(0);
				ctx.ui.setStatus("pi-notify", statusLine());
				ctx.ui.notify("automatic notifications unmuted", "info");
				return;
			}
			if (sub === "log") {
				const raw = Number(parts[1] ?? 15);
				const count = Number.isFinite(raw) ? Math.min(50, Math.max(1, Math.floor(raw))) : 15;
				const entries = readNotifyLog(config.logFile, count);
				if (entries.length === 0) {
					ctx.ui.notify(`no send history in ${config.logFile}`, "info");
					return;
				}
				ctx.ui.notify(
					entries.map((entry) => `${new Date(entry.ts).toLocaleString()}  ${entry.ok ? "sent" : entry.detail ?? "failed"}  ${entry.scope}/${entry.provider}  ${entry.title} ${entry.body}`.trim()).join("\n"),
					"info",
				);
				return;
			}
			if (sub === "decrypt") {
				const text = parts.slice(1).join(" ");
				if (!isNtfyEnvelope(text)) {
					ctx.ui.notify("not a pi-notify ntfy envelope (pi-notify:v1:...)", "warning");
					return;
				}
				const plain = decryptNtfyBody(text, config.ntfy.encryption.key ?? "");
				ctx.ui.notify(plain ?? "decryption failed: wrong key or damaged envelope", plain ? "info" : "error");
				return;
			}

			ctx.ui.notify(describeStatus(), "info");
		},
	});

	function reloadProblems(): typeof problems {
		const loaded = loadConfig({ cwd: latestCtx?.cwd ?? process.cwd(), agentDir: resolveAgentDir() });
		problems = loaded.problems;
		return problems;
	}

	function describeBarkKeys(): string {
		const keys = config.bark.keys;
		if (keys.length === 0) return "(none)";
		return keys.map((key) => `${key.slice(0, 3)}…${key.slice(-3)}`).join(", ");
	}

	function splitSchedule(rest: string): { dueAt: number; text: string; everyMs: number } | undefined {
		if (!rest) return undefined;
		const initial = rest.split(/\s+/);
		// Try the first token, then the first two tokens, as the time expression.
		for (let take = 1; take <= 2; take += 1) {
			if (initial.length <= take) break;
			const whenText = initial.slice(0, take).join(" ");
			const dueAt = parseWhen(whenText, Date.now());
			if (dueAt === undefined) continue;
			let parts = initial.slice(take);
			let everyMs = 0;
			if (parts.length >= 2 && parts[parts.length - 2] === "every") {
				const parsed = parseDuration(parts[parts.length - 1]);
				if (parsed !== undefined) {
					everyMs = parsed;
					parts = parts.slice(0, parts.length - 2);
				}
			}
			const text = parts.join(" ");
			if (text) return { dueAt, text, everyMs };
		}
		return undefined;
	}

	function describeStatus(): string {
		const lines: string[] = [];
		lines.push(`provider: ${config.provider}${config.provider === "bark" ? ` (${describeBarkKeys()}, ${config.bark.baseUrl})` : ` (${config.ntfy.server}/${config.ntfy.topic || "(no topic)"})`}`);
		lines.push(`notifications: ${config.enabled ? "on" : "off"} · automatic: ${config.auto.enabled ? "on" : "off"}`);
		lines.push(
			`scopes: ${SCOPES.map((scope) => `${scope}=${config.auto.scopes[scope] ? "on" : "off"}`).join(" ")}`,
		);
		const barkEnc = config.bark.encryption;
		const ntfyEnc = config.ntfy.encryption;
		lines.push(
			`encryption: ${config.provider === "bark" ? `${barkEnc.enabled ? `on (${barkEnc.algorithm})` : "off"}` : `${ntfyEnc.enabled ? "on (AES-256-GCM envelope)" : "off"}${config.ntfy.token || config.ntfy.user ? " · authenticated" : ""}`}`,
		);
		lines.push(`noise: minRun ${config.auto.minRunSeconds}s · goalMin ${config.auto.goalMinSeconds}s · tasknotify ${config.auto.suppressTaskNotify ? "on" : "off"} · throttle ${config.auto.throttleSeconds}s · body ${config.auto.maxBodyChars} chars`);
		lines.push(`mute: ${bus.mutedUntil > Date.now() ? `automatic sends muted until ${formatWhen(bus.mutedUntil)}` : "off"}`);
		lines.push(`reminders: ${reminders().length} pending · store ${config.scheduleFile} · history ${config.logEnabled ? config.logFile : "off"}`);
		if (problems.fatal.length > 0) lines.push(`needs setup: ${problems.fatal.join(" · ")}`);
		if (problems.warnings.length > 0) lines.push(`warnings: ${problems.warnings.join(" · ")}`);
		return lines.join("\n");
	}
}

function toolResult(text: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text }], details };
}
