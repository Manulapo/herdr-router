export interface Target {
  /** Id used in logs and chains, e.g. "claude-work:sonnet". */
  id: string;
  kind: string;
  /** Subscription instance this target runs under (defaults to the kind). */
  account: string;
  model?: string;
  effort?: string;
  /** Native arguments passed after `--` to `herdr agent start`. */
  args: string[];
  /** Extra environment for the agent (e.g. CLAUDE_CONFIG_DIR, CODEX_HOME). */
  env: Record<string, string>;
  /** Skip this target once its 5h window is at least this % used. */
  maxUsed?: number;
}

export interface Account {
  name: string;
  kind: string;
  env: Record<string, string>;
  maxUsed?: number;
}

export interface Tier {
  chain: Target[];
  /** Simpler tier to fall into when everything in this chain is unavailable. */
  fallbackTier?: string;
  description?: string;
  instructions?: string;
}

export interface Rule {
  tier: string;
  match: RegExp[];
}

export interface Config {
  defaultTier: string;
  defaultCooldownMs: number;
  defaultMaxUsed: number;
  probeSeconds: number;
  classifier: {
    /** rules: regex only. jev / haiku: that LLM for unmatched prompts. auto: jev if OPENROUTER_API_KEY is set, else haiku. */
    mode: "rules" | "jev" | "haiku" | "auto";
    jevModel: string;
    jevCostTier: string;
    haikuModel: string;
    timeoutMs: number;
  };
  hook: {
    /** Prompts shorter than this skip the LLM classifier (rules still apply). */
    minChars: number;
    /** `rules` keeps the per-message hook instant and free. */
    mode: "auto" | "rules";
    /** Skip the subagent hint when the target model name contains this (session already runs it). */
    sessionModel: string;
  };
  rules: Rule[];
  accounts: Record<string, Account>;
  tiers: Record<string, Tier>;
  limitPatterns: RegExp[];
}
