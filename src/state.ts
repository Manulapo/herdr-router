import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Exhaustion {
  until: string;
  reason: string;
  at: string;
}
export type State = { exhausted: Record<string, Exhaustion> };

export function statePath(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return process.env.HROUTE_STATE ?? join(base, "herdr-router", "state.json");
}

export function loadState(path = statePath(), now = new Date()): State {
  let state: State = { exhausted: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as State;
    if (raw && typeof raw.exhausted === "object") state = raw;
  } catch {
    /* missing or corrupt state is treated as empty */
  }
  for (const [id, e] of Object.entries(state.exhausted)) {
    if (new Date(e.until) <= now) delete state.exhausted[id];
  }
  return state;
}

export function saveState(state: State, path = statePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function markExhausted(id: string, until: Date, reason: string, path = statePath()): void {
  const state = loadState(path);
  state.exhausted[id] = { until: until.toISOString(), reason, at: new Date().toISOString() };
  saveState(state, path);
}

export function clearExhausted(id?: string, path = statePath()): void {
  const state = loadState(path);
  if (id) delete state.exhausted[id];
  else state.exhausted = {};
  saveState(state, path);
}
