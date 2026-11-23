# How it works

## Classification

For each prompt `hroute` picks a **tier** (`plan`, `impl`, `quick`, or your own names):

1. `--tier` if given.
2. The first matching `[[rules]]` regex.
3. Otherwise, an LLM, if allowed: Jev when `OPENROUTER_API_KEY` is set, else a headless Haiku call (`claude -p`, about 2 s on your subscription). It is asked for one tier name and the answer is matched against your tiers.
4. Otherwise `default_tier`.

`hroute explain "<prompt>"` shows which step decided.

## Choosing a target

A tier is an ordered **chain** of targets. The planner walks it and marks each target usable or skipped:

- **Parked**: its account hit a limit (or you ran `hroute mark`) and the park time has not passed.
- **Over threshold**: the account's known 5h usage is at/over `max_used` (default 90%).

The first usable target wins. If every target in the chain is unusable, the planner continues into `fallback_tier`, so you land on a simpler model instead of failing. `strategy = "least-used"` reorders usable targets by lowest known usage, if you want to balance accounts instead of draining the first one.

## Where the 5h percentage comes from

| Kind | Source |
|---|---|
| `codex` | The newest session log in `$CODEX_HOME/sessions` records `rate_limits.primary.used_percent` and its reset time. Read on demand, nothing to set up. |
| `claude` | Claude Code passes `rate_limits.five_hour.used_percentage` to the statusline command. `hroute usage-sink <account>` stores it per account. |
| others | Unknown. They are only skipped after a limit message. |

A window whose reset time has passed counts as 0%. The Claude figure is only as fresh as the last statusline refresh of that account, and unknown usage counts as available.

## `hroute run`

1. Plan candidates (above).
2. Split a Herdr pane (focus stays put) with the target's environment, `herdr agent start`, then `herdr agent prompt`.
3. For `probe_seconds`, read the agent's terminal. If a limit message appears (lines echoing your own prompt are ignored), park the **whole account** until the parsed reset time (`resets 3pm`, `in 2 hours 10 minutes`) or `default_cooldown`, close the pane and move to the next target.
4. Otherwise leave the agent working and return. `--wait` blocks until it settles.

Exit code `2` means every target was parked or failed.

## `hsub`

A headless one-shot with the same planning: `claude -p`, `codex exec` or `agy -p` on the first usable target, stdin closed, answer on stdout and routing notes on stderr. A limit message in a failed or very short answer parks the account and tries the next target. Long successful answers that merely mention "rate limit" are not treated as errors.

## Claude Code hooks

`hroute install-hook` adds three hooks:

- **`UserPromptSubmit` → `hroute hook`.** Classifies the prompt and may add a short hint for Claude: delegate to the `hr-<tier>` subagent, or run `hsub <tier>` when Claude is not the best fit right now (for example its 5h window is nearly spent). Silent when there is no real signal or Claude is already the right place. With `[hook] debug = true` it also shows a one-line summary per prompt.
- **`SessionStart` → `hroute sync-agents`.** Regenerates the `hr-*` subagents so each one's `model:` is the first Claude target usable right now.
- **`Stop` → `hroute handoff update --hook`.** Records where the conversation transcript lives. No LLM call.

A hook is a **hint**. Claude decides whether to follow it, and a hook cannot change the model of the running session. Subagents run under the session's own login, so they can follow usage but cannot switch accounts; `hsub` and `hroute run` can.

## Handoff note

Routed agents start with no memory. `hroute` keeps one small note per working directory:

```
## Goal       one sentence
## Done       what is finished
## Next       what remains
## Decisions  choices and why
```

- **Written** by Haiku, which *rewrites* the note from the previous note and the tail of the Claude transcript, capped at `max_chars`, so it never grows.
- **When** (default `on-switch`): only when `hroute run` / `hsub` is about to start a target on a different account than the origin session and the note is older than the transcript. Repeated and same-account handovers reuse the note at no cost. `every-turn` mode rewrites in a detached background process after each reply instead.
- **Read**: prepended to the prompt together with live git facts (branch, changed files, diff stat) that need no LLM. Notes older than `max_age` are ignored; `--no-handoff` skips it.
- **Limits**: it is a summary and can be wrong, so the receiving agent is told to verify against the repo. If the origin account is exhausted and Haiku cannot run, the last note plus live git facts is used.

## Source layout

| File | Role |
|---|---|
| `src/config.ts`, `types.ts` | Parsing and validation |
| `src/classify.ts` | Rules, Jev, Haiku |
| `src/plan.ts` | Candidate ordering, thresholds, fallback tiers |
| `src/usage.ts`, `limits.ts`, `state.ts` | Usage sources, limit detection, parking |
| `src/run.ts`, `herdr.ts` | Pane launch and probing through the `herdr` CLI |
| `src/sub.ts` | Headless runs |
| `src/hook.ts`, `agents.ts` | Hook logic and subagent generation |
| `src/handoff.ts` | Handoff note |
| `src/help.ts`, `cli.ts` | CLI |
