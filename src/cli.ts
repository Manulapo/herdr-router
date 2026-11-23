import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { classify } from "./classify.ts";
import { configCandidates, findConfig, loadConfig } from "./config.ts";
import { formatRemaining, parseDuration } from "./duration.ts";
import { insideHerdr } from "./herdr.ts";
import { syncAgents } from "./agents.ts";
import { run } from "./run.ts";
import { runSub } from "./sub.ts";
import { getUsage, writeClaudeUsage } from "./usage.ts";
import { clearExhausted, loadState, markExhausted, statePath } from "./state.ts";

const HELP = `hroute - tier-based model routing for Herdr

Usage:
  hroute run [--tier <t>] [--cwd <dir>] [--direction right|down] [--wait] [--dry-run] <prompt>
  hroute explain <prompt>          Show tier + fallback chain without launching anything
  hroute sub <tier> [--cwd <dir>] <task>   Headless one-shot on the first usable target (also: hsub)
  hroute sync-agents [--dir <d>]   Write Claude Code subagents hr-<tier>.md (model follows live usage)
  hroute status                    Tiers, chains, 5h usage and parked accounts
  hroute usage-sink <account>      Read statusline JSON on stdin, record the 5h usage for <account>
  hroute mark <account|target> [--for 5h]  Park an account manually, e.g. claude-work
  hroute reset [account|target]    Un-park one, or all
  hroute init                      Copy routing.example.toml to ~/.config/herdr-router/
  hroute doctor                    Check herdr, config and optional Jev key

Config: $HROUTE_CONFIG, ./routing.toml, ~/.config/herdr-router/routing.toml
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    console.log(HELP);
    return 0;
  }

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      tier: { type: "string", short: "t" },
      cwd: { type: "string" },
      direction: { type: "string", default: "right" },
      wait: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      for: { type: "string", default: "5h" },
      json: { type: "boolean", default: false },
      dir: { type: "string" },
      timeout: { type: "string", default: "10m" },
    },
  });

  switch (cmd) {
    case "run":
    case "explain": {
      const prompt = positionals.join(" ").trim();
      if (!prompt) throw new Error("A prompt is required");
      const { config } = loadConfig();
      const c = await classify(prompt, config, values.tier);
      const dryRun = cmd === "explain" || values["dry-run"];
      if (!dryRun && !insideHerdr()) {
        throw new Error("Not inside a Herdr pane (HERDR_ENV!=1). Run from Herdr, or use --dry-run / explain.");
      }
      if (values.direction !== "right" && values.direction !== "down") throw new Error("--direction must be right|down");
      const result = await run(config, {
        tier: c.tier,
        prompt,
        cwd: values.cwd ?? process.cwd(),
        direction: values.direction,
        wait: values.wait,
        dryRun,
      });
      const out = { classification: c, ...result };
      if (values.json) console.log(JSON.stringify(out, null, 2));
      else {
        console.log(`tier   ${c.tier}  (${c.source}${c.detail ? `: ${c.detail}` : ""})`);
        for (const a of result.attempts) console.log(`  ${a.outcome.padEnd(18)} ${a.target}${a.detail ? `  ${a.detail}` : ""}`);
        const hop = result.usedTier && result.usedTier !== c.tier ? ` [fallback tier: ${result.usedTier}]` : "";
        console.log(result.chosen ? `-> ${result.chosen}${hop}${result.pane ? ` in pane ${result.pane}` : " (dry run)"}` : "-> no target available");
      }
      return result.chosen ? 0 : 2;
    }

    case "status": {
      const { config, path } = loadConfig();
      const parked = loadState().exhausted;
      console.log(`config  ${path}\nstate   ${statePath()}\n`);
      const seen = new Set<string>();
      console.log("accounts");
      for (const tier of Object.values(config.tiers))
        for (const t of tier.chain) {
          if (seen.has(t.account)) continue;
          seen.add(t.account);
          const u = getUsage(t);
          const p = parked[t.account];
          const usage = u ? `${Math.round(u.usedPercent)}% used${u.resetsAt && u.resetsAt.getTime() > Date.now() ? `, resets in ${formatRemaining(u.resetsAt.getTime() - Date.now())}` : ""}` : "usage unknown";
          const max = t.maxUsed ?? config.defaultMaxUsed;
          const park = p ? `  PARKED ${formatRemaining(new Date(p.until).getTime() - Date.now())} (${p.reason})` : "";
          console.log(`  ${t.account.padEnd(16)} ${usage} (switch at ${max}%)${park}`);
        }
      console.log();
      for (const [name, tier] of Object.entries(config.tiers)) {
        console.log(`${name === config.defaultTier ? `${name} (default)` : name}${tier.fallbackTier ? `  -> falls back to ${tier.fallbackTier}` : ""}`);
        for (const t of tier.chain) console.log(`  ${t.id}`);
      }
      return 0;
    }

    case "sub": {
      const [tier, ...words] = positionals;
      const task = words.join(" ").trim();
      if (!tier || !task) throw new Error("Usage: hroute sub <tier> <task>");
      const { config } = loadConfig();
      if (!config.tiers[tier]) throw new Error(`Unknown tier "${tier}". Defined: ${Object.keys(config.tiers).join(", ")}`);
      const r = await runSub(config, tier, task, { cwd: values.cwd ?? process.cwd(), timeoutMs: parseDuration(values.timeout) });
      for (const a of r.attempts) if (a.outcome !== "started") console.error(`hsub: ${a.outcome} ${a.target}${a.detail ? ` - ${a.detail}` : ""}`);
      if (!r.chosen) {
        console.error("hsub: no target available");
        return 2;
      }
      console.error(`hsub: ran on ${r.chosen}`);
      process.stdout.write(r.output);
      return r.exitCode;
    }

    case "sync-agents": {
      const { config } = loadConfig();
      const dir = values.dir ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "agents");
      const ctx = { exhausted: loadState().exhausted, usage: (t: any) => getUsage(t) };
      for (const r of syncAgents(config, ctx, dir)) console.log(`${r.action.padEnd(18)} ${r.file}  model=${r.model ?? "(inherit)"}`);
      return 0;
    }

    case "usage-sink": {
      const account = positionals[0];
      if (!account) throw new Error("Usage: hroute usage-sink <account>   (statusline JSON on stdin)");
      writeClaudeUsage(account, await Bun.stdin.text());
      return 0;
    }

    case "mark": {
      const target = positionals[0];
      if (!target) throw new Error("Usage: hroute mark <account|target> [--for 5h]");
      markExhausted(target, new Date(Date.now() + parseDuration(values.for)), "manual");
      console.log(`parked ${target} for ${values.for}`);
      return 0;
    }

    case "reset":
      clearExhausted(positionals[0]);
      console.log(positionals[0] ? `un-parked ${positionals[0]}` : "un-parked all targets");
      return 0;

    case "init": {
      const dest = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "~", ".config"), "herdr-router", "routing.toml");
      if (existsSync(dest)) throw new Error(`${dest} already exists`);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(new URL("../routing.example.toml", import.meta.url), dest);
      console.log(`wrote ${dest} - edit the models to match your subscriptions`);
      return 0;
    }

    case "doctor": {
      const ok = (b: boolean) => (b ? "ok  " : "FAIL");
      const v = Bun.spawnSync(["herdr", "--version"]);
      console.log(`${ok(v.exitCode === 0)} herdr binary ${v.stdout.toString().trim()}`);
      console.log(`${ok(insideHerdr())} inside a Herdr pane (HERDR_ENV=1)`);
      const cfg = findConfig();
      console.log(`${ok(!!cfg)} config ${cfg ?? `not found; searched ${configCandidates().join(", ")}`}`);
      if (cfg) {
        try {
          loadConfig(cfg);
          console.log("ok   config parses");
        } catch (e) {
          console.log(`FAIL config: ${(e as Error).message}`);
        }
      }
      for (const kind of ["claude", "codex"]) {
        console.log(`${ok(Bun.which(kind) !== null)} ${kind} on PATH`);
      }
      console.log(`${process.env.OPENROUTER_API_KEY ? "ok  " : "info"} OPENROUTER_API_KEY ${process.env.OPENROUTER_API_KEY ? "set (Jev classifier available)" : "unset (rules-only classification)"}`);
      return 0;
    }

    default:
      console.error(`Unknown command "${cmd}"\n\n${HELP}`);
      return 1;
  }
}
