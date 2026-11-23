import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statePath } from "./state.ts";

export interface LogEntry {
  at: string;
  via: "hook" | "run" | "sub";
  tier: string;
  source: string;
  /** Target the router picked (a recommendation for `hook`, the real one for `run`/`sub`). */
  target: string | null;
  note?: string;
}

export const logPath = () => process.env.HROUTE_LOG ?? join(dirname(statePath()), "routing.log");

const MAX_BYTES = 200_000;

/** Append one JSON line. Logging must never break routing, so every failure is swallowed. */
export function appendLog(entry: Omit<LogEntry, "at">, path = logPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
    if (statSync(path).size > MAX_BYTES) {
      const keep = readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-500);
      writeFileSync(path, keep.join("\n") + "\n");
    }
  } catch {
    /* ignore */
  }
}

export function readLog(n: number, path = logPath()): LogEntry[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-n)
      .map((l) => JSON.parse(l) as LogEntry);
  } catch {
    return [];
  }
}

export function formatEntry(e: LogEntry): string {
  const t = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${t}  ${e.via.padEnd(4)} ${e.tier.padEnd(6)} (${e.source}) -> ${e.target ?? "none"}${e.note ? `  ${e.note}` : ""}`;
}
