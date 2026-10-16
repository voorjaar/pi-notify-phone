# pi-notify-phone

**English** | [简体中文](README.zh-CN.md)

Send notifications from the Pi coding agent to your phone - task finished, task failed,
a question waiting for you, goal events, and reminders you ask the agent to set.
Two transports are supported: [Bark](https://bark.day.app/#/en-us/?id=bark) and
[ntfy](https://docs.ntfy.sh/config/).

```text
Pi finishes a long task  ->  pi-notify-phone  ->  https://api.day.app/...  ->  your phone buzzes
```

## Features

- **Two providers**: Bark (iOS) and ntfy (iOS, Android, desktop, web). Choose one in config or
  with `/notify provider bark|ntfy`.
- **Optional encryption**: Bark AES-128-CBC or AES-256-GCM request bodies (the official
  `crypto.ts` scheme), and self-hosted ntfy AES-256-GCM envelopes that the agent can decrypt
  back to plain text.
- **Automatic or manual**: one master switch, one automatic switch, and a switch per scenario.
  The agent can always send on request as long as the `manual` scope is on.
- **Scenarios**: task start / complete / failed / aborted, `ask_user_question` waiting for an answer,
  goal start / complete / blocked / paused, background task start / complete / failed, blocking UI
  prompts, tool errors, reminders. Every scenario has its own switch, and the table below lists the
  defaults.
- **Reminders and scheduled notifications**: relative (`in 20m`), absolute (`at 08:30`,
  `tomorrow 09:00`), and recurring (`every 1d`), persisted so a restart still delivers them.
- **Noise control**: minimum run duration, per-scope throttling, duplicate suppression,
  body length caps, TTL so stale notifications are dropped, and a switch that silences task
  notifications while a goal is running.

## Install

```bash
pi install npm:pi-notify-phone
```

Or straight from the repository:

```bash
pi install git:github.com/voorjaar/pi-notify-phone
```

Or point Pi at a local checkout:

```bash
pi -e /path/to/pi-notify-phone/src/index.ts
```

Install it once. The npm package and the git source are the same extension; loading both makes Pi
reject the duplicate tool names.

## Setup

Create `~/.pi/agent/pi-notify.json` with at least the provider you want to use:

```json
{
  "provider": "bark",
  "bark": { "key": "your-bark-device-key" }
}
```

Copy [`config.example.json`](config.example.json) for the full set of options. Then check it:

```text
/notify status
/notify test
```

You can also verify delivery without a Pi session:

```bash
node scripts/send.ts "pi-notify-phone" "hello" info
```

## Configuration

Config is merged layer by layer, later layers win:

1. built-in defaults
2. `~/.pi/agent/pi-notify.json`
3. `<project>/.pi/pi-notify.json`
4. `<project>/.pi/pi-notify.local.json` (personal overrides; `.pi/` is gitignored)
5. `PI_NOTIFY_*` environment variables

Invalid values are ignored and reported by `/notify status` instead of breaking the session.

| Key | Default | Meaning |
| --- | --- | --- |
| `provider` | `bark` | `bark` or `ntfy` |
| `enabled` | `true` | Master switch. Off sends nothing, including manual sends. |
| `titlePrefix` | `Pi` | Prefix for notification titles; `null` disables it. |
| `includeSession` | `true` | Append `session: <project name>` to every body. |
| `statusColor` | `accent` | Color of the footer status (a clock and the pending reminder count, shown only when something is scheduled). Any Pi theme token: `accent`, `success`, `warning`, `error`, `muted`, `mdCode`, `mdLink`. |
| `timeoutMs` | `8000` | Per-attempt HTTP timeout. |
| `retries` | `2` | Retries for 5xx and network errors (not for 4xx). |
| `bark.key` / `bark.keys` | - | Device key(s) from the Bark app. Multiple keys send to multiple devices. |
| `bark.baseUrl` | `https://api.day.app` | Self-hosted Bark server. |
| `bark.group` | `pi` | Bark group. |
| `bark.sound` | `glass` | Bark sound. |
| `bark.icon` | unset | Notification icon URL. Unset keeps Bark's own icon. [`assets/pi-icon.png`](assets/pi-icon.png) is a square pi mark you can host anywhere and point this key at. |
| `bark.level` | `active` / `timeSensitive` / `critical` | Maps our levels to Bark interruption levels. |
| `bark.callOnCritical` | `true` | `call=1` on critical so it can break Do Not Disturb. |
| `bark.ttlSeconds` | `600` | `ttl`: drop the notification if the device is offline this long. |
| `bark.encryption.enabled` | `false` | Encrypt the request body. |
| `bark.encryption.algorithm` | `aes-128-cbc` | `aes-128-cbc` or `aes-256-gcm`. |
| `bark.encryption.key` | - | 16 chars for AES-128, 32 for AES-256. |
| `bark.encryption.iv` | - | Required for AES-128-CBC (16 chars). AES-256-GCM uses a random IV. |
| `ntfy.server` | `https://ntfy.sh` | Server URL; public topics do not need a token. |
| `ntfy.topic` | - | Publish topic. For public ntfy.sh pick something hard to guess. |
| `ntfy.token` | - | `k...` access token for private topics. |
| `ntfy.user` / `ntfy.password` | - | HTTP basic auth, for self-hosted servers. |
| `ntfy.priority` | `3` / `4` / `5` | Maps our levels to ntfy priorities (1-5, 5 = max priority). |
| `ntfy.encryption.enabled` | `false` | Send AES-256-GCM envelopes (self-hosted ntfy with `cache-enc-key`). |
| `ntfy.encryption.key` | - | Any passphrase; derived with PBKDF2-SHA256, or 32 raw key bytes as hex. |
| `auto.enabled` | `true` | Automatic scenario notifications. |
| `auto.scopes` | see below | Per-scenario switches. |
| `auto.minRunSeconds` | `0` | Minimum length of a run before a task-complete notification is sent. `0` sends for every finished run; `180` sends only for runs of three minutes or more. |
| `auto.goalMinSeconds` | `0` | Same gate for goal-complete notifications, measured from the moment the goal started. |
| `auto.suppressTaskNotify` | `false` | While a goal is running, skip run-end notifications (task complete, task failed, aborted). Goal events still fire. |
| `auto.throttleSeconds` | `15` | Minimum gap between notifications per scope. |
| `auto.maxBodyChars` | `900` | Bodies longer than this are truncated. |
| `auto.notifyAborted` | `false` | Notify when a run is aborted. |
| `scheduleFile` | `~/.pi/agent/pi-notify-schedule.json` | Where reminders are stored. |
| `maxLateMs` | `21600000` | A reminder whose due time is more than this late is dropped instead of delivered. |
| `logFile` | `~/.pi/agent/pi-notify-log.jsonl` | One JSON line per send attempt, including skips. Read it with `/notify log`. |
| `logEnabled` | `true` | Turn the send history off. |
| `schedules` | `[]` | Predefined scheduled notifications, e.g. a daily standup ping. |

Scenario scopes (`auto.scopes`): one switch each. A scenario that only echoes something that just
*began*, or something you can already see on screen, starts off; everything that reports a *result*
starts on.

| Scope | Default | Fires when |
| --- | --- | --- |
| `task_start` | **off** | A run starts (its first message) |
| `task_complete` | on | A run finishes, after `auto.minRunSeconds` |
| `task_failed` | on | A run ends with an API/model error |
| `question` | on | `ask_user_question` is waiting for your answer |
| `goal_start` | **off** | A goal starts (a `create_goal` call, or a goal continuation turn) |
| `goal_complete` | on | A goal completes, after `auto.goalMinSeconds` |
| `goal_blocked` | on | A goal is set blocked |
| `goal_paused` | on | A goal is set paused |
| `bg_start` | **off** | A background task is launched (`bg_run`) |
| `bg_complete` | on | A background task completes |
| `bg_failed` | on | A background task fails, is killed, or times out |
| `tool_error` | **off** | A tool call returns an error |
| `ui_prompt` | **off** | An extension opens a blocking input dialog |
| `reminder` | on | A scheduled reminder is due |
| `manual` | on | You or the agent asked for a send explicitly |

`goal` and `bg` are group names that cover a whole family at once, so a pre-split setting still
works: `"goal": false` in the env list or `/notify scope goal off` switches all four goal scenarios.
In `PI_NOTIFY_AUTO_SCOPES`, both `noquestion` and `question:off` are accepted, and an unknown name
drops the whole override rather than applying half of it.

One blocking `ask_user_question` arrives as both `question` and `ui_prompt_start`. The `question`
notification covers the dialog, so no separate `ui_prompt` push follows it.

Environment overrides (they win over the files): `PI_NOTIFY_PROVIDER`, `PI_NOTIFY_ENABLED`,
`PI_NOTIFY_TITLE`, `PI_NOTIFY_STATUS_COLOR`, `PI_NOTIFY_AUTO_ENABLED`, `PI_NOTIFY_AUTO_SCOPES=question:off,goal:off`,
`PI_NOTIFY_MIN_RUN_SECONDS`, `PI_NOTIFY_GOAL_MIN_SECONDS`, `PI_NOTIFY_SUPPRESS_TASK_NOTIFY`, `PI_NOTIFY_THROTTLE_SECONDS`, `PI_NOTIFY_BARK_KEY`
(comma-separated for several devices), `PI_NOTIFY_BARK_BASE_URL`, `PI_NOTIFY_BARK_GROUP`,
`PI_NOTIFY_BARK_SOUND`, `PI_NOTIFY_BARK_ICON`, `PI_NOTIFY_BARK_ENCRYPT`,
`PI_NOTIFY_BARK_ENCRYPT_KEY`, `PI_NOTIFY_BARK_ENCRYPT_IV`, `PI_NOTIFY_BARK_ENCRYPT_ALGORITHM`,
`PI_NOTIFY_NTFY_SERVER`, `PI_NOTIFY_NTFY_TOPIC`, `PI_NOTIFY_NTFY_TOKEN`, `PI_NOTIFY_NTFY_USER`,
`PI_NOTIFY_NTFY_PASSWORD`, `PI_NOTIFY_NTFY_ENCRYPT`, `PI_NOTIFY_NTFY_ENCRYPT_KEY`.

## Use it from the agent

Ask in plain language:

- "remind me to stretch in 20 minutes"
- "notify me when the build finishes"
- "ping me every day at 09:30 that the backup ran"

The agent uses the `notify` tool (`in`, `at`, `every`, `level`, `url`, `group`, `sound`) and
`notify_reminders` to list, cancel, or clear scheduled notifications. `notify_status` tells the
agent how notifications are configured - provider, switches, pending reminders, and the last sends -
so it can tell you whether a notification is actually on its way.

## Commands

```text
/notify                        status summary
/notify on | off               master switch (this session)
/notify auto on | off          automatic scenario notifications
/notify scope <name> on|off    one scenario, or a group (`goal`, `bg`)
/notify tasknotify on|off        suppress task notifications while a goal is running
/notify provider bark|ntfy     transport (this session)
/notify test                   send one notification to check delivery
/notify send <text>            send now
/notify schedule <when> <text> [every <dur>]  e.g. /notify schedule 09:30 standup every 1d
/notify list                   scheduled notifications
/notify cancel <id>            cancel one
/notify clear                  cancel all
/notify mute [minutes]         pause automatic notifications (default 30)
/notify unmute                 resume them
/notify log [n]                last n send attempts (sent, skipped, failed)
/notify decrypt <text>         decrypt a pi-notify ntfy envelope
```

Overrides from `/notify` apply to the current session; edit the config file to make them permanent.

## Encryption

**Bark.** The extension sends the same envelope the official Bark app produces:
`?c=1&zone=...` plus a base64 body, where the payload is `key:body` (or
`title:body:sound:link:group:icon:call:level`) encrypted with AES-128-CBC or AES-256-GCM.
The ciphertext is padded to a multiple of 16 bytes, as Bark requires. Set the same key (and IV
for AES-128-CBC) in the Bark app under *Encryption*.

**ntfy.** Public ntfy.sh topics are plain HTTPS - anything published there is readable by
whoever knows the topic. For real confidentiality use a self-hosted ntfy with
`cache-enc-key` and set `ntfy.encryption.enabled = true`: the extension publishes a
`pi-notify:v1:<iv>:<tag>:<ciphertext>` envelope (AES-256-GCM, key derived from your passphrase
with PBKDF2-SHA256) that only a client holding the passphrase can read. `/notify decrypt` and
the agent can turn such an envelope back into readable text.

## Development

```bash
node --test tests/selftest.ts
```

The self-test covers time parsing, config layering, both transports, both encryption paths,
reminder scheduling, and the notification switches. It uses a fake transport, so it never sends
real notifications.

## Limitations

- Notifications only fire while a Pi session is running; there is no daemon. A reminder due while
  Pi is closed is delivered the next time a session starts (or dropped, if it is more than
  `maxLateMs` late).
- ntfy server-side scheduling (`Send At`) is used for one-shot reminders when encryption is off;
  recurring reminders are scheduled by the extension itself.
- The extension does not read your phone, so it cannot tell you whether a notification was
  actually delivered.

## Changelog

Release notes for every version are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT. See [LICENSE](LICENSE).

Source, issues, and releases: [github.com/voorjaar/pi-notify-phone](https://github.com/voorjaar/pi-notify-phone).
