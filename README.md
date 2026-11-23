<div align="center">

# herdr-router

**Stop babysitting your AI subscriptions.**<br>
Task-aware model routing for [Herdr](https://herdr.dev): the right agent for each job, and an automatic switch when a 5-hour limit is close.

[![CI](https://github.com/Manulapo/herdr-router/actions/workflows/ci.yml/badge.svg)](https://github.com/Manulapo/herdr-router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh)
[![Zero dependencies](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)](package.json)

</div>

You pay for Claude, Codex, maybe Antigravity. Each has its own 5-hour window. You burn through one, hit a wall, and switch by hand, losing both time and context.

`hroute` fixes that. It decides **who should do a piece of work** from the kind of task and from how much of each subscription is left, runs it, and hands the next agent a short note so it does not start blind.

```text
$ hroute explain "fix the typo in the readme"
tier   quick  (rule: \b(grep|find|list|rename|typo|...)\b)
-> claude:claude-haiku-5-5

$ hroute mark claude --for 3h          # Claude hit its limit
$ hroute explain "fix the typo in the readme"
tier   quick  (rule: ...)
  skipped            claude:claude-haiku-5-5  parked until 02:38
-> codex:gpt-6-luna:low                # work flows to the next subscription
```

## Highlights

|  |  |
|---|---|
| **Cascading fallback** | Each task tier is an ordered list of models. When one is spent, the next takes over; when the whole list is spent, a simpler tier steps in. |
| **Real usage, not guesses** | The 5h percentage comes from what the agents already expose (Codex session logs, Claude's statusline data). Switch at 90%, or whatever you set. |
| **Task-aware** | Free regex rules first. Prompts they miss go to [Jev](https://openrouter.ai/docs/guides/routing/routers/jev-router) (if you add an OpenRouter key) or a tiny Haiku call. |
| **Handoff note** | A small, size-capped summary (goal, done, next, decisions) travels with the work, written only when it moves to another account. |
| **Several accounts** | Two Claude logins, two Codex logins, Antigravity: chain them in any order. |
| **Subscriptions, not API bills** | Agents run through their own CLIs and logins. |
| **Zero runtime dependencies** | Pure Bun. No daemon, no service. |
| **Debuggable** | `hroute explain`, `hroute status`, `hroute log`, and a one-line routing summary per prompt when you turn on `debug`. |

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Manulapo/herdr-router/main/install.sh | sh
hroute setup           # preview what it would configure
hroute setup --yes     # apply it
```

`setup` creates your config and a private `.env`, links `hroute`/`hsub` onto your `PATH`, adds the usage line to your Claude statusline, installs the Claude Code hooks and generates the subagents. It is idempotent, shows a preview first, and backs up `settings.json` before touching it.

Requires [Bun](https://bun.sh) 1.2+, [Herdr](https://herdr.dev) 0.9+ and the agent CLIs you want to route to, already logged in. Prefer doing it by hand? See [Getting started](docs/getting-started.md).

Then edit `~/.config/herdr-router/routing.toml` so the model names match your accounts, and check everything with `hroute doctor`.

## Use it

```sh
hroute run "add pagination to /users"       # opens a Herdr pane on the best available agent
hroute run -t quick "rename foo to bar"     # force a tier
hsub quick "where is parseConfig defined?"  # headless one-shot, answer on stdout
hroute status                               # accounts, live 5h usage, chains
```

Inside Claude Code, the installed hooks add a per-message hint ("delegate this to the `hr-quick` subagent", or "Claude is nearly out: run `hsub impl ...`"). Turn on `[hook] debug = true` to see each decision.

## How it decides

```text
prompt ─► regex rules ─► Jev (key set) or Haiku ─► default tier
              └──────────── tier: plan | impl | quick | yours ◄────┘
                                      │
        chain, in order:  claude:sonnet → codex:sol → agy:flash
                                      │
   skip a target if its account is parked or at/over max_used (90%)
                                      │
            nothing left? ─► fallback_tier (a simpler chain)
```

A configuration looks like this (full reference in [docs/configuration.md](docs/configuration.md)):

```toml
default_max_used = 90                    # leave a subscription at 90% of its 5h window

[[rules]]
tier = "plan"
match = ["\\b(architect|design|rfc|security)\\b"]

[tiers.plan]
chain = ["claude:sonnet", "codex:gpt-6.1-sol:high", "agy:gemini-4-carbon-medium"]
fallback_tier = "impl"                   # all spent? step down to something simpler

[tiers.quick]
chain = ["claude:haiku", "codex:gpt-6-luna:low"]
```

## Three ways in

| | |
|---|---|
| `hroute run` | Start a task in a new Herdr pane on the best available agent. |
| `hsub <tier> "<task>"` | Headless one-shot (`claude -p`, `codex exec`, `agy -p`), answer on stdout. Works across accounts. |
| Claude Code hooks and subagents | Per-message routing hints inside a Claude session. |

## FAQ

**Does it use my API keys?** No. Agents run through their own CLIs and subscription logins. The only paid call is optional: Jev on OpenRouter, a tiny classification request, and only if you set `OPENROUTER_API_KEY`.

**Can it change the model of my running Claude session?** No, nothing outside the session can. It routes *new* work (`hroute run`, `hsub`) and gives hints to Claude; Claude decides whether to follow them.

**What if an agent hits its limit mid-task?** Right after launch, the limit message is detected and the next target takes over. A limit hit later in a long task is not caught automatically: `hroute mark <account>` parks it by hand.

**Does it work without Jev?** Yes. Without a key, regex rules plus a tiny Haiku call classify the prompts, or set `mode = "rules"` for no LLM at all.

**Will it read my Claude usage?** Only while a Claude session of that account runs with the statusline line that `hroute setup` adds. Unknown usage counts as available.

**Is it safe to try?** Everything that edits your files previews first, keeps a backup, and is idempotent. See [SECURITY.md](SECURITY.md).

## Documentation

- [Getting started](docs/getting-started.md)
- [Configuration reference](docs/configuration.md): every key, default, file and environment variable
- [How it works](docs/how-it-works.md): classification, fallback, usage sources, hooks, handoff
- [Troubleshooting](docs/troubleshooting.md)
- [Example configs](examples)

`hroute help` lists every command; `hroute help <command>` shows options and examples.

## Status and limits

Early but tested: unit tests cover config, classification, limits, planning, hooks, handoff and setup. The live launch path needs a Herdr session, so try `hroute run "say hello"` first. Limit detection reads terminal text and depends on each agent's wording; add patterns in `limit_patterns` when one slips through.

## Contributing

`bun install && bun run check`. A pre-push hook runs the full check for you. See [CONTRIBUTING.md](CONTRIBUTING.md). Releases are automated: push a `v*` tag and GitHub Actions publishes the release notes.

MIT licensed.
