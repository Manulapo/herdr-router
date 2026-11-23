import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { syncAgents } from "./agents.ts";
import { configCandidates, findConfig, loadConfig } from "./config.ts";
import { envFilePath } from "./env.ts";
import { mergeHooks } from "./hook.ts";
import { loadState } from "./state.ts";
import { getUsage } from "./usage.ts";

export type StepState = "done" | "would" | "already" | "manual" | "skipped";
export interface Step {
  name: string;
  state: StepState;
  detail: string;
}

const SINK = (account: string) => `echo "$input" | hroute usage-sink ${account} >/dev/null 2>&1 &`;

/** Insert the usage-sink line after `input=$(cat)` in a statusLine command. Null when it cannot be done safely. */
export function patchStatusline(command: string, account = "claude"): { command: string; changed: boolean } | null {
  if (command.includes("usage-sink")) return { command, changed: false };
  const re = /input=\$\(cat\)(?:\s*;\s*|\s+)/;
  if (!re.test(command)) return null;
  return { command: command.replace(re, `input=$(cat); ${SINK(account)} `), changed: true };
}

export interface SetupOptions {
  /** Apply the changes. Without it, setup only reports what it would do. */
  apply: boolean;
  /** Create PATH symlinks when `hroute` is not found. */
  link?: boolean;
  /** Where the CLI scripts live (for the symlinks). */
  binDir?: string;
}

const claudeSettingsPath = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json");

function backup(file: string): void {
  if (!existsSync(file)) return;
  const first = `${file}.pre-hroute`;
  copyFileSync(file, existsSync(first) ? `${file}.bak` : first);
}

export function runSetup(o: SetupOptions): Step[] {
  const steps: Step[] = [];
  const act = (name: string, detail: string, doit: () => void) => {
    if (!o.apply) return steps.push({ name, state: "would", detail });
    doit();
    steps.push({ name, state: "done", detail });
  };

  // 1. Config + env file
  const cfgPath = findConfig();
  if (cfgPath) steps.push({ name: "config", state: "already", detail: cfgPath });
  else {
    const dest = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-router", "routing.toml");
    act("config", `create ${dest} from routing.example.toml`, () => {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(new URL("../routing.example.toml", import.meta.url), dest);
    });
  }
  const envPath = envFilePath();
  if (existsSync(envPath)) steps.push({ name: "env file", state: "already", detail: envPath });
  else
    act("env file", `create ${envPath} (chmod 600) from .env.example`, () => {
      mkdirSync(dirname(envPath), { recursive: true });
      copyFileSync(new URL("../.env.example", import.meta.url), envPath);
      chmodSync(envPath, 0o600);
    });

  // 2. PATH
  if (Bun.which("hroute") && Bun.which("hsub")) steps.push({ name: "PATH", state: "already", detail: "hroute and hsub found" });
  else if (o.link === false || !o.binDir) steps.push({ name: "PATH", state: "manual", detail: "put bin/hroute.ts and bin/hsub.ts on PATH (see docs/getting-started.md)" });
  else {
    const dir = join(homedir(), ".local", "bin");
    act("PATH", `symlink hroute and hsub into ${dir} (make sure it is on PATH)`, () => {
      mkdirSync(dir, { recursive: true });
      for (const n of ["hroute", "hsub"]) {
        const link = join(dir, n);
        if (!existsSync(link)) symlinkSync(join(o.binDir!, `${n}.ts`), link);
      }
    });
  }

  // 3 + 4. Claude Code settings: statusline usage line and hooks
  const settingsFile = claudeSettingsPath();
  let settings: any = {};
  try {
    settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : {};
  } catch {
    steps.push({ name: "Claude settings", state: "manual", detail: `${settingsFile} is not valid JSON; fix it, then re-run` });
    return steps;
  }
  let dirty = false;

  const sl = settings.statusLine?.command as string | undefined;
  if (!sl) steps.push({ name: "usage line", state: "manual", detail: "no statusLine command configured; add `" + SINK("claude") + "` after `input=$(cat)` in yours" });
  else {
    const patched = patchStatusline(sl);
    if (!patched) steps.push({ name: "usage line", state: "manual", detail: "statusLine has no `input=$(cat)`; add `" + SINK("claude") + "` where the JSON is read" });
    else if (!patched.changed) steps.push({ name: "usage line", state: "already", detail: "statusLine already records usage" });
    else {
      steps.push({ name: "usage line", state: o.apply ? "done" : "would", detail: "record Claude's 5h usage from the statusline" });
      if (o.apply) {
        settings.statusLine.command = patched.command;
        dirty = true;
      }
    }
  }

  const merged = mergeHooks(settings);
  if (!merged.changed) steps.push({ name: "hooks", state: "already", detail: "UserPromptSubmit, SessionStart and Stop are installed" });
  else {
    steps.push({ name: "hooks", state: o.apply ? "done" : "would", detail: "add UserPromptSubmit, SessionStart and Stop hooks (existing hooks kept)" });
    if (o.apply) {
      settings = merged.settings;
      dirty = true;
    }
  }
  if (dirty) {
    backup(settingsFile);
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  }

  // 5. Subagents
  try {
    const { config } = loadConfig();
    const agentsDir = join(dirname(settingsFile), "agents");
    if (o.apply) {
      const r = syncAgents(config, { exhausted: loadState().exhausted, usage: (t) => getUsage(t) }, agentsDir);
      steps.push({ name: "subagents", state: "done", detail: `${r.filter((x) => x.action === "written").length} written in ${agentsDir}` });
    } else steps.push({ name: "subagents", state: "would", detail: `generate hr-<tier>.md in ${agentsDir}` });
  } catch (e) {
    steps.push({ name: "subagents", state: "skipped", detail: `needs a valid config first (${(e as Error).message.split("\n")[0]})` });
  }
  return steps;
}

const ICON: Record<StepState, string> = { done: "ok    ", would: "would ", already: "ok    ", manual: "TODO  ", skipped: "skip  " };
export const formatStep = (s: Step) => `${ICON[s.state]} ${s.name.padEnd(12)} ${s.detail}`;
