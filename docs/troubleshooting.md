# Troubleshooting

Start with `hroute doctor` and `hroute status`. For routing questions, `hroute explain "<prompt>"` shows the decision, and `[hook] debug = true` plus `hroute log` shows what the hook did on real prompts.

## `hroute: command not found` (also in hooks)

The hooks call `hroute` by name. `bun link` does not always put the binary on `PATH`; use symlinks instead:

```sh
ln -s ~/path/to/herdr-router/bin/hroute.ts ~/.local/bin/hroute
ln -s ~/path/to/herdr-router/bin/hsub.ts   ~/.local/bin/hsub
```

## Codex fails with `Connection refused` when Ollama is closed

If you ever launched Codex through Ollama, Ollama rewrote `~/.codex/config.toml` with lines such as:

```toml
model_catalog_json = ".../ollama-launch-models.json"
openai_base_url = "http://127.0.0.1:11434/api/codex/v1"
```

Codex then sends everything to the local Ollama port and dies when Ollama quits (`failed to connect to Responses WebSocket`, `Connection refused (os error 61)`). Remove those two lines (keep a backup) to talk to OpenAI directly. Launching Codex through Ollama again will add them back; to keep both setups, give `hroute` its own Codex home with a clean config (`CODEX_HOME=~/.codex-direct codex login`) and point an account at it:

```toml
[accounts.codex]
kind = "codex"
env = { CODEX_HOME = "~/.codex-direct" }
```

## `hsub` hangs on Codex

`codex exec` waits for input on stdin when it is left open; `hsub` closes it. If it still hangs, run the same command by hand (`codex exec -m <model> "hi" < /dev/null`) to separate an `hroute` problem from a Codex or network one. Codex also refuses to run outside a trusted/git directory unless told otherwise.

## Claude usage shows `unknown`

Claude's percentage is only recorded when a session refreshes the statusline with the `usage-sink` line installed (see [Getting started](getting-started.md#5-read-claudes-usage-optional-recommended)). Send any message in a Claude session of that account, then `hroute status` again. The account name in the line must match the config (`claude` for the implicit account).

## The hook does nothing

- Hooks load at session start: open a **new** Claude Code session after `install-hook --write`.
- The hook is silent when it has no real signal (short or unmatched prompt) or when Claude is already the right place. Turn on `[hook] debug = true` to see its decision on each prompt.
- Check the entry exists: `grep -n hroute ~/.claude/settings.json`.

## `hroute explain` uses the wrong models

`./routing.toml` in the current directory wins over `~/.config/herdr-router/routing.toml`. `hroute status` prints the file in use; delete the stray copy or set `HROUTE_CONFIG`.

## A limit was hit but routing keeps choosing that account

Detection reads terminal text, so unfamiliar wording can slip through, and a limit hit after the `probe_seconds` window is not seen. Park the account by hand:

```sh
hroute mark claude --for 3h
```

and add the new wording to `limit_patterns` (regex, case-insensitive).

## OpenRouter / Jev is not used

`hroute doctor` should say the key is set. The key comes from the real environment or `~/.config/herdr-router/.env` (`OPENROUTER_API_KEY=...`, `chmod 600`). If Jev fails or times out it falls back to Haiku silently; with `mode = "jev"` and no result it falls back to `default_tier`.

## Handoff note is empty or stale

`hroute handoff show` prints the note for the current directory; notes are per working directory, so a session in one folder does not feed `hsub` run from another. With the default `on-switch` mode the note is only created at a handover between accounts. Refresh by hand with `hroute handoff update --transcript <file.jsonl> --force`.

## Undo the hooks

`install-hook --write` keeps `settings.json.bak`. To remove hroute's hooks, delete the three entries whose command starts with `hroute`, or restore the backup.
