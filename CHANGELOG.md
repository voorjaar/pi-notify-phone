# Changelog

## 0.3.0

* Split the `goal` scenario into `goal_start`, `goal_complete`, `goal_blocked`, and `goal_paused`, so the
  notification that a goal began can be switched off on its own. `goal_start` is off by default; the other
  three are on. `goal` still works as a group name in `/notify scope goal off` and in
  `PI_NOTIFY_AUTO_SCOPES`.
* Added the background-task scenarios: `bg_start` (a task launched with `bg_run`, off by default),
  `bg_complete`, and `bg_failed`. A background task settles by injecting a notification message rather than
  an event, so its id, name, status, and error are read out of that message.
* `ui_prompt` now defaults to off: a blocking dialog is something you can already see on screen. Turn it
  back on with `/notify scope ui_prompt on`.
* Fixed `PI_NOTIFY_AUTO_SCOPES` silently ignoring the documented `name:off` spelling; only bare names and
  the `no` prefix used to parse, so `question:off,goal:off` dropped the whole override.

## 0.2.0

* Added the `task_start` scenario: a notification when a run begins, carrying the prompt that started
  it. Off by default; enable it with `/notify scope task_start on` or
  `PI_NOTIFY_AUTO_SCOPES=task_start:on`.
* Fixed a question producing two notifications. One blocking `ask_user_question` arrives both as a tool
  call and as a UI dialog event, so the phone rang twice; the `question` notification now covers the
  dialog and the generic `ui_prompt` one is dropped.
* Fixed `Goal started` never firing for a goal the user starts with a slash command (`/goal-direct`,
  `/sisyphus-direct`, or the `/goal` drafting path). Those goals never emit a `create_goal` tool call, so
  goal notifications now follow the transition into an active goal instead of one named event.
* Fixed `Task started` bodies showing a JSON list when the starting message arrived as content blocks
  instead of plain text. Message content is flattened to text.

## 0.1.2

* Added the goal state to `/notify status`, so you can see whether a goal is currently running in the
  session.
* Moved the extension entry module to `src/index.ts`. Manual loading now reads
  `pi -e /path/to/pi-notify-phone/src/index.ts`; package installs are unaffected.

## 0.1.1

* Added `auto.suppressTaskNotify`: while a goal is running, run-end notifications
  (`task_complete`, `task_failed`, aborted runs) are skipped, so a goal that spans many runs does not
  buzz for each of them. Env `PI_NOTIFY_SUPPRESS_TASK_NOTIFY`, or `/notify tasknotify on|off`.
* Added the goal gate to `task_complete`: a run that ends while a goal is active is not reported as a
  finished task.
* Published on npm as `pi-notify-phone` (`pi install npm:pi-notify-phone`); `pi-notify` is taken by an
  unrelated package.

## 0.1.0

* Initial release: Bark and ntfy providers, manual sends through the `notify` tool, and automatic
  notifications for a finished or failed run, a question waiting for the user, goal events, tool errors,
  blocking input dialogs, and scheduled reminders.
* Added recurring and one-off reminders with a persistent schedule, cross-session delivery claims, and
  `/notify schedule` management.
* Added layered configuration (`~/.pi/agent/pi-notify.json`, `.pi/pi-notify.json`,
  `.pi/pi-notify.local.json`, `PI_NOTIFY_*` environment variables), the `/notify` setup wizard, and a
  delivery log in `~/.pi/agent/pi-notify-log.jsonl`.
* Added `auto.minRunSeconds` and `auto.goalMinSeconds`: only runs or goals that last at least this long
  are announced. Both default to `0`.
* Added ntfy payload encryption (AES-128-CBC envelopes) and Bark encryption settings.
