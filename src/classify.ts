import type { Config } from "./types.ts";

export interface Classification {
  tier: string;
  source: "explicit" | "rule" | "jev" | "default";
  detail?: string;
}

export function classifyByRules(prompt: string, config: Config): Classification | null {
  for (const rule of config.rules) {
    const hit = rule.match.find((re) => re.test(prompt));
    if (hit) return { tier: rule.tier, source: "rule", detail: hit.source };
  }
  return null;
}

/** Pull the first known tier name out of a free-text answer. */
export function pickTier(answer: string, tiers: string[]): string | null {
  const lower = answer.toLowerCase();
  let best: { tier: string; at: number } | null = null;
  for (const tier of tiers) {
    const at = lower.search(new RegExp(`\\b${tier.toLowerCase()}\\b`));
    if (at >= 0 && (!best || at < best.at)) best = { tier, at };
  }
  return best?.tier ?? null;
}

/**
 * Ask Jev (OpenRouter) which tier fits the task. Optional: any failure falls
 * back to the default tier, so routing never blocks on the network.
 */
export async function classifyWithJev(
  prompt: string,
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<Classification | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const tiers = Object.keys(config.tiers);
  const input =
    `Classify this coding task into exactly one tier: ${tiers.join(", ")}.\n` +
    `plan = architecture, design, hard debugging, review. impl = normal implementation. quick = small mechanical work.\n` +
    `Reply with the tier name only.\n\nTask:\n${prompt.slice(0, 4000)}`;
  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.classifier.jevModel,
        plugins: [{ id: "jev-router", cost_tier: config.classifier.jevCostTier }],
        input,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const text: string = (data.output ?? [])
      .flatMap((o: any) => o.content ?? [])
      .map((c: any) => c.text ?? "")
      .join(" ");
    const tier = pickTier(text, tiers);
    return tier ? { tier, source: "jev", detail: data.model } : null;
  } catch {
    return null;
  }
}

export async function classify(prompt: string, config: Config, explicit?: string): Promise<Classification> {
  if (explicit) {
    if (!config.tiers[explicit]) {
      throw new Error(`Unknown tier "${explicit}". Defined: ${Object.keys(config.tiers).join(", ")}`);
    }
    return { tier: explicit, source: "explicit" };
  }
  const byRule = classifyByRules(prompt, config);
  if (byRule) return byRule;
  if (config.classifier.mode === "jev") {
    const byJev = await classifyWithJev(prompt, config);
    if (byJev) return byJev;
  }
  return { tier: config.defaultTier, source: "default" };
}
