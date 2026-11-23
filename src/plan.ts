import type { Exhaustion } from "./state.ts";
import type { Config, Target } from "./types.ts";
import type { Usage } from "./usage.ts";

export interface Candidate {
  /** Tier whose chain this target came from (differs after a fallback_tier hop). */
  tier: string;
  target: Target;
  skip?: string;
}

export interface PlanContext {
  exhausted: Record<string, Exhaustion>;
  usage: (t: Target) => Usage | null;
}

/**
 * Flatten a tier's chain, then its fallback_tier chain, marking targets that
 * are unusable right now (parked after a limit, or 5h usage over threshold).
 */
export function planCandidates(config: Config, tier: string, ctx: PlanContext): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (let t: string | undefined = tier; t && !seen.has(t); t = config.tiers[t]?.fallbackTier) {
    seen.add(t);
    for (const target of config.tiers[t]!.chain) {
      const parked = ctx.exhausted[target.account] ?? ctx.exhausted[target.id];
      let skip: string | undefined;
      if (parked) {
        skip = `parked until ${parked.until}`;
      } else {
        const u = ctx.usage(target);
        const max = target.maxUsed ?? config.defaultMaxUsed;
        if (u && u.usedPercent >= max) skip = `5h usage ${Math.round(u.usedPercent)}% >= ${max}%`;
      }
      out.push({ tier: t, target, skip });
    }
  }
  return out;
}
