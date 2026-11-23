# Getting started

## Fast path

```sh
curl -fsSL https://raw.githubusercontent.com/Manulapo/herdr-router/main/install.sh | sh
hroute setup           # preview
hroute setup --yes     # apply: config, .env, PATH links, statusline usage line, hooks, subagents
hroute doctor
```

`setup` is idempotent, previews before changing anything and backs up `settings.json`. Anything it cannot do safely is listed as `TODO`. The rest of this page is the same thing done by hand, step by step.

## 1. Install

```sh
git clone https://github.com/Manulapo/herdr-router && cd herdr-router
bun install
ln -s "$PWD/bin/hroute.ts" ~/.local/bin/hroute
ln -s "$PWD/bin/hsub.ts"   ~/.local/bin/hsub
```

`~/.local/bin` must be on your `PATH`. (`bun link` registers the package but does not always put the binaries on `PATH`; the symlinks always do.) The Claude Code hooks call `hroute` by name, so it has to be resolvable from any shell.

## 2. Create the config

```sh
hroute init
```

This writes `~/.config/herdr-router/routing.toml` (from `routing.example.toml`) and, if missing, a `chmod 600` `~/.config/herdr-router/.env` (from `.env.example`). Open `routing.toml` and replace the placeholder model names with ones your accounts can use. List them with:

```sh
claude --help | grep -i model     # aliases such as sonnet / haiku, or full ids
codex debug models                 # raw model catalog as JSON (look at the "slug" fields)
agy models                        # Antigravity
```

For two logins of the same agent, add [accounts](configuration.md#accounts) with separate `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.

## 3. Check it

```sh
hroute doctor
hroute status
hroute explain "design the auth architecture"
hroute explain "fix a typo in the readme"
```

`explain` prints the tier, who decided it (rule, Jev, Haiku or default) and the first usable target. It never launches anything, so use it to tune rules and chains.

Simulate a limit without spending quota:

```sh
hroute mark claude --for 1h
hroute explain "add pagination"      # now picks the next target in the chain
hroute reset
```

## 4. Run something real

Inside a Herdr pane:

```sh
hroute run "say hello"
```

A new pane opens, the best available agent starts, and the prompt is sent. Use `--wait` to block until it settles and `-t quick|impl|plan` to force a tier. From any terminal:

```sh
hsub quick "which file defines parseConfig?"
```

## 5. Read Claude's usage (optional, recommended)

Codex usage is read automatically. For Claude, add one line to your `statusLine` command in `~/.claude/settings.json`, right after `input=$(cat)`:

```sh
echo "$input" | hroute usage-sink claude >/dev/null 2>&1 &
```

Use the account name from your config instead of `claude` for a named account. Without it, Claude's usage is unknown and Claude is treated as available.

## 6. Enable the Claude Code hooks (optional)

```sh
hroute install-hook            # preview
hroute install-hook --write    # merge into ~/.claude/settings.json (keeps a .bak)
```

This adds three hooks: `UserPromptSubmit` (routing hint per message), `SessionStart` (refresh the `hr-*` subagents) and `Stop` (record where the conversation lives for the handoff note). Existing hooks are preserved. **Start a new Claude Code session** afterwards; hooks load at startup.

To see what the hook decides on every prompt while you try it, set `[hook] debug = true` and read `hroute log`. Turn it off again when you are done.

## 7. Optional: Jev

Put an OpenRouter key in `~/.config/herdr-router/.env`:

```
OPENROUTER_API_KEY=sk-or-...
```

With the key set, `classifier.mode = "auto"` uses Jev for prompts no rule matched; without it, Haiku does. `hroute doctor` confirms it is picked up.
