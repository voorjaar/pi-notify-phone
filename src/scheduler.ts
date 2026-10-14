/**
 * Reminder scheduler. Pure logic with an injected clock, store, and delivery sink.
 *
 * Pending reminders live in a JSON file so they survive a Pi restart. Each entry records the
 * due time it was already delivered, which keeps two Pi sessions that share the store from
 * firing the same reminder twice.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock, ScheduleEntry } from "./types.ts";

export interface ScheduleStore {
	load(): ScheduleEntry[];
	save(entries: ScheduleEntry[]): void;
	lastError?: string;
}

export function fileStore(path: string): ScheduleStore {
	const store: ScheduleStore = {
		load() {
			if (!existsSync(path)) return [];
			try {
				const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
				if (!Array.isArray(parsed)) {
					store.lastError = `${path} must contain a JSON array`;
					return [];
				}
				return parsed.filter(isEntry).map(normalizeEntry);
			} catch (error) {
				store.lastError = `${path} is not readable: ${error instanceof Error ? error.message : String(error)}`;
				return [];
			}
		},
		save(entries) {
			try {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
				store.lastError = undefined;
			} catch (error) {
				store.lastError = `${path} is not writable: ${error instanceof Error ? error.message : String(error)}`;
			}
		},
	};
	return store;
}

export function memoryStore(initial: ScheduleEntry[] = []): ScheduleStore {
	// Copy on the way in and out so callers cannot mutate the store through a shared object,
	// which is what the file store guarantees by re-parsing JSON.
	let entries = initial.map((entry) => ({ ...entry }));
	return {
		load: () => entries.map((entry) => ({ ...entry })),
		save: (next) => {
			entries = next.map((entry) => ({ ...entry }));
		},
	};
}

function isEntry(value: unknown): value is ScheduleEntry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return typeof candidate.id === "string" && typeof candidate.body === "string" && Number.isFinite(Number(candidate.dueAt));
}

function normalizeEntry(entry: ScheduleEntry): ScheduleEntry {
	return {
		id: entry.id,
		body: entry.body,
		title: typeof entry.title === "string" ? entry.title : undefined,
		level: entry.level === "warning" || entry.level === "critical" ? entry.level : "info",
		dueAt: Number(entry.dueAt),
		everyMs: Number.isFinite(Number(entry.everyMs)) ? Math.max(0, Math.floor(Number(entry.everyMs))) : 0,
		createdAt: Number.isFinite(Number(entry.createdAt)) ? Number(entry.createdAt) : Number(entry.dueAt),
		deliveredDueAt: Number.isFinite(Number(entry.deliveredDueAt)) ? Number(entry.deliveredDueAt) : undefined,
		source: typeof entry.source === "string" ? entry.source : "unknown",
	};
}

let idCounter = 0;
export function makeId(prefix = "rem"): string {
	idCounter += 1;
	return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export interface SchedulerOptions {
	store: ScheduleStore;
	clock: Clock;
	deliver: (entry: ScheduleEntry, late: boolean) => Promise<void> | void;
	/** Reminders older than this when their timer fires are dropped instead of delivered. */
	maxLateMs?: number;
	/** Report expired or failed reminders. */
	onEvent?: (message: string, level: "info" | "warning" | "error") => void;
}

export class ReminderScheduler {
	private readonly store: ScheduleStore;
	private readonly clock: Clock;
	private readonly deliver: (entry: ScheduleEntry, late: boolean) => Promise<void> | void;
	private readonly maxLateMs: number;
	private readonly onEvent?: (message: string, level: "info" | "warning" | "error") => void;
	private readonly timers = new Map<string, ReturnType<Clock["setTimeout"]>>();
	private entries: ScheduleEntry[] = [];

	constructor(options: SchedulerOptions) {
		this.store = options.store;
		this.clock = options.clock;
		this.deliver = options.deliver;
		this.maxLateMs = options.maxLateMs ?? 6 * 3_600_000;
		this.onEvent = options.onEvent;
	}

	list(): ScheduleEntry[] {
		return [...this.entries].sort((a, b) => a.dueAt - b.dueAt);
	}

	/** Load the store and arm every pending reminder. Idempotent. */
	arm(): void {
		this.entries = this.store.load();
		for (const handle of this.timers.values()) this.clock.clearTimeout(handle);
		this.timers.clear();
		for (const entry of [...this.entries]) this.armEntry(entry);
	}

	add(draft: Omit<ScheduleEntry, "id" | "createdAt"> & { id?: string }): ScheduleEntry {
		const entry = normalizeEntry({
			id: draft.id ?? makeId(),
			body: draft.body,
			title: draft.title,
			level: draft.level,
			dueAt: draft.dueAt,
			everyMs: draft.everyMs,
			createdAt: this.clock.now(),
			source: draft.source,
		});
		this.entries = this.entries.filter((e) => e.id !== entry.id).concat(entry);
		this.persist();
		this.armEntry(entry);
		return entry;
	}

	cancel(id: string): boolean {
		const before = this.entries.length;
		const handle = this.timers.get(id);
		if (handle) {
			this.clock.clearTimeout(handle);
			this.timers.delete(id);
		}
		this.entries = this.entries.filter((e) => e.id !== id);
		this.persist();
		return this.entries.length < before;
	}

	clear(): number {
		const removed = this.entries.length;
		for (const handle of this.timers.values()) this.clock.clearTimeout(handle);
		this.timers.clear();
		this.entries = [];
		this.persist();
		return removed;
	}

	/** Clear timers without touching the store so a later session can re-arm. */
	dispose(): void {
		for (const handle of this.timers.values()) this.clock.clearTimeout(handle);
		this.timers.clear();
	}

	private armEntry(entry: ScheduleEntry): void {
		const handle = this.timers.get(entry.id);
		if (handle) this.clock.clearTimeout(handle);
		const late = this.clock.now() - entry.dueAt;
		if (late > this.maxLateMs) {
			this.entries = this.entries.filter((e) => e.id !== entry.id);
			this.persist();
			this.onEvent?.(`reminder "${entry.id}" expired ${Math.round(late / 60_000)}m late`, "warning");
			return;
		}
		this.timers.set(entry.id, this.clock.setTimeout(() => void this.fire(entry.id), Math.max(0, entry.dueAt - this.clock.now())));
	}

	private async fire(id: string): Promise<void> {
		this.timers.delete(id);
		const entry = this.entries.find((e) => e.id === id);
		if (!entry) return;

		// Re-read the store: another Pi session may have claimed or rescheduled this entry.
		const localDue = entry.dueAt;
		const fresh = this.store.load().find((e) => e.id === id);
		if (fresh && fresh.deliveredDueAt === localDue) {
			Object.assign(entry, fresh);
			if (entry.everyMs > 0) {
				this.persist();
				this.armEntry(entry);
			} else {
				this.entries = this.entries.filter((e) => e.id !== id);
				this.persist();
			}
			return;
		}
		if (fresh) Object.assign(entry, fresh);

		const dueAt = entry.dueAt;
		const now = this.clock.now();
		const late = now - dueAt;
		if (late > this.maxLateMs) {
			this.entries = this.entries.filter((e) => e.id !== id);
			this.persist();
			this.onEvent?.(`reminder "${entry.id}" expired ${Math.round(late / 60_000)}m late`, "warning");
			return;
		}

		// Claim the delivery before sending so a second session skips the same due time.
		entry.deliveredDueAt = dueAt;
		this.persist();

		try {
			await this.deliver(entry, late > 1000);
		} catch (error) {
			this.onEvent?.(`reminder "${entry.id}" failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}

		if (entry.everyMs > 0) {
			entry.dueAt = dueAt + entry.everyMs;
			while (entry.dueAt <= this.clock.now()) entry.dueAt += entry.everyMs;
			this.persist();
			this.armEntry(entry);
		} else {
			this.entries = this.entries.filter((e) => e.id !== id);
			this.persist();
		}
	}

	private persist(): void {
		this.store.save(this.entries);
		if (this.store.lastError) this.onEvent?.(this.store.lastError, "warning");
	}
}
