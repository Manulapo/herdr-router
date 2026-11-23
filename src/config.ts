import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseDuration } from "./duration.ts";
import { DEFAULT_LIMIT_PATTERNS } from "./limits.ts";
import type { Account, Config, Target } from "./types.ts";

export function configCandidates(): string[] {
  return [
    process.env.HROUTE_CONFIG,
    resolve("routing.toml"),
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-router", "routing.toml"),
  ].filter((p): p is string => Boolean(p));
}

export function findConfig(): string | null {
  return configCandidates().find((p) => existsSync(p)) ?? null;
}

/** Build the native `herdr agent start ... -- <args>` arguments for a target. */
export function buildArgs(kind: string, model?: string, effort?: string): string[] {
  const args: string[] = [];
  if (kind === "codex") {
    if (model) args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  } else if (model) {
    args.push("--model", model);
  }
  return args;
}

const expandHome = (v: string) => (v.startsWith("~/") ? join(homedir(), v.slice(2)) : v);

function parseEnv(raw: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) env[k] = expandHome(String(v));
  return env;
}

export function parseTarget(spec: unknown, accounts: Record<string, Account> = {}): Target {
  if (typeof spec === "string") {
    const [head, model, effort] = spec.split(":");
    if (!head) throw new Error(`Invalid target "${spec}" (expected account|kind[:model[:effort]])`);
    const acc = accounts[head];
    const kind = acc?.kind ?? head;
    return { id: spec, kind, account: head, model, effort, args: buildArgs(kind, model, effort), env: acc?.env ?? {}, maxUsed: acc?.maxUsed };
  }
  if (spec && typeof spec === "object") {
    const t = spec as Record<string, unknown>;
    const acc = typeof t.account === "string" ? accounts[t.account] : undefined;
    if (typeof t.account === "string" && !acc) throw new Error(`Unknown account "${t.account}"`);
    const kind = (typeof t.kind === "string" ? t.kind : acc?.kind) as string | undefined;
    if (!kind) throw new Error("Target table needs `kind` or `account`");
    const model = typeof t.model === "string" ? t.model : undefined;
    const effort = typeof t.effort === "string" ? t.effort : undefined;
    const account = typeof t.account === "string" ? t.account : kind;
    const args = Array.isArray(t.args) ? t.args.map(String) : buildArgs(kind, model, effort);
    const id = typeof t.id === "string" ? t.id : [account, model, effort].filter(Boolean).join(":");
    const maxUsed = typeof t.max_used === "number" ? t.max_used : acc?.maxUsed;
    return { id, kind, account, model, effort, args, env: { ...(acc?.env ?? {}), ...parseEnv(t.env) }, maxUsed };
  }
  throw new Error(`Invalid target: ${JSON.stringify(spec)}`);
}

export function parseConfig(toml: string): Config {
  const raw = Bun.TOML.parse(toml) as Record<string, any>;

  const accounts: Config["accounts"] = {};
  for (const [name, def] of Object.entries<any>(raw.accounts ?? {})) {
    if (typeof def?.kind !== "string") throw new Error(`Account "${name}" needs a string \`kind\``);
    accounts[name] = { name, kind: def.kind, env: parseEnv(def.env), maxUsed: typeof def.max_used === "number" ? def.max_used : undefined };
  }

  const tiers: Config["tiers"] = {};
  for (const [name, def] of Object.entries<any>(raw.tiers ?? {})) {
    if (!Array.isArray(def?.chain) || def.chain.length === 0) {
      throw new Error(`Tier "${name}" needs a non-empty \`chain\``);
    }
    tiers[name] = {
      chain: def.chain.map((t: unknown) => parseTarget(t, accounts)),
      fallbackTier: def.fallback_tier,
      strategy: def.strategy ?? "ordered",
      description: def.description,
      instructions: def.instructions,
    };
  }
  if (Object.keys(tiers).length === 0) throw new Error("Config defines no [tiers.*]");
  for (const [name, t] of Object.entries(tiers)) {
    if (t.strategy !== "ordered" && t.strategy !== "least-used") throw new Error(`Tier "${name}" strategy must be "ordered" or "least-used"`);
  }
  for (const [name, t] of Object.entries(tiers)) {
    if (t.fallbackTier && !tiers[t.fallbackTier]) throw new Error(`Tier "${name}" has unknown fallback_tier "${t.fallbackTier}"`);
  }

  const defaultTier: string = raw.default_tier ?? Object.keys(tiers)[0]!;
  if (!tiers[defaultTier]) throw new Error(`default_tier "${defaultTier}" is not a defined tier`);

  const rules = (raw.rules ?? []).map((r: any) => {
    if (!tiers[r.tier]) throw new Error(`Rule references unknown tier "${r.tier}"`);
    return { tier: r.tier as string, match: (r.match ?? []).map((m: string) => new RegExp(m, "i")) };
  });

  const mode = raw.classifier?.mode ?? "auto";
  if (!["rules", "jev", "haiku", "auto"].includes(mode)) throw new Error(`classifier.mode must be rules, jev, haiku or auto`);
  const hookMode = raw.hook?.mode ?? "auto";
  if (hookMode !== "auto" && hookMode !== "rules") throw new Error(`hook.mode must be "auto" or "rules"`);

  return {
    defaultTier,
    defaultCooldownMs: parseDuration(raw.default_cooldown ?? "2h"),
    defaultMaxUsed: Number(raw.default_max_used ?? 90),
    probeSeconds: Number(raw.probe_seconds ?? 10),
    classifier: {
      mode,
      jevModel: raw.classifier?.jev_model ?? "typesafe/jev-router",
      jevCostTier: raw.classifier?.jev_cost_tier ?? "low",
      haikuModel: raw.classifier?.haiku_model ?? "claude-haiku-5-5",
      timeoutMs: parseDuration(raw.classifier?.timeout ?? "15s"),
    },
    hook: {
      minChars: Number(raw.hook?.min_chars ?? 40),
      mode: hookMode,
      sessionModel: String(raw.hook?.session_model ?? ""),
      debug: raw.hook?.debug ?? false,
    },
    handoff: {
      enabled: raw.handoff?.enabled ?? true,
      maxChars: Number(raw.handoff?.max_chars ?? 2000),
      maxAgeMs: parseDuration(raw.handoff?.max_age ?? "24h"),
      minIntervalMs: parseDuration(raw.handoff?.min_interval ?? "2m"),
    },
    rules,
    accounts,
    tiers,
    limitPatterns: raw.limit_patterns
      ? (raw.limit_patterns as string[]).map((p) => new RegExp(p, "i"))
      : DEFAULT_LIMIT_PATTERNS,
  };
}

export function loadConfig(path = findConfig()): { config: Config; path: string } {
  if (!path) {
    throw new Error(
      `No routing.toml found. Run \`hroute init\` or set HROUTE_CONFIG. Searched:\n  ${configCandidates().join("\n  ")}`,
    );
  }
  return { config: parseConfig(readFileSync(path, "utf8")), path };
}
