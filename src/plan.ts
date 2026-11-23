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
    const tierDef = config.tiers[t]!;
    const entries: (Candidate & { pct?: number })[] = [];
    for (const target of tierDef.chain) {
      const parked = ctx.exhausted[target.account] ?? ctx.exhausted[target.id];
      let skip: string | undefined;
      let pct: number | undefined;
      if (parked) {
        skip = `parked until ${parked.until}`;
      } else {
        const u = ctx.usage(target);
        pct = u?.usedPercent;
        const max = target.maxUsed ?? config.defaultMaxUsed;
        if (u && u.usedPercent >= max) skip = `5h usage ${Math.round(u.usedPercent)}% >= ${max}%`;
      }
      entries.push({ tier: t, target, skip, pct });
    }
    if (tierDef.strategy === "least-used") {
      const rank = (e: { skip?: string; pct?: number }) => (e.skip ? 2 : e.pct === undefined ? 1 : 0);
      // Array.sort is stable: ties and unknown-usage targets keep their chain order.
      entries.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? a.pct! - b.pct! : 0));
    }
    out.push(...entries.map(({ tier, target, skip }) => ({ tier, target, skip })));
  }
  return out;
}
