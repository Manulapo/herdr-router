# herdr-router

[![CI](https://github.com/Manulapo/herdr-router/actions/workflows/ci.yml/badge.svg)](https://github.com/Manulapo/herdr-router/actions/workflows/ci.yml)

Task-aware model routing for [Herdr](https://herdr.dev), built on the subscriptions you already pay for.

`hroute` decides *who* should do a piece of work (which agent, which model) from the kind of task and from how much of each subscription's 5-hour window is left, then runs it. When a subscription is nearly spent, work flows to the next one automatically.

```sh
hroute run "design the auth architecture"     # hard task    -> strongest model that still has quota
hroute run "add pagination to /users"         # normal task  -> everyday model
hroute run "rename foo to bar"                # light task   -> cheapest model
hsub quick "where is parseConfig defined?"    # headless one-shot, answer on stdout
```

## Why

Claude Code, Codex and similar CLIs each have their own 5-hour usage window. Using one until it stops, then switching by hand, wastes both time and context. `herdr-router` automates the switching and carries a short handoff note so the next agent does not start blind.

- **Rules first, LLM only when needed.** Regex rules classify most prompts for free. Unmatched prompts go to [Jev](https://openrouter.ai/docs/guides/routing/routers/jev-router) (OpenRouter) if you have a key, otherwise to a tiny Haiku call.
- **Real usage, not guesses.** The 5h percentage is read from what the agents already expose (Codex session logs, Claude's statusline data).
- **Cascading fallback.** Each task tier is an ordered list of targets. A target is skipped when its account is over a threshold (default 90%) or hit a limit; when the whole list is spent, a simpler tier takes over.
- **Subscriptions, not API billing.** Agents run through their own CLIs and logins.
- **No daemon.** A CLI over `herdr pane` / `herdr agent`, plus optional Claude Code hooks.

## Quick start

Requirements: [Herdr](https://herdr.dev) 0.9+, [Bun](https://bun.sh) 1.2+, and the agent CLIs you want to route to (`claude`, `codex`, `agy`, ...), already logged in.

```sh
git clone https://github.com/Manulapo/herdr-router && cd herdr-router
bun install
ln -s "$PWD/bin/hroute.ts" ~/.local/bin/hroute      # or: bun link
ln -s "$PWD/bin/hsub.ts"   ~/.local/bin/hsub
hroute init        # writes ~/.config/herdr-router/routing.toml and a private .env
hroute doctor      # checks herdr, config, agent CLIs, key
```

Edit `~/.config/herdr-router/routing.toml` so the model names match your accounts (the example values are placeholders), then:

```sh
hroute status                                  # accounts, live 5h usage, tiers
hroute explain "design the auth architecture"  # shows the decision, launches nothing
hroute run "say hello"                         # from inside a Herdr pane
```

See [docs/getting-started.md](docs/getting-started.md) for a guided first run.

## How it decides

```
prompt ──► regex rules ──► Jev (if OPENROUTER_API_KEY) or Haiku ──► default tier
              │                          │
              └──────────── tier: plan | impl | quick | ... ◄─────┘
                                   │
              chain of targets, in order:  claude:sonnet → codex:sol → agy:flash
                                   │
        skip a target if its account is parked or at/over max_used (90%)
                                   │
              none left? ──► fallback_tier (a simpler chain)
```

Details: [docs/how-it-works.md](docs/how-it-works.md).

## Three ways in

| Entry point | Use it for |
|---|---|
| `hroute run` | Start a task in a new Herdr pane on the best available agent. |
| `hsub <tier> "<task>"` | Headless one-shot (`claude -p`, `codex exec`, `agy -p`), answer on stdout. Works across accounts. |
| Claude Code hooks and subagents | Per-message routing hints inside a Claude session (`hroute install-hook`, `hroute sync-agents`). |

## Handoff note

Routed agents start with no memory, so `hroute` keeps a small per-directory note (Goal / Done / Next / Decisions, size-capped, rewritten rather than appended). It is summarized only when work moves to a different account, then prepended to the next agent's prompt together with live `git` facts. See [How it works](docs/how-it-works.md#handoff-note).

## Commands

Run `hroute help` for the list, `hroute help <command>` (or `hroute <command> --help`) for options and examples.

| Command | What it does |
|---|---|
| `hroute run [-t tier] [--wait] [--direction right\|down] <prompt>` | Classify, launch, fall back |
| `hroute explain <prompt>` | Show tier and chain without launching |
| `hroute sub <tier> <task>` / `hsub` | Headless one-shot on the first usable target |
| `hroute status` | Accounts with live 5h usage, parked accounts, tiers |
| `hroute log [-n 20]` | Recent routing decisions |
| `hroute mark <account\|target> [--for 5h]` / `hroute reset [...]` | Park / un-park an account by hand |
| `hroute hook` / `hroute install-hook [--write]` | Per-message routing hook and its installer |
| `hroute sync-agents [--dir d]` | Generate Claude Code subagents `hr-<tier>` |
| `hroute handoff show\|clear\|update` | Inspect or refresh the handoff note |
| `hroute usage-sink <account>` | Record Claude statusline usage (reads JSON on stdin) |
| `hroute init` / `hroute doctor` | Setup and diagnostics |

## Documentation

- [Getting started](docs/getting-started.md): install, first run, enabling the hooks
- [Configuration reference](docs/configuration.md): every key, default, file and environment variable
- [How it works](docs/how-it-works.md): classification, fallback, usage sources, hooks, `hsub`, handoff
- [Troubleshooting](docs/troubleshooting.md): common problems and fixes
- [`examples/`](examples): ready-made configs

## Limitations

- Limit detection reads terminal text, so it depends on the agents' wording. Add patterns in `limit_patterns`, and use `hroute mark` as a manual override.
- A limit hit later in a long task (after the probe window) is not caught automatically.
- Claude's usage is only known while a session of that account runs with the statusline hook; unknown usage counts as available.
- Hooks are hints: Claude decides whether to follow them, and a hook cannot change the running session's model.
- Unit tests cover config, classification, limits, planning, hooks and handoff. The live Herdr launch path needs a Herdr session, so try it with a throwaway prompt first.

## Development

```sh
bun install
bun test
bun run typecheck
```

Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
