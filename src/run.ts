import { detectLimit, parseResetTime } from "./limits.ts";
import { closePane, HerdrError, readAgent, readPane, sendPrompt, splitPane, startAgent, waitAgent } from "./herdr.ts";
import { loadState, markExhausted } from "./state.ts";
import type { Config, Target } from "./types.ts";

export interface RunOptions {
  tier: string;
  prompt: string;
  cwd: string;
  direction: "right" | "down";
  wait: boolean;
  dryRun: boolean;
}

export interface Attempt {
  target: string;
  outcome: "skipped-exhausted" | "limit" | "failed" | "started";
  detail?: string;
}

export interface RunResult {
  tier: string;
  chosen: string | null;
  pane?: string;
  agent?: string;
  attempts: Attempt[];
}

/** Drop lines echoing our own prompt so "fix the rate limit exceeded bug" is not mistaken for a limit. */
export function stripPrompt(text: string, prompt: string): string {
  const needles = prompt.split("\n").map((l) => l.trim()).filter((l) => l.length > 3);
  return text
    .split("\n")
    .filter((line) => {
      const t = line.replace(/^[\s>│|❯›]+/, "").trim();
      return !t || !needles.some((n) => n.includes(t) || t.includes(n));
    })
    .join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recordLimit(target: Target, text: string, config: Config, attempts: Attempt[], prompt = ""): boolean {
  text = prompt ? stripPrompt(text, prompt) : text;
  const hit = detectLimit(text, config.limitPatterns);
  if (!hit) return false;
  const until = parseResetTime(text) ?? new Date(Date.now() + config.defaultCooldownMs);
  markExhausted(target.id, until, hit);
  attempts.push({ target: target.id, outcome: "limit", detail: `${hit} (until ${until.toISOString()})` });
  return true;
}

export async function run(config: Config, opts: RunOptions): Promise<RunResult> {
  const chain = config.tiers[opts.tier]!;
  const exhausted = loadState().exhausted;
  const attempts: Attempt[] = [];

  for (const target of chain) {
    const parked = exhausted[target.id];
    if (parked) {
      attempts.push({ target: target.id, outcome: "skipped-exhausted", detail: `until ${parked.until}` });
      continue;
    }
    if (opts.dryRun) return { tier: opts.tier, chosen: target.id, attempts };

    const name = `hr-${opts.tier}-${Date.now().toString(36)}`.slice(0, 32).toLowerCase();
    let pane: string | undefined;
    try {
      pane = splitPane(opts.cwd, opts.direction);
      startAgent(name, target.kind, pane, target.args);
      if (recordLimit(target, readAgent(name), config, attempts)) {
        closePane(pane);
        continue;
      }

      try {
        sendPrompt(name, opts.prompt, 15_000);
      } catch (e) {
        // A stalled prompt usually means the agent refused with a limit message.
        if (!(e instanceof HerdrError)) throw e;
      }

      const deadline = Date.now() + config.probeSeconds * 1000;
      let limited = false;
      while (Date.now() < deadline) {
        if (recordLimit(target, readAgent(name), config, attempts, opts.prompt)) {
          limited = true;
          break;
        }
        await sleep(1000);
      }
      if (limited) {
        closePane(pane);
        continue;
      }

      attempts.push({ target: target.id, outcome: "started" });
      if (opts.wait) waitAgent(name);
      return { tier: opts.tier, chosen: target.id, pane, agent: name, attempts };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const text = pane ? readPane(pane) : "";
      if (!recordLimit(target, `${msg}\n${text}`, config, attempts)) {
        attempts.push({ target: target.id, outcome: "failed", detail: msg });
      }
      if (pane) closePane(pane);
    }
  }
  return { tier: opts.tier, chosen: null, attempts };
}
