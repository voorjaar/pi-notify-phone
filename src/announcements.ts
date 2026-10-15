/** Bodies for run-lifecycle notifications, kept pure so they are testable without Pi. */

/** Longest prompt snippet a task_start notification may carry. */
const TASK_START_SNIPPET_CHARS = 200;

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
