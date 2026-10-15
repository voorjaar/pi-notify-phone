---
name: notify
description: Send the user a phone notification (Bark or ntfy) from Pi - task results, questions, reminders, and scheduled/recurring notifications.
---

# pi-notify-phone

The `notify` tool is how you reach the user's phone. When the user asks to be told something or
reminded of something, **call `notify` right away**. Do not search the vault, do not look for cron
or a calendar, do not shell out to `sleep`, `at`, or `launchctl`, and do not ask which transport is
configured - the tool handles all of it.

## Phrase to call

| The user says | Call |
| --- | --- |
| "remind me to stretch in 20 minutes" | `notify { body: "Stretch", in: "20m" }` |
| "every morning at 9 tell me good morning" | `notify { body: "Good morning", at: "09:00", every: "1d" }` |
| "每天早上九点跟我说早上好" | `notify { body: "早上好", at: "09:00", every: "1d" }` |
| "ping me at 2026-01-02 09:00 about the audit" | `notify { body: "Audit due", at: "2026-01-02T09:00" }` |
| "remind me every 2 hours to drink water" | `notify { body: "Drink water", in: "2h", every: "2h" }` |
| "notify me when the build finishes" | nothing to schedule - `task_complete` already fires when the run ends |
| "text me if the tests fail" | nothing to schedule - `task_failed` already fires on an error |
| "send me a message saying X right now" | `notify { body: "X" }` |

A daily or weekly reminder is `at` (the clock time) **plus** `every` (the interval). One of them
alone is not enough: `at: "09:00"` without `every` fires once, today or tomorrow.

## Parameters

| Field | Meaning |
| --- | --- |
| `body` | The notification text. One or two lines, in the language the user used. |
| `title` | Optional title; defaults to the configured title (usually `Pi`). |
| `level` | `info` (default), `warning`, or `critical`. `critical` breaks Do Not Disturb. |
| `in` | Relative delay: `10m`, `1h30m`, `2d`. |
| `at` | Clock time: `09:00`, `15:30`, `tomorrow 09:00`, `2026-01-02T09:00`. |
| `every` | Repeat interval: `30m`, `2h`, `1d`. Omit it for a one-shot reminder. |
| `url` | Opens when the notification is tapped. |
| `group` | Provider grouping key (Bark group / ntfy tag). |
| `sound` | Provider sound (Bark sound name). |

Rules that matter:

- `in` takes a **duration**, `at` takes a **time of day or date-time**. Never swap them.
- `at: "09:00"` already means "the next 09:00"; you do not need to work out today's date.
- No `in` and no `at` means send immediately.
- Keep the user's own wording in `body`; the notification is what they will read on their phone.

## After scheduling

Say what you scheduled, in one line, including the id and when it fires, e.g.
"scheduled `r-7f3a` for 09:00 tomorrow, every day". Use `notify_reminders` with
`action: "list" | "cancel" | "clear"` (and `id`) to inspect or remove them. The user can do the
same with `/notify list`, `/notify cancel <id>`, `/notify clear`.

## When something looks wrong

Call `notify_status` before promising a notification if the user reports that nothing arrived. It
reports the provider, the switches, pending reminders, and the last send attempts. If it reports a
setup problem, tell the user what to add to `~/.pi/agent/pi-notify.json` instead of retrying.

Automatic notifications the user can toggle themselves: `/notify on|off`, `/notify auto on|off`,
`/notify scope <name> on|off`, `/notify mute 30`.

## Mistakes to avoid

- Searching for an existing reminder system instead of calling `notify`.
- Scheduling with `in: "09:00"` (invalid) or `at: "20m"` (invalid).
- Setting `at` but forgetting `every` when the user asked for "every day".
- Sending a notification for every step of your work; one per event the user asked about.
- Re-sending the same event twice (a duplicate is suppressed, but the second call is wasted).
