import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, classifyWithJev, pickTier } from "../src/classify.ts";
import { buildArgs, parseConfig, parseTarget } from "../src/config.ts";
import { formatRemaining, parseDuration } from "../src/duration.ts";
import { DEFAULT_LIMIT_PATTERNS, detectLimit, parseResetTime } from "../src/limits.ts";
import { clearExhausted, loadState, markExhausted } from "../src/state.ts";

const TOML = await Bun.file(new URL("../routing.example.toml", import.meta.url)).text();

describe("config", () => {
  const cfg = parseConfig(TOML);
  test("example config parses", () => {
    expect(Object.keys(cfg.tiers)).toEqual(["plan", "impl", "quick"]);
    expect(cfg.defaultTier).toBe("impl");
  });
  test("target specs build native args", () => {
    expect(buildArgs("claude", "opus")).toEqual(["--model", "opus"]);
    expect(buildArgs("codex", "gpt-5.5", "high")).toEqual(["-m", "gpt-5.5", "-c", 'model_reasoning_effort="high"']);
    expect(parseTarget({ kind: "claude", model: "opus", args: ["--x"] }).args).toEqual(["--x"]);
  });
  test("rejects unknown default tier and empty chains", () => {
    expect(() => parseConfig('default_tier="x"\n[tiers.a]\nchain=["claude"]')).toThrow();
    expect(() => parseConfig("[tiers.a]\nchain=[]")).toThrow();
  });
});

describe("classification", () => {
  const cfg = parseConfig(TOML);
  test("explicit tier wins and is validated", async () => {
    expect((await classify("anything", cfg, "quick")).tier).toBe("quick");
    await expect(classify("x", cfg, "nope")).rejects.toThrow();
  });
  test("rules, then default", async () => {
    expect((await classify("design the billing architecture", cfg)).tier).toBe("plan");
    expect((await classify("fix typo", cfg)).tier).toBe("quick");
    expect((await classify("add pagination", cfg)).source).toBe("default");
  });
  test("pickTier takes the earliest known tier", () => {
    expect(pickTier("Tier: PLAN.", ["plan", "impl"])).toBe("plan");
    expect(pickTier("no idea", ["plan"])).toBeNull();
  });
  test("jev classifier parses a Responses API answer and degrades safely", async () => {
    process.env.OPENROUTER_API_KEY = "test";
    const ok = (async () =>
      new Response(JSON.stringify({ model: "x/y", output: [{ content: [{ type: "output_text", text: "quick" }] }] }))) as unknown as typeof fetch;
    expect((await classifyWithJev("t", cfg, ok))?.tier).toBe("quick");
    const bad = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    expect(await classifyWithJev("t", cfg, bad)).toBeNull();
    delete process.env.OPENROUTER_API_KEY;
    expect(await classifyWithJev("t", cfg)).toBeNull();
  });
});

describe("limit detection", () => {
  test("detects common messages", () => {
    for (const m of ["5-hour limit reached ∙ resets 3pm", "Claude usage limit reached.", "You've hit your usage limit", "Rate limit exceeded", "RESOURCE_EXHAUSTED: quota", "You've reached your daily limit"]) {
      expect(detectLimit(m, DEFAULT_LIMIT_PATTERNS)).not.toBeNull();
    }
    expect(detectLimit("refactoring the limiter module", DEFAULT_LIMIT_PATTERNS)).toBeNull();
  });
  test("parses absolute reset times", () => {
    const now = new Date(2026, 10, 23, 14, 0, 0);
    expect(parseResetTime("resets 3pm", now)?.getHours()).toBe(15);
    const next = parseResetTime("try again at 1:30 PM", now)!;
    expect(next.getDate()).toBe(24);
    expect(next.getHours()).toBe(13);
  });
  test("parses relative reset times", () => {
    const now = new Date(2026, 10, 23, 14, 0, 0);
    expect(parseResetTime("try again in 2 hours 10 minutes", now)!.getTime() - now.getTime()).toBe(130 * 6e4);
    expect(parseResetTime("nothing here", now)).toBeNull();
  });
});

describe("state", () => {
  const path = join(mkdtempSync(join(tmpdir(), "hroute-")), "state.json");
  test("parks, expires and clears targets", () => {
    markExhausted("a", new Date(Date.now() + 36e5), "t", path);
    markExhausted("b", new Date(Date.now() - 1000), "t", path);
    expect(Object.keys(loadState(path).exhausted)).toEqual(["a"]);
    clearExhausted("a", path);
    expect(loadState(path).exhausted).toEqual({});
  });
});

describe("duration", () => {
  test("parse and format", () => {
    expect(parseDuration("5h")).toBe(18e6);
    expect(() => parseDuration("soon")).toThrow();
    expect(formatRemaining(90 * 6e4)).toBe("1h30m");
  });
});

import { stripPrompt } from "../src/run.ts";
describe("prompt echo", () => {
  test("own prompt is not mistaken for a limit message", () => {
    const prompt = "fix the rate limit exceeded bug in the API";
    const screen = `> ${prompt}\nworking...`;
    expect(detectLimit(stripPrompt(screen, prompt), DEFAULT_LIMIT_PATTERNS)).toBeNull();
    expect(detectLimit(stripPrompt("5-hour limit reached", prompt), DEFAULT_LIMIT_PATTERNS)).not.toBeNull();
  });
});

import { mkdtempSync as mk } from "node:fs";
import { planCandidates } from "../src/plan.ts";
import { headlessCommand } from "../src/sub.ts";
import { renderAgent, GENERATED_MARK } from "../src/agents.ts";
import { normalizeUsage, parseCodexRateLimits, readClaudeUsage, writeClaudeUsage } from "../src/usage.ts";

const MULTI = `
default_max_used = 90
[accounts.claude-work]
kind = "claude"
env = { CLAUDE_CONFIG_DIR = "~/.claude-work" }
max_used = 80
[tiers.plan]
chain = ["claude:opus", "claude-work:opus", "codex:gpt-5.5"]
fallback_tier = "quick"
[tiers.quick]
chain = ["claude:haiku"]
`;
const none = () => null;

describe("accounts", () => {
  const cfg = parseConfig(MULTI);
  test("account targets carry env, kind and threshold", () => {
    const t = cfg.tiers.plan!.chain[1]!;
    expect(t.kind).toBe("claude");
    expect(t.account).toBe("claude-work");
    expect(t.env.CLAUDE_CONFIG_DIR.endsWith("/.claude-work")).toBe(true);
    expect(t.maxUsed).toBe(80);
    expect(cfg.tiers.plan!.chain[0]!.account).toBe("claude");
  });
  test("unknown fallback tier is rejected", () => {
    expect(() => parseConfig('[tiers.a]\nchain=["claude"]\nfallback_tier="zz"')).toThrow();
  });
});

describe("planning", () => {
  const cfg = parseConfig(MULTI);
  const ids = (c: ReturnType<typeof planCandidates>) => c.filter((x) => !x.skip).map((x) => x.target.id);
  test("everything usable: chain then fallback tier, in order", () => {
    expect(ids(planCandidates(cfg, "plan", { exhausted: {}, usage: none }))).toEqual(["claude:opus", "claude-work:opus", "codex:gpt-5.5", "claude:haiku"]);
  });
  test("over threshold skips only that account (per-account max_used)", () => {
    const usage = (t: any) => (t.account === "claude" ? { usedPercent: 91, source: "t" } : t.account === "claude-work" ? { usedPercent: 85, source: "t" } : null);
    const c = planCandidates(cfg, "plan", { exhausted: {}, usage });
    expect(c.find((x) => x.target.id === "claude:opus")!.skip).toContain("91%");
    expect(c.find((x) => x.target.id === "claude-work:opus")!.skip).toContain("80%");
    expect(ids(c)).toEqual(["codex:gpt-5.5"]);
  });
  test("parked account blocks all its models and tiers", () => {
    const exhausted = { claude: { until: "x", reason: "r", at: "x" } };
    expect(ids(planCandidates(cfg, "plan", { exhausted, usage: none }))).toEqual(["claude-work:opus", "codex:gpt-5.5"]);
  });
  test("fallback_tier cycles do not loop", () => {
    const c = parseConfig('[tiers.a]\nchain=["claude"]\nfallback_tier="b"\n[tiers.b]\nchain=["codex"]\nfallback_tier="a"');
    expect(planCandidates(c, "a", { exhausted: {}, usage: none })).toHaveLength(2);
  });
});

describe("usage sources", () => {
  const line = '{"rate_limits":{"limit_id":"codex","limit_name":null,"primary":{"used_percent":42.5,"window_minutes":300,"resets_at":1795386955},"secondary":{"used_percent":0.0,"window_minutes":10080,"resets_at":1795973755}}}';
  test("codex log: takes the last primary window", () => {
    expect(parseCodexRateLimits(`${line}\n${line.replace("42.5", "77.0")}`)).toEqual({ used: 77, resets: 1795386955 });
    expect(parseCodexRateLimits("nothing")).toBeNull();
  });
  test("a window that already reset reads 0%", () => {
    const now = new Date(1795390000 * 1000);
    expect(normalizeUsage(99, 1795386955, now, "x").usedPercent).toBe(0);
    expect(normalizeUsage(99, 1795390500, now, "x").usedPercent).toBe(99);
  });
  test("claude statusline sink round-trips and ignores payloads without rate_limits", () => {
    const dir = mk(join(tmpdir(), "hroute-u-"));
    const now = new Date(1795380000 * 1000);
    expect(writeClaudeUsage("a", JSON.stringify({ rate_limits: { five_hour: { used_percentage: 63, resets_at: 1795386955 } } }), now, dir)).toBe(true);
    expect(readClaudeUsage("a", now, dir)?.usedPercent).toBe(63);
    expect(writeClaudeUsage("b", '{"model":{}}', now, dir)).toBe(false);
    expect(readClaudeUsage("b", now, dir)).toBeNull();
  });
});

describe("hsub and subagents", () => {
  const cfg = parseConfig(MULTI);
  test("headless commands per kind", () => {
    const [opus, , codex] = cfg.tiers.plan!.chain;
    expect(headlessCommand(opus!, "t")).toEqual(["claude", "-p", "--model", "opus", "t"]);
    expect(headlessCommand(codex!, "t")).toEqual(["codex", "exec", "-m", "gpt-5.5", "t"]);
    expect(headlessCommand({ ...opus!, kind: "agy", args: ["--model", "m"] }, "t")).toEqual(["agy", "-p", "--model", "m", "t"]);
    expect(headlessCommand({ ...opus!, kind: "gemini" }, "t")).toBeNull();
  });
  test("subagent model follows live usage", () => {
    const hot = (t: any) => (t.account === "claude" ? { usedPercent: 95, source: "t" } : null);
    expect(renderAgent(cfg, "plan", { exhausted: {}, usage: none })).toContain("model: opus");
    const body = renderAgent(cfg, "plan", { exhausted: {}, usage: hot });
    expect(body).toContain("model: opus"); // claude-work:opus still has room
    expect(body).toContain(GENERATED_MARK);
    const allHot = () => ({ usedPercent: 99, source: "t" });
    expect(renderAgent(parseConfig('[tiers.q]\nchain=["claude:haiku"]'), "q", { exhausted: {}, usage: allHot })).not.toContain("model:");
  });
});
