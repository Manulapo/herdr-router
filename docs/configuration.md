# Configuration reference

One TOML file. Search order: `$HROUTE_CONFIG`, `./routing.toml`, `~/.config/herdr-router/routing.toml` (`$XDG_CONFIG_HOME` is honored). `hroute status` prints the file in use. Note that `./routing.toml` in the current directory wins, so a stray copy inside a project shadows your real config.

A fully commented starting point is [`routing.example.toml`](../routing.example.toml).

## Top level

| Key | Default | Meaning |
|---|---|---|
| `default_tier` | first tier | Tier used when nothing classifies the prompt. |
| `default_cooldown` | `"2h"` | How long to park an account after a limit message with no parsable reset time. |
| `default_max_used` | `90` | Skip a target once its account's 5h window is at least this % used. |
| `probe_seconds` | `10` | After `hroute run` sends a prompt, watch the agent this long for a limit message. |
| `limit_patterns` | built-in list | Case-insensitive regexes that mean "limit hit" in agent output. Replaces the defaults. |

Durations are `30s`, `90m`, `5h`, `1d`.

## `[classifier]`

Regex rules always run first. For prompts no rule matched:

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"auto"` | `auto`: Jev if `OPENROUTER_API_KEY` is set, else Haiku. `jev`: only Jev. `haiku`: only Haiku. `rules`: no LLM. |
| `jev_model` | `"typesafe/jev-router"` | OpenRouter model id. |
| `jev_cost_tier` | `"low"` | `low`, `medium` or `high` (Jev routing preference). |
| `haiku_model` | `"claude-haiku-5-5"` | Model for the headless Haiku classifier (`claude -p`). |
| `timeout` | `"15s"` | Per classification call. Failures fall back to the next classifier, then to `default_tier`. |

Jev replaces Haiku when a key is present, and Haiku backs Jev up if it fails. Haiku is skipped while the default Claude account is parked or over threshold.

## `[[rules]]`

```toml
[[rules]]
tier = "plan"
match = ["\\b(architect|design|rfc)\\b"]
```

Checked in file order; the first rule with a matching regex (case-insensitive) wins. `tier` must exist.

## `[hook]`

Controls the Claude Code `UserPromptSubmit` hook (`hroute hook`).

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"auto"` | `rules` keeps the hook instant and free (no LLM). |
| `min_chars` | `40` | Prompts shorter than this skip the LLM classifier (rules still apply). |
| `session_model` | `""` | If a Claude target's model contains this text (e.g. `"sonnet"`), no subagent hint is given, because the session already runs it. |
| `debug` | `false` | Show a one-line routing summary on every prompt and log each decision (`hroute log`). |

With no real signal (short or unmatched prompt) the hook never recommends a route.

## `[handoff]`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Prepend the handoff note to prompts from `hroute run` / `hsub`. |
| `mode` | `"on-switch"` | `on-switch`: summarize only when work moves to a different account. `every-turn`: background rewrite after each Claude reply. |
| `max_chars` | `2000` | Hard cap on the note. |
| `max_age` | `"24h"` | Older notes are ignored. |
| `min_interval` | `"2m"` | `every-turn` mode only: minimum time between rewrites. |

## `[accounts.<name>]`

Optional. Each account is one subscription login.

```toml
[accounts.claude-work]
kind = "claude"
env = { CLAUDE_CONFIG_DIR = "~/.claude-work" }
max_used = 85
```

| Key | Meaning |
|---|---|
| `kind` | A Herdr agent kind: `claude`, `codex`, `agy`, `gemini`, ... |
| `env` | Environment for the agent (`~/` is expanded). Use `CLAUDE_CONFIG_DIR` for a second Claude login, `CODEX_HOME` for a second Codex login. |
| `max_used` | Threshold for this account, overriding `default_max_used`. |

Without this section, each kind is one implicit account named after the kind (`claude`, `codex`, ...). Usage data and parking are tracked per account.

## `[tiers.<name>]`

```toml
[tiers.impl]
chain = ["claude:sonnet", "codex:gpt-5.5:medium", "agy:gemini-3.8-flash-medium"]
fallback_tier = "quick"
```

| Key | Default | Meaning |
|---|---|---|
| `chain` | required | Ordered targets. The first usable one wins. |
| `fallback_tier` | none | Tier to continue with when the whole chain is unusable. Cycles are safe. |
| `strategy` | `"ordered"` | `least-used` puts the usable target with the lowest known 5h usage first (unknown usage goes last). |
| `description` | built-in per tier | Used as the Claude subagent description by `sync-agents`. |
| `instructions` | generic | Body of the generated subagent. |

### Targets

String form `account-or-kind[:model[:effort]]`:

| Target | What runs |
|---|---|
| `claude:sonnet` | `claude --model sonnet` |
| `codex:gpt-5.5:high` | `codex -m gpt-5.5 -c model_reasoning_effort="high"` |
| `agy:gemini-3.8-flash-medium` | `agy --model gemini-3.8-flash-medium` |
| `claude-work:opus` | account `claude-work`, `--model opus`, with that account's `env` |

Table form for full control:

```toml
{ account = "claude-work", model = "opus", max_used = 70, env = { FOO = "1" }, args = ["--permission-mode", "plan"] }
```

`args` replaces the generated model arguments. A target is **unusable** when its account is parked (a limit message, or `hroute mark`) or its known 5h usage is at/over its `max_used`. Unknown usage counts as usable.

## Files and environment

| Path / variable | Purpose |
|---|---|
| `~/.config/herdr-router/routing.toml` | Configuration. |
| `~/.config/herdr-router/.env` | Secrets (`OPENROUTER_API_KEY`). Keep it `chmod 600`. Only this file (or `$HROUTE_ENV`) is read, never a project `.env`; real environment variables win. |
| `~/.local/state/herdr-router/state.json` | Parked accounts (`$HROUTE_STATE`). |
| `~/.local/state/herdr-router/usage/<account>.json` | Claude usage written by `usage-sink`. |
| `~/.local/state/herdr-router/handoff/` | Handoff notes, one per working directory. |
| `~/.local/state/herdr-router/routing.log` | Decision log (`$HROUTE_LOG`), self-trimming. |
| `HROUTE_CONFIG`, `HROUTE_ENV`, `HROUTE_STATE`, `HROUTE_LOG` | Override the paths above. |
| `HROUTE_ACCOUNT` | Account name of the origin Claude session for the handoff (default `claude`). |
| `HROUTE_INNER` | Set internally on helper `claude -p` calls so hooks never recurse. Do not set it yourself. |
| `CLAUDE_CONFIG_DIR` | Honored by `install-hook` and `sync-agents`. |
