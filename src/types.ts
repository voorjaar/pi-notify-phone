/**
 * Shared types for pi-notify. Pure module: no Pi imports.
 */

export type ProviderName = "bark" | "ntfy";

/** Semantic severity. Providers map it to their own urgency vocabulary. */
export type NotifyLevel = "info" | "warning" | "critical";

/** Every notification scenario pi-notify knows about. */
export type NotifyScope =
	| "task_complete"
	| "task_failed"
	| "question"
	| "goal"
	| "tool_error"
	| "ui_prompt"
	| "reminder"
	| "manual";

export interface NotifyRequest {
	/** Notification title. Defaults to the configured title prefix. */
	title?: string;
	/** Notification body. */
	body: string;
	/** Severity. Default "info". */
	level?: NotifyLevel;
	/** Provider grouping key. Defaults to the configured group. */
	group?: string;
	/** URL to open when the notification is tapped. */
	url?: string;
	/** Provider sound (Bark sound name). */
	sound?: string;
	/** Provider icon URL. */
	icon?: string;
	/** Scenario, used for auto-scope gating and rendering. */
	scope?: NotifyScope;
	/** Free-form metadata appended to the body (session name, duration, ...). */
	meta?: string[];
}

export interface SendResult {
	ok: boolean;
	provider: ProviderName;
	/** Human readable detail: provider response, error text, or skip reason. */
	detail?: string;
	/** Number of transport attempts made. */
	attempts: number;
	/** True when the payload was sent encrypted. */
	encrypted: boolean;
}

export type BarkAlgorithm =
	| "aes-128-cbc"
	| "aes-192-cbc"
	| "aes-256-cbc"
	| "aes-128-gcm"
	| "aes-192-gcm"
	| "aes-256-gcm";

export interface BarkConfig {
	/** Single device key. Convenience alias for `keys: [key]`. */
	key?: string;
	/** Multiple device keys. */
	keys: string[];
	baseUrl: string;
	group: string;
	sound?: string;
	icon?: string;
	/** Bark level string per severity: active | timeSensitive | passive | critical. */
	level: Record<NotifyLevel, string>;
	/** Repeat the sound for 30 seconds on critical notifications. */
	callOnCritical: boolean;
	/** Ask the app to copy the notification body to the clipboard. */
	autoCopy: boolean;
	/** Bark encrypted push (the whole payload JSON is encrypted). */
	encryption: {
		enabled: boolean;
		algorithm: BarkAlgorithm;
		/** Raw key text; length must match the algorithm (16/24/32 bytes). */
		key?: string;
		/** Raw IV text (CBC: 16 bytes). When omitted for CBC, a random IV is generated and sent as `iv`. */
		iv?: string;
	};
}

export interface NtfyConfig {
	/** Server base URL, e.g. https://ntfy.sh or http://192.168.1.10:8080 */
	server: string;
	topic?: string;
	/** Access token (Bearer auth) for authenticated topics. */
	token?: string;
	user?: string;
	password?: string;
	/** URL opened when the notification is tapped. */
	click?: string;
	icon?: string;
	/** Send the body as Markdown so ntfy renders it. */
	markdown: boolean;
	/** ntfy priority per severity (1=min .. 5=max). */
	priority: Record<NotifyLevel, number>;
	/** Tags attached to every message (ntfy tags/emoji short codes). */
	tags: string[];
	/** Client-side body encryption (AES-256-GCM envelope). */
	encryption: {
		enabled: boolean;
		/** Raw key text; SHA-256 of it is used as the AES-256 key. */
		key?: string;
	};
}

export interface AutoConfig {
	/** Master switch for automatic scenario notifications. */
	enabled: boolean;
	/** Per-scenario switches. */
	scopes: Record<NotifyScope, boolean>;
	/** Skip task_complete for runs shorter than this (the user is still watching). */
	minRunSeconds: number;
	/** Minimum gap between two automatic notifications from the same scenario. */
	throttleSeconds: number;
	/** Bodies longer than this are truncated for the transport. */
	maxBodyChars: number;
	/** Notify when a run was aborted with Escape. */
	notifyAborted: boolean;
}

export interface ScheduleEntry {
	/** Stable id used by list/cancel. */
	id: string;
	body: string;
	title?: string;
	level?: NotifyLevel;
	/** Absolute due time, epoch milliseconds. */
	dueAt: number;
	/** Recurrence interval in milliseconds (0 = one-shot). */
	everyMs: number;
	/** Created at, epoch milliseconds. */
	createdAt: number;
	/** Due time that was already delivered (idempotence across sessions). */
	deliveredDueAt?: number;
	/** Source label, e.g. "tool", "command", "config". */
	source: string;
}

export interface NotifyConfig {
	provider: ProviderName;
	/** Master switch: when false, nothing is sent. */
	enabled: boolean;
	/** Default notification title. */
	titlePrefix: string;
	/** Append the project directory name to every body. */
	includeSession: boolean;
	timeoutMs: number;
	retries: number;
	retryDelayMs: number;
	bark: BarkConfig;
	ntfy: NtfyConfig;
	auto: AutoConfig;
	/** Schedules declared in config; armed on session_start. */
	schedules: ScheduleEntry[];
	/** Where pending schedules are persisted. */
	scheduleFile: string;
	barkEncryptionDefaultAlgorithm: BarkAlgorithm;
}

export interface ConfigLayer {
	path: string;
	loaded: boolean;
	/** Set when the layer exists but could not be read or parsed. */
	error?: string;
}

export interface ConfigProblems {
	/** Problems that prevent sending. */
	fatal: string[];
	/** Worth reporting but not blocking. */
	warnings: string[];
}

export interface LoadedConfig {
	config: NotifyConfig;
	layers: ConfigLayer[];
	problems: ConfigProblems;
}

/** Opaque timer handle owned by the caller's Clock implementation. */
export interface TimerHandle {
	readonly id: string;
}

export interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
}

export type FetchLike = (
	url: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;
