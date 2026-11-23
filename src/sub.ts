import { planCandidates } from "./plan.ts";
import { detectLimit, parseResetTime } from "./limits.ts";
import { loadState, markExhausted } from "./state.ts";
import { getUsage } from "./usage.ts";
import type { Config, Target } from "./types.ts";
import type { Attempt } from "./run.ts";

/** Headless one-shot command for a target, or null when the kind has no known headless mode. */
export function headlessCommand(t: Target, task: string): string[] | null {
  if (t.kind === "claude") return ["claude", "-p", ...t.args, task];
  if (t.kind === "codex") return ["codex", "exec", ...t.args, task];
  if (t.kind === "agy") return ["agy", "-p", ...t.args, task];
  return null;
}

export interface SubResult {
  chosen: string | null;
  usedTier: string | null;
  output: string;
  exitCode: number;
  attempts: Attempt[];
}

/** Long answers that merely mention "rate limit" are not limit errors. */
const looksLikeLimitError = (code: number, out: string) => code !== 0 || out.length < 400;

/**
 * Run a task once, headlessly, on the first usable target of a tier.
 * This is the "fake subagent": works across Claude accounts and Codex.
 */
export async function runSub(
  config: Config,
  tier: string,
  task: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<SubResult> {
  const candidates = planCandidates(config, tier, { exhausted: loadState().exhausted, usage: (t) => getUsage(t) });
  const attempts: Attempt[] = [];

  for (const { tier: usedTier, target, skip } of candidates) {
    if (skip) {
      attempts.push({ target: target.id, outcome: "skipped", detail: skip });
      continue;
    }
    const cmd = headlessCommand(target, task);
    if (!cmd) {
      attempts.push({ target: target.id, outcome: "skipped", detail: `no headless mode for kind "${target.kind}"` });
      continue;
    }
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: { ...process.env, ...target.env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeoutMs,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const combined = `${stdout}\n${stderr}`;
    const hit = looksLikeLimitError(exitCode, stdout) ? detectLimit(combined, config.limitPatterns) : null;
    if (hit) {
      const until = parseResetTime(combined) ?? new Date(Date.now() + config.defaultCooldownMs);
      markExhausted(target.account, until, hit);
      attempts.push({ target: target.id, outcome: "limit", detail: `${hit} (until ${until.toISOString()})` });
      continue;
    }
    attempts.push({ target: target.id, outcome: exitCode === 0 ? "started" : "failed", detail: exitCode === 0 ? undefined : stderr.trim().slice(0, 200) });
    return { chosen: target.id, usedTier, output: stdout, exitCode, attempts };
  }
  return { chosen: null, usedTier: null, output: "", exitCode: 2, attempts };
}
