---
name: notify
description: Send the user a phone notification (Bark or ntfy) from Pi - task results, questions, reminders, and scheduled/recurring notifications.
---

# pi-notify

Use the `notify` tool when the user asks to be told something on their phone, or asks to be
reminded of something at a time they name.

## When to call `notify`

- The user says things like "remind me to X in 20 minutes", "notify me when the build finishes",
  "text me if the tests fail", "ping me at 09:00 every day".
- A long-running piece of work finished or failed and the user asked to be notified about it.
- The user asks you to check on something later.

Do not call it for ordinary progress, for answers that are already in the terminal, or more than
once for the same event.

## Parameters

| Field | Meaning |
| --- | --- |
| `body` | The notification text. Keep it one or two lines. |
| `title` | Optional title. Defaults to the configured title (usually `Pi`). |
| `level` | `info` (default), `warning`, or `critical`. `critical` breaks Do Not Disturb. |
| `in` | Relative time: `10m`, `1h30m`, `2d`. |
| `at` | Absolute time: `08:30`, `tomorrow 09:00`, `2026-01-02T09:00`. |
| `every` | Repeat interval: `30m`, `1d`. Omit for a one-shot reminder. |
| `url` | Opens when the notification is tapped. |
| `group` | Provider grouping key (Bark group / ntfy tag). |

`in`/`at` schedule the notification; without them it is sent immediately.

## Managing scheduled notifications

`notify_reminders` with `action: "list" | "cancel" | "clear"` (and `id` for cancel).
The user can do the same with `/notify list`, `/notify cancel <id>`, `/notify clear`.

Before you promise the user a notification, call `notify_status`. It reports the provider, the
switches, pending reminders, and the last send attempts - so you can say whether notifications are
actually enabled instead of assuming they are. If it reports a setup problem, tell the user what to
add to `pi-notify.json` rather than retrying.

## Setup the user may need

Configuration lives in `~/.pi/agent/pi-notify.json` (personal) and `.pi/pi-notify.json`
(per project). A provider must be configured or nothing is sent:

- bark: `bark.key` (or `bark.keys`)
- ntfy: `ntfy.topic`, optionally `ntfy.token`

`/notify status` shows what is configured and which scenario switches are on.
`/notify test` sends one notification so the user can confirm delivery on their device.
