/**
 * Provider transports. Pure module: takes an injected fetch so tests need no network.
 */

import { encryptBarkPayload, encryptNtfyBody } from "./crypto.ts";
import type { FetchLike, NotifyConfig, NotifyRequest, SendResult } from "./types.ts";

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

/**
 * ntfy reads headers as bytes; non-ASCII titles must be RFC 2047 encoded so Chinese
 * titles survive the transport.
 */
export function encodeHeaderText(value: string): string {
	if ([...value].every((ch) => ch.charCodeAt(0) < 128)) return value;
	const encoded = Buffer.from(value, "utf8").toString("base64").replace(/\s+/g, "");
	return `=?UTF-8?B?${encoded}?=`;
}

function barkFormFields(req: NotifyRequest, config: NotifyConfig): Record<string, string> {
	const level = config.bark.level[req.level ?? "info"];
	const fields: Record<string, string> = {
		title: req.title ?? config.titlePrefix,
		body: req.body,
		group: req.group ?? config.bark.group,
		level,
	};
	const sound = req.sound ?? config.bark.sound;
	if (sound) fields.sound = sound;
	const icon = req.icon ?? config.bark.icon;
	if (icon) fields.icon = icon;
	if (req.url) fields.url = req.url;
	if (req.level === "critical" && config.bark.callOnCritical) fields.call = "1";
	if (config.bark.autoCopy) fields.autoCopy = "1";
	if (config.bark.ttlSeconds > 0) {
		fields.isArchive = "1";
		fields.ttl = String(config.bark.ttlSeconds);
	}
	return fields;
}

/** Build one Bark request per configured device key. */
export function buildBarkRequests(req: NotifyRequest, config: NotifyConfig): HttpRequest[] {
	const enc = config.bark.encryption;
	const fields = barkFormFields(req, config);

	for (const [key, value] of Object.entries(fields)) {
		if (typeof value === "string" && [...value].some((ch) => ch.charCodeAt(0) < 128 && ch.charCodeAt(0) < 32)) {
			fields[key] = value.replace(/[\u0000-\u001f]+/g, " ");
		}
	}

	return config.bark.keys.map((deviceKey) => {
		const url = `${config.bark.baseUrl}/${encodeURIComponent(deviceKey)}`;
		if (enc.enabled && enc.key) {
			const cipher = encryptBarkPayload(JSON.stringify(fields), enc.algorithm, enc.key, enc.iv);
			const form = new URLSearchParams({ ciphertext: cipher.ciphertext });
			if (cipher.iv) form.set("iv", cipher.iv);
			return {
				url,
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
				body: form.toString(),
			};
		}
		return {
			url,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
			body: new URLSearchParams(fields).toString(),
		};
	});
}

/** Build the single ntfy publish request. */
export function buildNtfyRequest(req: NotifyRequest, config: NotifyConfig): HttpRequest {
	const enc = config.ntfy.encryption;
	const headers: Record<string, string> = {
		"Content-Type": "text/plain; charset=utf-8",
		Title: encodeHeaderText(req.title ?? config.titlePrefix),
		Priority: String(config.ntfy.priority[req.level ?? "info"]),
	};
	const group = req.group ?? config.bark.group;
	const tags = [...config.ntfy.tags];
	if (group && !tags.includes(group)) tags.push(group);
	const tagValue = tags.filter(Boolean).join(",");
	if (tagValue) headers.Tags = encodeHeaderText(tagValue);
	const click = req.url ?? config.ntfy.click;
	if (click) headers.Click = click;
	const icon = req.icon ?? config.ntfy.icon;
	if (icon) headers.Icon = icon;
	if (config.ntfy.markdown) headers.Markdown = "yes";
	if (config.ntfy.token) {
		headers.Authorization = `Bearer ${config.ntfy.token}`;
	} else if (config.ntfy.user && config.ntfy.password) {
		headers.Authorization = `Basic ${Buffer.from(`${config.ntfy.user}:${config.ntfy.password}`, "utf8").toString("base64")}`;
	}

	let body = req.body;
	if (enc.enabled && enc.key) body = encryptNtfyBody(req.body, enc.key);

	const query = new URLSearchParams();
	if (req.sendAt) query.set("at", new Date(req.sendAt).toISOString());
	const suffix = query.toString() ? `?${query.toString()}` : "";
	const url = `${config.ntfy.server}/${config.ntfy.topic}${suffix}`;
	return { url, method: "POST", headers, body };
}

interface TransportOutcome {
	ok: boolean;
	status: number;
	body: string;
	error?: string;
}

async function perform(
	request: HttpRequest,
	timeoutMs: number,
	fetchImpl: FetchLike,
): Promise<TransportOutcome> {
	const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
	try {
		const response = await fetchImpl(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body,
			signal,
		});
		const text = await response.text().catch(() => "");
		return { ok: response.ok && response.status < 400, status: response.status, body: text.trim().slice(0, 400) };
	} catch (error) {
		return { ok: false, status: 0, body: "", error: error instanceof Error ? error.message : String(error) };
	}
}

function retryable(outcome: TransportOutcome): boolean {
	return outcome.status === 0 || outcome.status >= 500;
}

function sleep(ms: number): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Send one notification through the configured provider, with bounded retries. */
export async function sendNotification(
	req: NotifyRequest,
	config: NotifyConfig,
	fetchImpl: FetchLike,
): Promise<SendResult> {
	if (!config.enabled) {
		return { ok: false, provider: config.provider, detail: "notifications are disabled", attempts: 0, encrypted: false };
	}

	if (config.provider === "bark") {
		if (config.bark.keys.length === 0) {
			return { ok: false, provider: "bark", detail: "no bark device key configured", attempts: 0, encrypted: config.bark.encryption.enabled };
		}
		let requests: HttpRequest[];
		try {
			requests = buildBarkRequests(req, config);
		} catch (error) {
			return {
				ok: false,
				provider: "bark",
				detail: error instanceof Error ? error.message : String(error),
				attempts: 0,
				encrypted: config.bark.encryption.enabled,
			};
		}
		const details: string[] = [];
		let attempts = 0;
		let allOk = true;
		for (const request of requests) {
			const outcome = await sendWithRetry(request, config, fetchImpl, (n) => {
				attempts += n;
			});
			if (!outcome.ok) {
				allOk = false;
				details.push(outcome.error ?? `HTTP ${outcome.status} ${outcome.body}`);
			}
		}
		return {
			ok: allOk,
			provider: "bark",
			detail: allOk ? `sent to ${requests.length} device(s)` : details.join("; "),
			attempts,
			encrypted: config.bark.encryption.enabled && Boolean(config.bark.encryption.key),
		};
	}

	if (!config.ntfy.topic) {
		return { ok: false, provider: "ntfy", detail: "no ntfy topic configured", attempts: 0, encrypted: config.ntfy.encryption.enabled };
	}
	let request: HttpRequest;
	try {
		request = buildNtfyRequest(req, config);
	} catch (error) {
		return {
			ok: false,
			provider: "ntfy",
			detail: error instanceof Error ? error.message : String(error),
			attempts: 0,
			encrypted: config.ntfy.encryption.enabled,
		};
	}
	let attempts = 0;
	const outcome = await sendWithRetry(request, config, fetchImpl, (n) => {
		attempts += n;
	});
	return {
		ok: outcome.ok,
		provider: "ntfy",
		detail: outcome.ok ? outcome.body || "published" : outcome.error ?? `HTTP ${outcome.status} ${outcome.body}`,
		attempts,
		encrypted: config.ntfy.encryption.enabled && Boolean(config.ntfy.encryption.key),
	};
}

async function sendWithRetry(
	request: HttpRequest,
	config: NotifyConfig,
	fetchImpl: FetchLike,
	countAttempts: (n: number) => void,
): Promise<TransportOutcome> {
	let outcome: TransportOutcome = { ok: false, status: 0, body: "" };
	for (let attempt = 0; attempt <= config.retries; attempt += 1) {
		outcome = await perform(request, config.timeoutMs, fetchImpl);
		countAttempts(1);
		if (outcome.ok) return outcome;
		if (!retryable(outcome) || attempt === config.retries) return outcome;
		await sleep(config.retryDelayMs * (attempt + 1));
	}
	return outcome;
}
