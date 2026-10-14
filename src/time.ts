/**
 * Time parsing and formatting for reminders. Pure module: no Pi imports.
 */

const UNIT_MS: Record<string, number> = {
	s: 1000,
	sec: 1000,
	secs: 1000,
	second: 1000,
	seconds: 1000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	hrs: 3_600_000,
	hr: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
	w: 604_800_000,
	week: 604_800_000,
	weeks: 604_800_000,
};

/**
 * Parse a duration such as `10m`, `1h30m`, `2 days`, `90s`, `45 seconds`.
 * Returns milliseconds, or undefined when the text is not a duration.
 */
export function parseDuration(input: string): number | undefined {
	const text = input.trim().toLowerCase().replace(/,/g, "");
	if (!text) return undefined;
	const stripped = text.replace(/^(in|for|every)\s+/, "");
	// Unit alternatives are ordered longest-first so "2 hours" matches "hours" and not "h".
	const token =
		/(\d+(?:\.\d+)?)\s*(seconds|second|secs|sec|s|minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d|weeks|week|w)/g;
	let total = 0;
	let matched = 0;
	let gaps = "";
	let cursor = 0;
	let match: RegExpExecArray | null;
	token.lastIndex = 0;
	while ((match = token.exec(stripped)) !== null) {
		const value = Number(match[1]);
		const unit = UNIT_MS[match[2]];
		if (!Number.isFinite(value) || !unit) return undefined;
		total += value * unit;
		matched += 1;
		gaps += stripped.slice(cursor, match.index);
		cursor = match.index + match[0].length;
	}
	gaps += stripped.slice(cursor);
	if (matched === 0) return undefined;
	if (gaps.trim() !== "") return undefined;
	return total;
}

function localTimeToday(epochMs: number, hour: number, minute: number): number {
	const d = new Date(epochMs);
	d.setHours(hour, minute, 0, 0);
	return d.getTime();
}

/**
 * Parse a when-expression into an absolute epoch time.
 * Supported: `10m` / `in 10m`, `at 08:30`, `08:30`, `2026-01-02T08:30`,
 * `2026-01-02 08:30`, `tomorrow 08:30`, `tomorrow`.
 * Returns undefined when the text is not a time expression.
 */
export function parseWhen(input: string, now: number): number | undefined {
	const raw = input.trim();
	if (!raw) return undefined;
	const text = raw.toLowerCase();

	const duration = parseDuration(text);
	if (duration !== undefined) return now + duration;

	const clock = /^(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
	if (clock) {
		const hour = Number(clock[1]);
		const minute = Number(clock[2]);
		const second = clock[3] ? Number(clock[3]) : 0;
		if (hour > 23 || minute > 59 || second > 59) return undefined;
		const today = localTimeToday(now, hour, minute) + second * 1000;
		// A clock time that already passed today means tomorrow.
		return today > now ? today : today + 86_400_000;
	}

	const tomorrowClock = /^tomorrow(?:\s+at\s+|\s+)?(?:(\d{1,2}):(\d{2}))?$/.exec(text);
	if (tomorrowClock) {
		const base = localTimeToday(now + 86_400_000, tomorrowClock[1] ? Number(tomorrowClock[1]) : 9, tomorrowClock[2] ? Number(tomorrowClock[2]) : 0);
		return base;
	}

	const iso = text.replace(/^at\s+/, "");
	const stamped = Date.parse(iso);
	if (Number.isFinite(stamped)) return stamped;

	return undefined;
}

/** Format a duration in milliseconds as a short human string. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const units: Array<[string, number]> = [
		["d", 86_400_000],
		["h", 3_600_000],
		["m", 60_000],
		["s", 1000],
	];
	let rest = Math.round(ms);
	const parts: string[] = [];
	for (const [label, size] of units) {
		if (rest >= size) {
			parts.push(`${Math.floor(rest / size)}${label}`);
			rest -= Math.floor(rest / size) * size;
		}
		if (parts.length === 3) break;
	}
	return parts.join("") || "0s";
}

/** Format an epoch time as `YYYY-MM-DD HH:MM`, local time. */
export function formatWhen(epochMs: number): string {
	const d = new Date(epochMs);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Relative description such as `in 12m` or `3m late`. */
export function formatRelative(epochMs: number, now: number): string {
	const delta = epochMs - now;
	if (delta >= 0) return `in ${formatDuration(delta)}`;
	return `${formatDuration(-delta)} late`;
}
