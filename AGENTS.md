# pi-notify-phone

A Pi coding-agent extension that pushes phone notifications (Bark or ntfy) when a Pi run finishes,
fails, asks a question, hits an error, fires a scheduled reminder, or moves a goal.

## Layout

- `src/index.ts` — the Pi extension entry point. `package.json` declares it as `pi.extensions:
  ["./src/index.ts"]`; Pi loads `src/*.ts` directly, so there is no build step.
- `src/config.ts` — layered config resolution, defaults, clamping, and problem reporting.
- `src/bus.ts` — the notification bus: switches, throttling, dedupe, run-end decision
  (`decideRunEnd`), send history.
- `src/goals.ts` — the goal-activity state machine (`nextGoalActive`). Pure and testable on purpose.
- `src/providers.ts` / `src/crypto.ts` — Bark and ntfy transports plus their encryption paths.
- `src/scheduler.ts` — persistent reminders, including cross-session delivery claims.
- `src/time.ts` — duration and due-time parsing (`in 20m`, `15:30`, `tomorrow 09:00`).
- `skills/notify/SKILL.md` — teaches the model when to call the `notify` tool.
- `tests/selftest.ts` — unit suite. `tests/livecheck.mjs` — live lifecycle check.
- `.memory/` — local project memory. Gitignored; never commit it and never reference it in published docs.

## Rules that matter

1. **Never await a network send inside an event handler.** `tool_call` and `tool_result` handlers run
   on the agent's critical path; block them and every tool call gets slower. Fire and forget:
   `void bus.send(...).then(report)`.
2. **Pi's extension API has no goal state.** No `SessionEvent` field and no `ExtensionContext` method
   reports the active goal. Goal activity is inferred from `create_goal`, `update_goal` statuses, and
   the `pi_goal_continuation` marker that the harness injects as a user message on continuation turns.
   Keep that logic in `src/goals.ts` and test it there.
3. **A goal completed in the same run clears the flag before `agent_settled`**, so `task_complete`
   still fires. That is intended behaviour, not a bug.
4. **Config merging is generic.** `mergeConfig` + `mergeNested` merge arbitrary patches, so a new knob
   needs a field in `NotifyConfig` (`src/types.ts`), a default in `defaultConfig`, and clamping in
   `normalizeConfig` only if it is numeric or enumerated. No new merge code.
5. **`loadConfig` never throws.** Bad input produces `findProblems()` output: `fatal` (provider
   unusable, e.g. no Bark key) and `warnings`. The extension must stay loadable.
6. **Published docs never mention the LAN Gitea mirror.** READMEs, `package.json`, and
   `config.example.json` describe the product, not this machine's private infrastructure.
7. **Read `dist/core/extensions/types.d.ts` in the installed Pi release** before writing an event
   handler. The docs prose is not precise enough about event shapes and handler signatures.

## Testing

Both layers are required before a feature is done.

```bash
node --test tests/selftest.ts   # fast, fake transport, no network, no real notification
node tests/livecheck.mjs        # real Pi sessions through the full goal lifecycle
```

`tests/livecheck.mjs` runs three scenarios (goal completed in one run, goal left open with the gate
off, goal left open with the gate on), reads the delivered notifications back from
`~/.pi/agent/pi-notify-log.jsonl`, and prints a timeline with a PASS/FAIL per scenario. It pushes
actual notifications to the configured device, so run it when the user expects a phone to buzz.

Live-test traps:

- If pi-notify-phone is installed (`~/.pi/agent/settings.json` packages), do **not** also pass
  `-e ./src/index.ts`: two copies register the same tool names and Pi aborts the load with
  `Tool "notify_status" conflicts with ...`. Use the installed copy, or `-ne -e ./src/index.ts`.
- `-ne` disables built-in extensions, which removes `create_goal` from the model's tool list — a goal
  test with `-ne` proves nothing.
- Personal config on a developer machine may set `auto.minRunSeconds` (this repo's host uses 120),
  which silently swallows `task_complete`. Override with `PI_NOTIFY_MIN_RUN_SECONDS=0`.
- Do not fake a goal by prefixing a `-p` prompt with `<pi_goal_continuation .../>`: the run collapses
  to a telemetry-only JSON stream with no messages, tools, or settlement.

## Publishing

`npm publish` is the maintainer's action, not the agent's. Prepare the release (commit, push, tag) and
show the command; do not run it.

```bash
npm publish            # package name: pi-notify-phone (pi-notify is taken by another project)
```

Both git remotes are kept in sync after every commit:

```bash
git push origin main && git push github main
```

After a history rewrite, Pi's installed checkout under `~/.pi/agent/git/<host>/<owner>/<repo>` must be
reset to the new tip (`git fetch && git reset --hard origin/main`) or sessions keep running stale code.

## Style

TypeScript with tabs, double quotes, semicolons, explicit types on exported functions. Keep the pure
decision logic separated from Pi event plumbing so it stays unit-testable. No Chinese in code or
English docs; Chinese lives in `README.zh-CN.md` only.
