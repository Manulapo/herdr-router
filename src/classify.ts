import type { Config } from "./types.ts";

export interface Classification {
  tier: string;
  source: "explicit" | "rule" | "jev" | "haiku" | "default";
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

function classificationInput(prompt: string, tiers: string[]): string {
  return (
    `Classify this coding task into exactly one tier: ${tiers.join(", ")}.\n` +
    `plan = architecture, design, hard debugging, review. impl = normal implementation. quick = small mechanical work.\n` +
    `Reply with the tier name only.\n\nTask:\n${prompt.slice(0, 4000)}`
  );
}

/**
 * Ask Jev (OpenRouter) which tier fits the task. Optional: any failure falls
 * back, so routing never blocks on the network.
 */
export async function classifyWithJev(
  prompt: string,
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<Classification | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  const tiers = Object.keys(config.tiers);
  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.classifier.jevModel,
        plugins: [{ id: "jev-router", cost_tier: config.classifier.jevCostTier }],
        input: classificationInput(prompt, tiers),
      }),
      signal: AbortSignal.timeout(config.classifier.timeoutMs),
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

/** Run a tiny headless Haiku call. HROUTE_INNER stops the hook from recursing into itself. */
export async function runHaiku(input: string, model: string, timeoutMs: number): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["claude", "-p", "--model", model, "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config", "--tools", "", "--setting-sources", "", input],
      { env: { ...process.env, HROUTE_INNER: "1" }, stdout: "pipe", stderr: "ignore", timeout: timeoutMs },
    );
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out : null;
  } catch {
    return null;
  }
}

export async function classifyWithHaiku(
  prompt: string,
  config: Config,
  run: (input: string, model: string, timeoutMs: number) => Promise<string | null> = runHaiku,
): Promise<Classification | null> {
  const tiers = Object.keys(config.tiers);
  const out = await run(classificationInput(prompt, tiers), config.classifier.haikuModel, config.classifier.timeoutMs);
  const tier = out ? pickTier(out, tiers) : null;
  return tier ? { tier, source: "haiku", detail: config.classifier.haikuModel } : null;
}

export interface ClassifyOptions {
  /** Allow LLM classification (Jev / Haiku). Default true. */
  llm?: boolean;
  /** False when the Claude account is parked or over threshold. Default true. */
  haikuAllowed?: boolean;
  fetchImpl?: typeof fetch;
  runHaikuImpl?: Parameters<typeof classifyWithHaiku>[2];
}

export async function classify(
  prompt: string,
  config: Config,
  explicit?: string,
  opts: ClassifyOptions = {},
): Promise<Classification> {
  if (explicit) {
    if (!config.tiers[explicit]) {
      throw new Error(`Unknown tier "${explicit}". Defined: ${Object.keys(config.tiers).join(", ")}`);
    }
    return { tier: explicit, source: "explicit" };
  }
  const byRule = classifyByRules(prompt, config);
  if (byRule) return byRule;

  const { mode } = config.classifier;
  if (opts.llm !== false && mode !== "rules") {
    const useJev = mode === "jev" || (mode === "auto" && Boolean(process.env.OPENROUTER_API_KEY));
    if (useJev) {
      const j = await classifyWithJev(prompt, config, opts.fetchImpl);
      if (j) return j;
    }
    // Jev replaces Haiku when a key is present; Haiku is also the fallback if Jev fails.
    if ((mode === "haiku" || mode === "auto") && opts.haikuAllowed !== false) {
      const h = await classifyWithHaiku(prompt, config, opts.runHaikuImpl);
      if (h) return h;
    }
  }
  return { tier: config.defaultTier, source: "default" };
}
