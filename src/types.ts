export interface Target {
  /** Stable id used in state and logs, e.g. "claude:opus". */
  id: string;
  /** Herdr agent kind (claude, codex, gemini, ...). */
  kind: string;
  model?: string;
  effort?: string;
  /** Native arguments passed after `--` to `herdr agent start`. */
  args: string[];
}

export interface Rule {
  tier: string;
  match: RegExp[];
}

export interface Config {
  defaultTier: string;
  defaultCooldownMs: number;
  probeSeconds: number;
  classifier: { mode: "rules" | "jev"; jevModel: string; jevCostTier: string };
  rules: Rule[];
  tiers: Record<string, Target[]>;
  limitPatterns: RegExp[];
}
