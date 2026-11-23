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

## Why this design

- **Rules, not an LLM, decide by default.** Free, instant, predictable. An optional [Jev](https://openrouter.ai/docs/guides/routing/routers/jev-router) classifier (OpenRouter) handles only the prompts no rule matched.
- **Limits are handled reactively.** Claude Code and Codex don't expose remaining quota reliably, so nothing tries to predict it. When an agent prints a limit message, the target is *parked* until the parsed reset time and the next one in the chain takes over.
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

## Commands

| Command | What it does |
|---|---|
| `hroute run [-t tier] [--wait] [--direction right\|down] <prompt>` | Classify, launch, fall back |
| `hroute explain <prompt>` | Show tier and chain without launching |
| `hroute status` | Tiers, chains, parked targets |
| `hroute mark <target> [--for 5h]` | Park a target by hand |
| `hroute reset [target]` | Un-park one or all |
| `hroute init` / `hroute doctor` | Setup and diagnostics |

## How fallback works

1. Skip targets currently parked in `~/.local/state/herdr-router/state.json`.
2. Split a pane (focus stays where it is), `herdr agent start`, send the prompt.
3. Watch the agent for `probe_seconds`. If a limit message shows up (the echo of your own prompt is ignored), park the target until the parsed reset time (`resets 3pm`, `in 2 hours 10 minutes`) or `default_cooldown`, close the pane, try the next target.
4. Otherwise leave the agent working in its pane and return. `--wait` blocks until it settles.

Exit code `2` means every target in the tier is parked or failed.

## Limitations

- Limit detection reads terminal text, so it depends on the agents' wording. Add patterns in `limit_patterns` if a message slips through, and use `hroute mark` as a manual override.
- A limit hit later in a long task (after the probe window) is not caught automatically. Run `hroute mark <target>` and re-run.
- Tested with unit tests for config, classification, limit parsing and state. The live Herdr launch path needs a Herdr session, so check it with your own agents first (`hroute doctor`, then a throwaway prompt).

## Development

```sh
bun test
bun run typecheck
```

MIT licensed.
