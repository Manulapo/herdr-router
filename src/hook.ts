import { classify, type Classification } from "./classify.ts";
import { planCandidates, type PlanContext } from "./plan.ts";
import type { Config } from "./types.ts";

/** Is the default Claude account still usable? Gates the Haiku classifier. */
export function claudeUsable(config: Config, ctx: PlanContext): boolean {
  const probe = { id: "claude", kind: "claude", account: "claude", args: [], env: {} };
  if (ctx.exhausted[probe.account]) return false;
  const u = ctx.usage(probe);
  return !(u && u.usedPercent >= config.defaultMaxUsed);
}

export function buildHint(config: Config, c: Classification, ctx: PlanContext): string | null {
  const first = planCandidates(config, c.tier, ctx).find((x) => !x.skip);
  if (!first) {
    return "hroute: every subscription is over its 5h threshold for this task. Keep the work small and tell the user routing is exhausted.";
  }
  const t = first.target;
  const why = `hroute classified this prompt as "${c.tier}" (${c.source}); best usable target: ${t.id}.`;
  if (t.kind === "claude") {
    const sessionHasIt = config.hook.sessionModel && t.model?.includes(config.hook.sessionModel);
    if (c.tier === config.defaultTier || sessionHasIt) return null;
    return `${why} Delegate it to the \`hr-${first.tier}\` subagent (Agent tool) unless it needs this conversation's context.`;
  }
  return (
    `${why} Claude is not the best fit right now. For lookups, analysis or review, run \`hsub ${first.tier} "<task>"\` ` +
    `and use its answer; do edits yourself.`
  );
}

/** UserPromptSubmit hook body: stdin JSON in, hook JSON (or null for "do nothing") out. Never throws. */
export async function hook(stdin: string, config: Config, ctx: PlanContext): Promise<string | null> {
  try {
    if (process.env.HROUTE_INNER) return null;
    const prompt = String(JSON.parse(stdin)?.prompt ?? "").trim();
    if (!prompt || prompt.startsWith("/")) return null;
    const c = await classify(prompt, config, undefined, {
      llm: config.hook.mode === "auto" && prompt.length >= config.hook.minChars,
      haikuAllowed: claudeUsable(config, ctx),
    });
    const additionalContext = buildHint(config, c, ctx);
    if (!additionalContext) return null;
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } });
  } catch {
    return null;
  }
}

// ---- installing the hooks into Claude Code's settings.json -----------------

const HOOK_CMD = "hroute hook";
const SYNC_CMD = "hroute sync-agents >/dev/null 2>&1";

/** Merge hroute's hooks into a settings object without touching anything else. Idempotent. */
export function mergeHooks(settings: any): { settings: any; changed: boolean } {
  const out = structuredClone(settings ?? {});
  out.hooks ??= {};
  let changed = false;
  const add = (event: string, command: string, timeout?: number) => {
    const groups: any[] = (out.hooks[event] ??= []);
    if (groups.some((g) => (g.hooks ?? []).some((h: any) => h.command === command))) return;
    groups.push({ hooks: [{ type: "command", command, ...(timeout ? { timeout } : {}) }] });
    changed = true;
  };
  add("UserPromptSubmit", HOOK_CMD, 20);
  add("SessionStart", SYNC_CMD);
  return { settings: out, changed };
}
