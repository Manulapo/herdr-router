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
    for (const m of ["5-hour limit reached ∙ resets 3pm", "Claude usage limit reached.", "You've hit your usage limit", "Rate limit exceeded"]) {
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
