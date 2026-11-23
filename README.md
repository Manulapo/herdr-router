# herdr-router

Opinionated, dependency-free model routing for [Herdr](https://herdr.dev).

You say what kind of task it is (or let rules / Jev guess). `hroute` opens a pane,
starts the best available agent for that tier, sends the prompt, and **falls back
automatically when a subscription limit (e.g. Claude's 5-hour window) is hit**.

```
hroute run "design the auth architecture"      # plan  -> claude:opus, else codex, else sonnet
hroute run "add pagination to /users"          # impl  -> claude:sonnet, else codex, else haiku
hroute run -t quick "rename foo to bar"        # explicit tier
```

## What it can do

- **Several subscriptions.** Define accounts (two Claude logins, two Codex logins) and chain them.
- **Switch at a usage threshold.** A target is skipped once its 5h window is e.g. 90% used, using the *real* percentage (see [Usage sources](#usage-sources)), and the chain falls through to the next account or model.
- **Step down to something simpler.** `fallback_tier = "quick"` means: when nothing in `plan` is usable, take the `impl`/`quick` chain instead.
- **Task-aware, per message.** Regex rules, then Jev or Haiku, pick the tier for each prompt.
- **Three ways in.** `hroute run` (a new Herdr pane), `hsub` (headless one-shot, usable as a fake subagent, works across accounts and Codex), and generated Claude Code subagents.

## Why this design

- **Rules, not an LLM, decide by default.** Free, instant, predictable. An optional [Jev](https://openrouter.ai/docs/guides/routing/routers/jev-router) classifier (OpenRouter) handles only the prompts no rule matched.
- **Limits are read, not guessed.** The 5h percentage comes from what the agents already expose (Codex logs, Claude's statusline data). If an agent still prints a limit message, the account is *parked* until the parsed reset time and the next one in the chain takes over.
- **Subscriptions stay in use.** Agents run through their own CLIs and logins inside Herdr panes, not through a pay-per-token API.
- **No daemon, no plugin framework.** A CLI over `herdr pane` / `herdr agent`.

## Requirements

- [Herdr](https://herdr.dev) 0.9+, with `hroute run` executed inside a Herdr pane
- [Bun](https://bun.sh) 1.2+
- The agent CLIs you route to (`claude`, `codex`, ...), already logged in

## Install

```sh
git clone https://github.com/<you>/herdr-router && cd herdr-router
bun install
bun link            # puts `hroute` on your PATH
hroute init         # writes ~/.config/herdr-router/routing.toml
hroute doctor
```

## Configure

See [`routing.example.toml`](routing.example.toml). The essentials:

```toml
[tiers.plan]
chain = ["claude:opus", "codex:gpt-5.5:high", "claude:sonnet"]

[[rules]]
tier = "plan"
match = ["\\b(architect|design|rfc)\\b"]
```

- A target is `kind[:model[:effort]]`, where `kind` is a Herdr agent kind. Claude gets `--model`, Codex gets `-m` plus `-c model_reasoning_effort=...`. Use a table with `args = [...]` for anything else.
- **Replace the model names with ones valid for your accounts.** The example values are placeholders.
- `limit_patterns` overrides the built-in limit-message regexes.

### Optional: Jev classification

```toml
[classifier]
mode = "jev"
```

```sh
export OPENROUTER_API_KEY=...
```

Rules run first; Jev is asked only when none match, with a 10 s timeout, and any failure falls back to `default_tier`. This uses the Responses API with `typesafe/jev-router` and `cost_tier = "low"` and costs OpenRouter credit for the (tiny) classification call.

## Per-message routing (the hook)

`hroute install-hook` adds two Claude Code hooks (preview first; `--write` merges them and keeps a `.bak`):

- `UserPromptSubmit` -> `hroute hook`: classifies every prompt and injects a one-line hint, e.g. *"this is `quick`: delegate to the `hr-quick` subagent"*, or *"Claude is over its 5h threshold: run `hsub impl "<task>"`"* (so work flows to Codex or Antigravity when Claude is nearly out). Nothing is injected when Claude is already the right place (the default tier on Claude).
- `SessionStart` -> `hroute sync-agents`: keeps the `hr-*` subagents' models in step with live usage.

Classification order: **regex rules** (instant, free) -> **Jev** if `OPENROUTER_API_KEY` is set, otherwise **Haiku** (`claude -p`, about 2 s, your subscription) -> `default_tier`. Haiku is skipped while the Claude account is parked or over threshold. Prompts shorter than `hook.min_chars`, and slash commands, skip the LLM; `[hook] mode = "rules"` makes the hook fully instant and free.

This is a *hint*, not a switch: Claude decides whether to follow it. A hook cannot change the running session's model. Internal `claude -p` calls set `HROUTE_INNER=1` so the hook never recurses.

## Usage sources

| Kind | Where the 5h percentage comes from |
|---|---|
| `codex` | Read from the newest session log in `$CODEX_HOME/sessions` (`rate_limits.primary.used_percent`). Nothing to set up. |
| `claude` | Claude Code hands `rate_limits.five_hour.used_percentage` to the statusline. Add one line to your statusline command so it is recorded per account: |

```sh
# inside your statusLine command, after `input=$(cat)`:
echo "$input" | hroute usage-sink claude-work >/dev/null 2>&1 &
```

Use the account name from your config (`claude` for the implicit default account). Each Claude account has its own `CLAUDE_CONFIG_DIR` and its own `settings.json`, so add the line with the matching name in each. Usage is only fresh while a session of that account is open; an unknown usage is treated as "available". A window whose reset time has passed counts as 0%.

## Subagents and `hsub`

Claude Code subagents (route by task, inside a session):

```sh
hroute sync-agents          # writes ~/.claude/agents/hr-plan.md, hr-impl.md, hr-quick.md
```

Each file's `model:` is the first Claude target usable *right now*, so re-run it when usage shifts (a `SessionStart` hook works well). Files you wrote yourself are never overwritten; generated ones carry a marker. Subagents always run under the session's own login, so their model can follow usage but not switch accounts.

`hsub` (cross-account, cross-agent):

```sh
hsub quick "find where parseConfig is defined"
```

Add to your `CLAUDE.md` so Claude uses it:

```md
For lookups or mechanical edits run: hsub quick "<task>"
For a second opinion or review run:  hsub plan "<task>"
```

`hsub` runs `claude -p` or `codex exec` on the first usable target, falls through on limit messages, parks exhausted accounts, and prints the answer on stdout (routing notes go to stderr). `hsub` supports `claude`, `codex` and `agy` (Antigravity). Other kinds work with `hroute run` only.

## Commands

| Command | What it does |
|---|---|
| `hroute run [-t tier] [--wait] [--direction right\|down] <prompt>` | Classify, launch, fall back |
| `hroute explain <prompt>` | Show tier and chain without launching |
| `hroute sub <tier> <task>` (or `hsub`) | Headless one-shot on the first usable target |
| `hroute sync-agents [--dir d]` | Generate Claude Code subagents `hr-<tier>` |
| `hroute hook` / `hroute install-hook [--write]` | Per-message routing hook and its installer |
| `hroute status` | Accounts with live 5h usage, parked accounts, tiers |
| `hroute usage-sink <account>` | Record statusline usage (reads JSON on stdin) |
| `hroute mark <account\|target> [--for 5h]` | Park an account by hand |
| `hroute reset [account\|target]` | Un-park one or all |
| `hroute init` / `hroute doctor` | Setup and diagnostics |

## How fallback works

1. Skip targets whose account is parked in `~/.local/state/herdr-router/state.json` or whose 5h usage is at/over `max_used`. After the tier is exhausted, continue into `fallback_tier`.
2. Split a pane (focus stays where it is), `herdr agent start`, send the prompt.
3. Watch the agent for `probe_seconds`. If a limit message shows up (the echo of your own prompt is ignored), park the whole account until the parsed reset time (`resets 3pm`, `in 2 hours 10 minutes`) or `default_cooldown`, close the pane, try the next target.
4. Otherwise leave the agent working in its pane and return. `--wait` blocks until it settles.

Exit code `2` means every target in the tier is parked or failed.

## Limitations

- Limit detection reads terminal text, so it depends on the agents' wording. Add patterns in `limit_patterns` if a message slips through, and use `hroute mark` as a manual override. Claude usage is only known while a session of that account runs with the statusline hook.
- A limit hit later in a long task (after the probe window) is not caught automatically. Run `hroute mark <account>` and re-run.
- Tested with unit tests for config, classification, limit parsing and state. The live Herdr launch path needs a Herdr session, so check it with your own agents first (`hroute doctor`, then a throwaway prompt).

## Development

```sh
bun test
bun run typecheck
```

MIT licensed.
