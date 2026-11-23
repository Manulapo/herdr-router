import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseDuration } from "./duration.ts";
import { DEFAULT_LIMIT_PATTERNS } from "./limits.ts";
import type { Config, Target } from "./types.ts";

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

export function parseTarget(spec: unknown): Target {
  if (typeof spec === "string") {
    const [kind, model, effort] = spec.split(":");
    if (!kind) throw new Error(`Invalid target "${spec}" (expected kind[:model[:effort]])`);
    return { id: spec, kind, model, effort, args: buildArgs(kind, model, effort) };
  }
  if (spec && typeof spec === "object") {
    const t = spec as Record<string, unknown>;
    if (typeof t.kind !== "string") throw new Error("Target table needs a string `kind`");
    const model = typeof t.model === "string" ? t.model : undefined;
    const effort = typeof t.effort === "string" ? t.effort : undefined;
    const args = Array.isArray(t.args) ? t.args.map(String) : buildArgs(t.kind, model, effort);
    const id = typeof t.id === "string" ? t.id : [t.kind, model, effort].filter(Boolean).join(":");
    return { id, kind: t.kind, model, effort, args };
  }
  throw new Error(`Invalid target: ${JSON.stringify(spec)}`);
}

export function parseConfig(toml: string): Config {
  const raw = Bun.TOML.parse(toml) as Record<string, any>;

  const tiers: Config["tiers"] = {};
  for (const [name, def] of Object.entries<any>(raw.tiers ?? {})) {
    if (!Array.isArray(def?.chain) || def.chain.length === 0) {
      throw new Error(`Tier "${name}" needs a non-empty \`chain\``);
    }
    tiers[name] = def.chain.map(parseTarget);
  }
  if (Object.keys(tiers).length === 0) throw new Error("Config defines no [tiers.*]");

  const defaultTier: string = raw.default_tier ?? Object.keys(tiers)[0]!;
  if (!tiers[defaultTier]) throw new Error(`default_tier "${defaultTier}" is not a defined tier`);

  const rules = (raw.rules ?? []).map((r: any) => {
    if (!tiers[r.tier]) throw new Error(`Rule references unknown tier "${r.tier}"`);
    return { tier: r.tier as string, match: (r.match ?? []).map((m: string) => new RegExp(m, "i")) };
  });

  const mode = raw.classifier?.mode ?? "rules";
  if (mode !== "rules" && mode !== "jev") throw new Error(`classifier.mode must be "rules" or "jev"`);

  return {
    defaultTier,
    defaultCooldownMs: parseDuration(raw.default_cooldown ?? "2h"),
    probeSeconds: Number(raw.probe_seconds ?? 10),
    classifier: {
      mode,
      jevModel: raw.classifier?.jev_model ?? "typesafe/jev-router",
      jevCostTier: raw.classifier?.jev_cost_tier ?? "low",
    },
    rules,
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
