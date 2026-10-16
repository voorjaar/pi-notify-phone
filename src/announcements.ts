/** Bodies for run-lifecycle notifications, kept pure so they are testable without Pi. */

/** Longest prompt snippet a task_start notification may carry. */
const TASK_START_SNIPPET_CHARS = 200;

/**
 * Flatten a message's content into plain text. Pi hands content through as a string or as a list of
 * blocks, so stringifying it directly would put a JSON list in the notification body.
 */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (typeof block === "string") return block;
				if (block && typeof block === "object") {
					const text = (block as { text?: unknown }).text;
					if (typeof text === "string") return text;
				}
				return "";
			})
			.filter((part) => part.length > 0)
			.join("\n");
	}
	return "";
}

/**
 * Turn the text of the message that started a run into a notification body.
 * Harness markers (a goal continuation, for example) say nothing the user did not already know,
 * so they collapse to a plain label.
 */
export function taskStartBody(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed === "" || collapsed.includes("pi_goal_continuation")) return "A run started.";
	return collapsed.length > TASK_START_SNIPPET_CHARS ? `${collapsed.slice(0, TASK_START_SNIPPET_CHARS)}...` : collapsed;
}

/**
 * The footer status: a clock and the number of pending reminders, or nothing at all. Provider, switch
 * state, and mute state belong to `/notify status`, not to a one-line footer.
 */
export function reminderStatusText(pending: number): string | undefined {
	if (pending <= 0) return undefined;
	return `⏱ ${pending}`;
}
