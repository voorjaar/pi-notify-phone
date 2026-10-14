#!/usr/bin/env node
/**
 * Manual send / setup check outside a Pi session.
 *
 *   node scripts/send.ts "title" "body" [info|warning|critical]
 */

import { loadConfig } from "../src/config.ts";
import { sendNotification } from "../src/providers.ts";
import type { FetchLike, NotifyLevel } from "../src/types.ts";

const fetchImpl: FetchLike = async (url, init) => {
	const response = await fetch(url, init);
	return { status: response.status, ok: response.ok, text: () => response.text() };
};

const [title, body, levelArg] = process.argv.slice(2);
const level = (levelArg === "warning" || levelArg === "critical" ? levelArg : "info") as NotifyLevel;
const loaded = loadConfig({ cwd: process.cwd() });

if (loaded.problems.fatal.length > 0) {
	console.error(`setup needed: ${loaded.problems.fatal.join(" · ")}`);
	console.error(`layers: ${loaded.layers.map((layer) => `${layer.path}${layer.loaded ? " (loaded)" : ""}`).join(", ")}`);
	process.exit(1);
}

const result = await sendNotification({ title, body: body ?? "pi-notify smoke test", level }, loaded.config, fetchImpl);
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
