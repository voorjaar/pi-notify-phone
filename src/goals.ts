/**
 * Goal activity is inferred, because the Pi extension API exposes no goal state:
 * no SessionEvent field and no ExtensionContext method reports the active goal.
 * These signals are the only reliable sources, so the state machine lives here where it can be tested.
 */

export type GoalSignal =
	/** A new session started; nothing is known about any goal yet. */
	| { type: "session_start" }
	/** The model called create_goal. */
	| { type: "goal_created" }
	/** The model called update_goal with this status. */
	| { type: "goal_status"; status: string }
	/** A message carried the harness goal-continuation marker. */
	| { type: "goal_continuation" };

/** Statuses that mean no goal is running any more. */
const INACTIVE_STATUSES = new Set(["complete", "blocked", "paused"]);

export function nextGoalActive(current: boolean, signal: GoalSignal): boolean {
	switch (signal.type) {
		case "session_start":
			return false;
		case "goal_created":
		case "goal_continuation":
			return true;
		case "goal_status":
			// An empty status means the tool call carried no recognizable status: keep what we know.
			if (signal.status === "") return current;
			return !INACTIVE_STATUSES.has(signal.status);
	}
}
