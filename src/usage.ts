import { mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { statePath } from "./state.ts";
import type { Target } from "./types.ts";

export interface Usage {
  /** Percent of the 5h window used, 0-100. */
  usedPercent: number;
  resetsAt?: Date;
  source: string;
}

/** A window that already reset reads as 0% used. */
export function normalizeUsage(used: number, resetsAtSec: number | undefined, now: Date, source: string): Usage {
  const resetsAt = resetsAtSec ? new Date(resetsAtSec * 1000) : undefined;
  if (resetsAt && resetsAt <= now) return { usedPercent: 0, resetsAt, source: `${source}, window reset` };
  return { usedPercent: used, resetsAt, source };
}

// ---- Codex: rate limits are logged in each session's JSONL -----------------

export function parseCodexRateLimits(text: string): { used: number; resets: number } | null {
  const re = /"rate_limits":\{[^{}]*"primary":\{"used_percent":([\d.]+),"window_minutes":(\d+),"resets_at":(\d+)\}/g;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m;
  return last ? { used: Number(last[1]), resets: Number(last[3]) } : null;
}

function readTail(file: string, bytes = 262_144): string {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function newestSessions(dir: string, limit = 3): string[] {
  const names = (d: string) => {
    try {
      return readdirSync(d).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of names(dir))
    for (const m of names(join(dir, y)))
      for (const d of names(join(dir, y, m))) {
        const day = join(dir, y, m, d);
        const files = names(day)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => join(day, f))
          .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
        if (files.length) return files.slice(0, limit);
      }
  return [];
}

export function readCodexUsage(home: string, now = new Date()): Usage | null {
  for (const file of newestSessions(join(home, "sessions"))) {
    const r = parseCodexRateLimits(readTail(file));
    if (r) return normalizeUsage(r.used, r.resets, now, "codex session log");
  }
  return null;
}

// ---- Claude: the statusline hook drops its rate_limits JSON per account ----

export function usageDir(): string {
  return join(dirname(statePath()), "usage");
}

export function writeClaudeUsage(account: string, statuslineJson: string, now = new Date(), dir = usageDir()): boolean {
  let five: any;
  try {
    five = JSON.parse(statuslineJson)?.rate_limits?.five_hour;
  } catch {
    return false;
  }
  if (typeof five?.used_percentage !== "number") return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${account}.json`),
    JSON.stringify({ usedPercent: five.used_percentage, resetsAt: five.resets_at, seenAt: now.toISOString() }) + "\n",
  );
  return true;
}

export function readClaudeUsage(account: string, now = new Date(), dir = usageDir()): Usage | null {
  try {
    const d = JSON.parse(readFileSync(join(dir, `${account}.json`), "utf8"));
    return normalizeUsage(Number(d.usedPercent), d.resetsAt, now, "claude statusline");
  } catch {
    return null;
  }
}

/** Current 5h usage for a target's account, or null when unknown. */
export function getUsage(t: Target, now = new Date()): Usage | null {
  try {
    if (t.kind === "codex") return readCodexUsage(t.env.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"), now);
    if (t.kind === "claude") return readClaudeUsage(t.account, now);
  } catch {
    /* unreadable usage data means unknown, never a hard failure */
  }
  return null;
}
