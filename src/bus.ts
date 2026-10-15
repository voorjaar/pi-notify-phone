/**
 * Notification bus: composes the final payload, applies the switches (master, automatic,
 * per-scenario), throttles repeats, and hands the request to the provider transport.
 * Pure logic with an injected transport so the rules are testable without a network.
 */

import { readFileSync, writeFileSync } from "node:fs";

import type { AutoConfig, NotifyConfig, NotifyLevel, NotifyLogEntry, NotifyRequest, NotifyScope, SendResult } from "./types.ts";

export interface BusOptions {
	transport: (req: NotifyRequest) => Promise<SendResult>;
	/** Name of the current project/session, appended to bodies when configured. */
	sessionName?: () => string;
	onEvent?: (message: string, level: "info" | "warning" | "error") => void;
	now?: () => number;
}

/** Scenarios the user never triggers by hand. */
const AUTOMATIC_SCOPES: NotifyScope[] = ["task_start", "task_complete", "task_failed", "question", "goal", "tool_error", "ui_prompt", "reminder"];

const LOG_CAP = 200;

function tailLines(file: string, count: number): string[] {
	try {
		const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0);
		return lines.slice(Math.max(0, lines.length - count));
	} catch {
		return [];
	}
}

/** Most recent send attempts, oldest first. */
export function readNotifyLog(file: string, count = 15): NotifyLogEntry[] {
	return tailLines(file, count)
		.map((line) => {
			try {
				return JSON.parse(line) as NotifyLogEntry;
			} catch {
				return undefined;
			}
		})
		.filter((entry): entry is NotifyLogEntry => entry !== undefined);
}

export interface ComposedRequest extends NotifyRequest {
	scope: NotifyScope;
}

export function composeRequest(input: ComposedRequest, config: NotifyConfig, sessionName?: string): NotifyRequest {
	const lines = [input.body.trim()];
	for (const meta of input.meta ?? []) {
		const text = meta.trim();
		if (text) lines.push(text);
	}
	if (sessionName) lines.push(`session: ${sessionName}`);

	let body = lines.filter(Boolean).join("\n");
	const limit = config.auto.maxBodyChars;
	if (body.length > limit) body = `${body.slice(0, Math.max(0, limit - 1))}…`;

	return {
		title: input.title && input.title.trim() !== "" ? input.title.trim() : config.titlePrefix,
		body,
		level: input.level ?? "info",
		group: input.group ?? config.bark.group,
		url: input.url,
		sound: input.sound,
		icon: input.icon,
		sendAt: input.sendAt,
		scope: input.scope,
	};
}

export interface GateDecision {
	allow: boolean;
	reason?: string;
}

export interface RunEndFacts {
	/** A goal is running in this session. */
	goalActive: boolean;
	/** The run was aborted with Escape. */
	aborted: boolean;
	/** The assistant run ended with an error. */
	failed: boolean;
	/** Seconds between agent_start and settling. */
	seconds: number;
}

/**
 * Decide what a settled run notifies: nothing, a failure, or a completion.
 * While a goal runs, auto.suppressTaskNotify silences all run-end notifications
 * (aborted, failed, and complete) because goal events already report progress.
 */
export function decideRunEnd(facts: RunEndFacts, auto: AutoConfig): { scope: "task_complete" | "task_failed"; reason: string } | undefined {
	if (facts.goalActive && auto.suppressTaskNotify) return undefined;
	if (facts.aborted) return auto.notifyAborted ? { scope: "task_failed", reason: "run aborted" } : undefined;
	if (facts.failed) return { scope: "task_failed", reason: "run ended with an error" };
	if (facts.seconds < auto.minRunSeconds) return undefined;
	return { scope: "task_complete", reason: `finished after ${facts.seconds}s` };
}

/**
 * One blocking `ask_user_question` reaches the extension twice: the `tool_call` (notified as
 * `question`) and `ui_prompt_start` for the same dialog. `question` is the specific signal, so it wins
 * and the generic `ui_prompt` is dropped. The mark is consumed by the first dialog it covers, so a
 * question cannot silence an unrelated dialog that opens moments later.
 */
export class QuestionUiDedupe {
	static readonly windowMs = 5000;
	private questionAt = 0;

	noteQuestion(now: number): void {
		this.questionAt = now;
	}

	/** True when this `ui_prompt_start` is the dialog a `question` notification already covered. */
	shouldSkipUiPrompt(now: number): boolean {
		if (this.questionAt === 0) return false;
		const questionAt = this.questionAt;
		this.questionAt = 0;
		return now - questionAt <= QuestionUiDedupe.windowMs;
	}
}

export class NotifyBus {
	private config: NotifyConfig;
	private readonly transport: (req: NotifyRequest) => Promise<SendResult>;
	private readonly sessionName?: () => string;
	private readonly onEvent?: (message: string, level: "info" | "warning" | "error") => void;
	private readonly now: () => number;
	private readonly lastSentAt = new Map<NotifyScope, number>();
	private readonly lastBody = new Map<NotifyScope, string>();
	/** Until this timestamp automatic scenarios stay silent; manual sends still work. */
	private muteUntilMs = 0;

	constructor(config: NotifyConfig, options: BusOptions) {
		this.config = config;
		this.transport = options.transport;
		this.sessionName = options.sessionName;
		this.onEvent = options.onEvent;
		this.now = options.now ?? (() => Date.now());
	}

	setConfig(config: NotifyConfig): void {
		this.config = config;
	}

	/** Silence automatic scenarios until the given timestamp (0 to unmute). */
	setMute(untilMs: number): void {
		this.muteUntilMs = untilMs;
	}

	get mutedUntil(): number {
		return this.muteUntilMs;
	}

	getConfig(): NotifyConfig {
		return this.config;
	}

	/** Decide whether a scenario may send right now, without sending. */
	gate(scope: NotifyScope): GateDecision {
		const config = this.config;
		if (!config.enabled) return { allow: false, reason: "notifications are off" };
		if (AUTOMATIC_SCOPES.includes(scope)) {
			if (this.muteUntilMs > this.now()) return { allow: false, reason: "muted" };
			if (!config.auto.enabled) return { allow: false, reason: "automatic notifications are off" };
			if (!config.auto.scopes[scope]) return { allow: false, reason: `scope ${scope} is off` };
		} else if (!config.auto.scopes.manual) {
			return { allow: false, reason: "manual notifications are off" };
		}

		if (AUTOMATIC_SCOPES.includes(scope)) {
			const last = this.lastSentAt.get(scope);
			if (last !== undefined && this.now() - last < config.auto.throttleSeconds * 1000) {
				return { allow: false, reason: `throttled (${scope})` };
			}
		}
		return { allow: true };
	}

	async send(input: ComposedRequest): Promise<SendResult> {
		const config = this.config;
		const request = composeRequest(input, config, config.includeSession ? this.sessionName?.() : undefined);
		const decision = this.gate(input.scope);
		if (!decision.allow) {
			return this.logSend(undefined, input.scope, {
				ok: false,
				provider: config.provider,
				detail: `skipped: ${decision.reason}`,
				attempts: 0,
				encrypted: false,
			});
		}
		const previous = this.lastBody.get(input.scope);
		if (previous === request.body) {
			return this.logSend(request, input.scope, {
				ok: false,
				provider: config.provider,
				detail: "skipped: duplicate of the previous notification",
				attempts: 0,
				encrypted: false,
			});
		}

		const result = await this.transport(request);
		this.lastSentAt.set(input.scope, this.now());
		this.lastBody.set(input.scope, request.body);
		if (!result.ok) this.onEvent?.(`notify failed: ${result.detail ?? "unknown error"}`, "warning");
		return this.logSend(request, input.scope, result);
	}

	/** Keep a short history so "why did I not get it" is answerable. */
	private logSend(request: NotifyRequest | undefined, scope: NotifyScope, result: SendResult): SendResult {
		if (!this.config.logEnabled) return result;
		const entry: NotifyLogEntry = {
			ts: this.now(),
			scope,
			provider: result.provider,
			title: request?.title ?? "",
			body: (request?.body ?? "").slice(0, 200),
			ok: result.ok,
			detail: result.detail,
			attempts: result.attempts,
			encrypted: result.encrypted,
		};
		try {
			const kept = tailLines(this.config.logFile, LOG_CAP - 1);
			writeFileSync(this.config.logFile, `${kept.concat(JSON.stringify(entry)).join("\n")}\n`);
		} catch {
			// A log that cannot be written must not break the notification.
		}
		return result;
	}

	/** Level used by scenario renderers. */
	levelFor(scope: NotifyScope): NotifyLevel {
		if (scope === "task_failed" || scope === "tool_error") return "warning";
		if (scope === "question") return "warning";
		return "info";
	}
}
