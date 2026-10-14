/**
 * Notification bus: composes the final payload, applies the switches (master, automatic,
 * per-scenario), throttles repeats, and hands the request to the provider transport.
 * Pure logic with an injected transport so the rules are testable without a network.
 */

import type { NotifyConfig, NotifyLevel, NotifyRequest, NotifyScope, SendResult } from "./types.ts";

export interface BusOptions {
	transport: (req: NotifyRequest) => Promise<SendResult>;
	/** Name of the current project/session, appended to bodies when configured. */
	sessionName?: () => string;
	onEvent?: (message: string, level: "info" | "warning" | "error") => void;
	now?: () => number;
}

/** Scenarios the user never triggers by hand. */
const AUTOMATIC_SCOPES: NotifyScope[] = ["task_complete", "task_failed", "question", "goal", "tool_error", "ui_prompt", "reminder"];

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

export class NotifyBus {
	private config: NotifyConfig;
	private readonly transport: (req: NotifyRequest) => Promise<SendResult>;
	private readonly sessionName?: () => string;
	private readonly onEvent?: (message: string, level: "info" | "warning" | "error") => void;
	private readonly now: () => number;
	private readonly lastSentAt = new Map<NotifyScope, number>();
	private readonly lastBody = new Map<NotifyScope, string>();

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

	getConfig(): NotifyConfig {
		return this.config;
	}

	/** Decide whether a scenario may send right now, without sending. */
	gate(scope: NotifyScope): GateDecision {
		const config = this.config;
		if (!config.enabled) return { allow: false, reason: "notifications are off" };
		if (AUTOMATIC_SCOPES.includes(scope)) {
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
		const request = composeRequest(input, config, this.sessionName?.());
		const decision = this.gate(input.scope);
		if (!decision.allow) {
			return {
				ok: false,
				provider: config.provider,
				detail: `skipped: ${decision.reason}`,
				attempts: 0,
				encrypted: false,
			};
		}
		const previous = this.lastBody.get(input.scope);
		if (previous === request.body) {
			return {
				ok: false,
				provider: config.provider,
				detail: "skipped: duplicate of the previous notification",
				attempts: 0,
				encrypted: false,
			};
		}

		const result = await this.transport(request);
		this.lastSentAt.set(input.scope, this.now());
		this.lastBody.set(input.scope, request.body);
		if (!result.ok) this.onEvent?.(`notify failed: ${result.detail ?? "unknown error"}`, "warning");
		return result;
	}

	/** Level used by scenario renderers. */
	levelFor(scope: NotifyScope): NotifyLevel {
		if (scope === "task_failed" || scope === "tool_error") return "warning";
		if (scope === "question") return "warning";
		return "info";
	}
}
