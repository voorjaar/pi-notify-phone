/**
 * Encryption helpers. Pure module: node crypto only, no Pi imports.
 *
 * Bark: the whole payload JSON is encrypted and sent as the `ciphertext` parameter
 * (https://github.com/Finb/Bark/blob/master/docs/encryption.md).
 *   - CBC: key and IV are raw bytes; the IV is sent as the `iv` parameter.
 *   - GCM: the 12-byte nonce is prepended to the ciphertext, then the 16-byte auth tag
 *     is appended, and the whole thing is base64'd. No separate `iv` parameter.
 *
 * ntfy: ntfy itself has no native end-to-end encryption (upstream issue #69), so pi-notify
 * defines its own envelope: `pi-notify:v1:<base64(iv | tag | ciphertext)>` using AES-256-GCM
 * with SHA-256(key). Titles stay in the clear so the notification is still recognizable.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { CipherGCMTypes } from "node:crypto";
import { keyBytesRequired } from "./config.ts";
import type { BarkAlgorithm } from "./types.ts";

const GCM_ALGORITHMS: Record<number, CipherGCMTypes> = {
	128: "aes-128-gcm",
	192: "aes-192-gcm",
	256: "aes-256-gcm",
};

const GCM_OPTIONS = { authTagLength: 16 };

export const NTFY_ENVELOPE_PREFIX = "pi-notify:v1:";

const IV_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Random IV made of printable characters so it can travel as a form field. */
function randomAsciiBytes(length: number): Buffer {
	const bytes = randomBytes(length);
	const out = Buffer.alloc(length);
	for (let i = 0; i < length; i += 1) out[i] = IV_ALPHABET.charCodeAt(bytes[i] % IV_ALPHABET.length);
	return out;
}

function algorithmBits(algorithm: BarkAlgorithm): number {
	if (algorithm.includes("128")) return 128;
	if (algorithm.includes("192")) return 192;
	return 256;
}

function requireKey(key: string, algorithm: BarkAlgorithm): Buffer {
	const keyBuf = Buffer.from(key, "utf8");
	const required = keyBytesRequired(algorithm);
	if (keyBuf.length !== required) {
		throw new Error(`bark encryption key must be ${required} bytes for ${algorithm}, got ${keyBuf.length}`);
	}
	return keyBuf;
}

export interface BarkCipher {
	/** base64 ciphertext to send as the `ciphertext` parameter. */
	ciphertext: string;
	/** Raw IV text to send as the `iv` parameter (CBC only). */
	iv?: string;
}

/** Encrypt a Bark payload JSON string. */
export function encryptBarkPayload(
	json: string,
	algorithm: BarkAlgorithm,
	key: string,
	providedIv?: string,
): BarkCipher {
	const keyBuf = requireKey(key, algorithm);
	const bits = algorithmBits(algorithm);

	if (algorithm.includes("gcm")) {
		let nonce: Buffer;
		if (providedIv) {
			nonce = Buffer.from(providedIv, "utf8");
			if (nonce.length !== 12) throw new Error(`bark iv must be 12 bytes for ${algorithm}, got ${nonce.length}`);
		} else {
			nonce = randomAsciiBytes(12);
		}
		const cipher = createCipheriv(GCM_ALGORITHMS[bits], keyBuf, nonce, GCM_OPTIONS);
		const body = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
		const tag = cipher.getAuthTag();
		return { ciphertext: Buffer.concat([nonce, body, tag]).toString("base64") };
	}

	let iv: Buffer;
	if (providedIv) {
		iv = Buffer.from(providedIv, "utf8");
		if (iv.length !== 16) throw new Error(`bark iv must be 16 bytes for ${algorithm}, got ${iv.length}`);
	} else {
		iv = randomAsciiBytes(16);
	}
	const cipher = createCipheriv(`aes-${bits}-cbc`, keyBuf, iv);
	const body = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
	return { ciphertext: body.toString("base64"), iv: iv.toString("utf8") };
}

/** Decrypt a Bark ciphertext. Used by tests and by `/notify decrypt`. */
export function decryptBarkPayload(
	ciphertextBase64: string,
	algorithm: BarkAlgorithm,
	key: string,
	providedIv?: string,
): string {
	const keyBuf = requireKey(key, algorithm);
	const bits = algorithmBits(algorithm);
	const raw = Buffer.from(ciphertextBase64, "base64");

	if (algorithm.includes("gcm")) {
		const nonce = raw.subarray(0, 12);
		const tag = raw.subarray(raw.length - 16);
		const body = raw.subarray(12, raw.length - 16);
		const decipher = createDecipheriv(GCM_ALGORITHMS[bits], keyBuf, nonce, GCM_OPTIONS);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
	}

	if (!providedIv) throw new Error("bark CBC decryption needs the iv parameter");
	const iv = Buffer.from(providedIv, "utf8");
	if (iv.length !== 16) throw new Error(`bark iv must be 16 bytes for ${algorithm}, got ${iv.length}`);
	const decipher = createDecipheriv(`aes-${bits}-cbc`, keyBuf, iv);
	return Buffer.concat([decipher.update(raw), decipher.final()]).toString("utf8");
}

function ntfyKey(key: string): Buffer {
	if (key === "") throw new Error("ntfy encryption key is empty");
	return createHash("sha256").update(key, "utf8").digest();
}

/** Wrap a message body in the pi-notify encrypted envelope. */
export function encryptNtfyBody(body: string, key: string): string {
	const iv = randomAsciiBytes(12);
	const cipher = createCipheriv(GCM_ALGORITHMS[256], ntfyKey(key), iv, GCM_OPTIONS);
	const cipherText = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${NTFY_ENVELOPE_PREFIX}${Buffer.concat([iv, tag, cipherText]).toString("base64")}`;
}

/**
 * Unwrap a pi-notify envelope. Returns undefined when the text is not our envelope
 * or the key does not authenticate it.
 */
export function decryptNtfyBody(text: string, key: string): string | undefined {
	if (!text.startsWith(NTFY_ENVELOPE_PREFIX)) return undefined;
	const payload = text.slice(NTFY_ENVELOPE_PREFIX.length).trim();
	if (payload.length === 0) return undefined;
	let raw: Buffer;
	try {
		raw = Buffer.from(payload, "base64");
	} catch {
		return undefined;
	}
	if (raw.length < 12 + 16) return undefined;
	const iv = raw.subarray(0, 12);
	const tag = raw.subarray(12, 28);
	const body = raw.subarray(28);
	try {
		const decipher = createDecipheriv(GCM_ALGORITHMS[256], ntfyKey(key), iv, GCM_OPTIONS);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
	} catch {
		return undefined;
	}
}

/** True when a message body carries the pi-notify envelope. */
export function isNtfyEnvelope(text: string): boolean {
	return text.startsWith(NTFY_ENVELOPE_PREFIX);
}
