export interface CommandHelp {
  usage: string;
  summary: string;
  details?: string;
  options?: [flag: string, text: string][];
  examples?: string[];
}

export const COMMANDS: Record<string, CommandHelp> = {
  run: {
    usage: "hroute run [-t <tier>] [--cwd <dir>] [--direction right|down] [--wait] [--no-handoff] [--json] <prompt>",
    summary: "Classify a prompt and start it on the best available agent in a new Herdr pane.",
    details:
      "Must run inside a Herdr pane. The first usable target of the tier's chain wins: accounts that are parked or at/over their 5h threshold are skipped, then the fallback tier is tried. If the agent prints a limit message right after launch, the account is parked and the next target is used.",
    options: [
      ["-t, --tier <name>", "Force a tier instead of classifying (plan, impl, quick, or your own)."],
      ["--cwd <dir>", "Working directory for the new pane (default: current)."],
      ["--direction right|down", "How to split the pane (default: right)."],
      ["--wait", "Block until the agent settles."],
      ["--no-handoff", "Do not prepend the handoff note to the prompt."],
      ["--json", "Machine-readable result."],
    ],
    examples: ['hroute run "add pagination to /users"', 'hroute run -t quick "rename foo to bar" --wait'],
  },
  explain: {
    usage: "hroute explain [--json] <prompt>",
    summary: "Show the tier, who decided it and the first usable target. Launches nothing.",
    details: "Use it to tune rules and chains. Does not need Herdr. Any LLM classification (Jev or Haiku) still runs, exactly as in `run`.",
    examples: ['hroute explain "design the auth architecture"'],
  },
  sub: {
    usage: "hroute sub <tier> [--cwd <dir>] [--timeout 10m] [--no-handoff] <task>     (alias: hsub)",
    summary: "Run a task once, headlessly, and print the answer on stdout.",
    details:
      "Uses `claude -p`, `codex exec` or `agy -p` on the first usable target of the tier. Routing notes go to stderr, so stdout can be piped. Exits 2 when no target is available. If the work moves to another account, the handoff note is refreshed first.",
    options: [
      ["--cwd <dir>", "Directory to run in (default: current)."],
      ["--timeout <dur>", "Per-attempt limit, e.g. 90s, 10m (default 10m)."],
      ["--no-handoff", "Do not prepend the handoff note."],
    ],
    examples: ['hsub quick "which file defines parseConfig?"', 'hsub plan "review the diff for security issues" > review.md'],
  },
  status: {
    usage: "hroute status",
    summary: "Show config path, each account's live 5h usage and parked state, and every tier's chain.",
    details: "`usage unknown` means no data yet: for Claude, a session has to refresh the statusline with the usage-sink line installed.",
  },
  log: {
    usage: "hroute log [-n <count>]",
    summary: "Show recent routing decisions from hook (only with [hook] debug = true), run and sub.",
    options: [["-n <count>", "How many entries (default 20)."]],
  },
  mark: {
    usage: "hroute mark <account|target> [--for 5h]",
    summary: "Park an account by hand so routing skips it. Use when a limit slipped past detection.",
    examples: ["hroute mark claude --for 3h", "hroute mark claude-work"],
  },
  reset: {
    usage: "hroute reset [account|target]",
    summary: "Un-park one account/target, or everything when no argument is given.",
  },
  hook: {
    usage: "hroute hook",
    summary: "UserPromptSubmit hook. Reads the hook JSON on stdin and prints routing hints as hook JSON.",
    details:
      "Not meant to be run by hand; `hroute install-hook` registers it. With no real signal (short or unmatched prompt) it stays silent. [hook] debug = true adds a visible one-line summary per prompt.",
  },
  "install-hook": {
    usage: "hroute install-hook [--write]",
    summary: "Show, or with --write merge, hroute's hooks into Claude Code's settings.json.",
    details:
      "Adds UserPromptSubmit (routing hint), SessionStart (hroute sync-agents) and Stop (handoff bookkeeping). Existing hooks are kept and a .bak copy is made. Honors CLAUDE_CONFIG_DIR. Start a new Claude session afterwards.",
    options: [["--write", "Apply the change (default: preview only)."]],
  },
  "sync-agents": {
    usage: "hroute sync-agents [--dir <dir>]",
    summary: "Write Claude Code subagents hr-<tier>.md whose model is the first Claude target usable right now.",
    details: "Default directory: <CLAUDE_CONFIG_DIR or ~/.claude>/agents. Files you wrote yourself are never overwritten; generated ones carry a marker.",
    options: [["--dir <dir>", "Write somewhere else (useful to preview)."]],
  },
  handoff: {
    usage: "hroute handoff show|clear|update [--cwd <dir>] [--transcript <file>] [--force]",
    summary: "Inspect, reset or refresh the handoff note passed to the next agent.",
    details:
      "show prints the note plus live git facts. clear deletes it. update --transcript <file.jsonl> asks Haiku to rewrite it from a Claude transcript. The Stop hook uses `update --hook` internally.",
    examples: ["hroute handoff show", "hroute handoff clear --cwd ~/repo/app"],
  },
  "usage-sink": {
    usage: "hroute usage-sink <account>",
    summary: "Read Claude statusline JSON on stdin and record the 5h usage for an account.",
    details: 'Add `echo "$input" | hroute usage-sink claude >/dev/null 2>&1 &` to your statusLine command, right after `input=$(cat)`.',
  },
  init: {
    usage: "hroute init",
    summary: "Create ~/.config/herdr-router/routing.toml and a chmod-600 .env from the examples. Never overwrites.",
  },
  doctor: {
    usage: "hroute doctor",
    summary: "Check the herdr binary, being inside a Herdr pane, the config, agent CLIs and the OpenRouter key.",
  },
};

const ORDER = ["run", "explain", "sub", "status", "log", "mark", "reset", "hook", "install-hook", "sync-agents", "handoff", "usage-sink", "init", "doctor"];

const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));

export function overview(): string {
  const rows = ORDER.map((c) => `  ${pad(c, 14)}${COMMANDS[c]!.summary}`).join("\n");
  return `hroute: task-aware model routing for Herdr

Usage: hroute <command> [options]     (hsub <tier> "<task>" is shorthand for \`hroute sub\`)

Commands:
${rows}

Run \`hroute help <command>\` (or \`hroute <command> --help\`) for options and examples.

Config:  $HROUTE_CONFIG, ./routing.toml, ~/.config/herdr-router/routing.toml
Secrets: real environment first, then ~/.config/herdr-router/.env (or $HROUTE_ENV)
Docs:    https://github.com/Manulapo/herdr-router#documentation
`;
}

export function commandHelp(name: string): string | null {
  const c = COMMANDS[name];
  if (!c) return null;
  const parts = [`${c.usage}\n\n${c.summary}`];
  if (c.details) parts.push(c.details);
  if (c.options?.length) parts.push("Options:\n" + c.options.map(([f, t]) => `  ${pad(f, 26)}${t}`).join("\n"));
  if (c.examples?.length) parts.push("Examples:\n" + c.examples.map((e) => `  ${e}`).join("\n"));
  return parts.join("\n\n") + "\n";
}

/** Closest known command for a typo, or null. Plain edit distance, small and dependency free. */
export function suggest(name: string): string | null {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length]![b.length]!;
  };
  const best = ORDER.map((c) => [c, dist(name, c)] as const).sort((x, y) => x[1] - y[1])[0]!;
  return best[1] <= 3 ? best[0] : null;
}
