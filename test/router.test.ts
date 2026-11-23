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
    expect((await classify("design the billing architecture", cfg, undefined, { llm: false })).tier).toBe("plan");
    expect((await classify("fix typo", cfg, undefined, { llm: false })).tier).toBe("quick");
    expect((await classify("add pagination", cfg, undefined, { llm: false })).source).toBe("default");
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

import { classifyWithHaiku } from "../src/classify.ts";
import { buildHint, claudeUsable, hook, mergeHooks } from "../src/hook.ts";

const HK = parseConfig(`
[classifier]
mode = "auto"
[hook]
session_model = "sonnet"
[[rules]]
tier = "quick"
match = ["typo"]
[tiers.plan]
chain = ["claude:claude-sonnet-5-5", "codex:gpt-6.1-sol:high"]
[tiers.impl]
chain = ["claude:claude-sonnet-5-5", "codex:gpt-6.1-sol:medium"]
[tiers.quick]
chain = ["claude:claude-haiku-5-5", "codex:gpt-6-luna:low"]
`);
const ctx = { exhausted: {} as Record<string, any>, usage: none };

describe("classifier modes", () => {
  const saved = process.env.OPENROUTER_API_KEY;
  test("haiku answer is parsed; garbage falls back to default", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const ok = async () => "Quick\n";
    expect((await classifyWithHaiku("t", HK, ok))?.tier).toBe("quick");
    expect(await classifyWithHaiku("t", HK, async () => "no idea")).toBeNull();
    const c = await classify("do something long and ambiguous here", HK, undefined, { runHaikuImpl: async () => "plan" });
    expect(c).toMatchObject({ tier: "plan", source: "haiku" });
    expect((await classify("do something long and ambiguous here", HK, undefined, { runHaikuImpl: async () => null })).source).toBe("default");
  });
  test("with an OpenRouter key Jev replaces Haiku; Haiku still backs it up", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    let haikuCalled = false;
    const jev = (async () => new Response(JSON.stringify({ model: "m", output: [{ content: [{ text: "plan" }] }] }))) as unknown as typeof fetch;
    const c = await classify("long ambiguous prompt for the router", HK, undefined, { fetchImpl: jev, runHaikuImpl: async () => ((haikuCalled = true), "quick") });
    expect(c.source).toBe("jev");
    expect(haikuCalled).toBe(false);
    const down = (async () => new Response("x", { status: 503 })) as unknown as typeof fetch;
    expect((await classify("long ambiguous prompt for the router", HK, undefined, { fetchImpl: down, runHaikuImpl: async () => "quick" })).source).toBe("haiku");
    if (saved) process.env.OPENROUTER_API_KEY = saved; else delete process.env.OPENROUTER_API_KEY;
  });
  test("haikuAllowed=false and llm=false never call the LLM", async () => {
    const savedKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY; // a real key in the shell must not leak into this test
    const boom = async () => { throw new Error("should not run"); };
    expect((await classify("long ambiguous prompt for the router", HK, undefined, { haikuAllowed: false, runHaikuImpl: boom })).source).toBe("default");
    expect((await classify("long ambiguous prompt for the router", HK, undefined, { llm: false, runHaikuImpl: boom })).source).toBe("default");
    if (savedKey) process.env.OPENROUTER_API_KEY = savedKey;
  });
});

describe("hook", () => {
  const input = (prompt: string) => JSON.stringify({ prompt });
  test("light task -> subagent hint; default tier on Claude -> silence", async () => {
    const out = JSON.parse((await hook(input("fix the typo in the readme"), HK, ctx))!);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("hr-quick");
    expect(await hook(input("add pagination to the users endpoint please"), { ...HK, hook: { ...HK.hook, mode: "rules" } }, ctx)).toBeNull();
  });
  test("session model suppresses a pointless same-model subagent", () => {
    expect(buildHint(HK, { tier: "plan", source: "rule" }, ctx)).toBeNull();
  });
  test("Claude over threshold -> route to hsub on another agent", () => {
    const hot = (t: any) => (t.account === "claude" ? { usedPercent: 95, source: "t" } : null);
    const hint = buildHint(HK, { tier: "impl", source: "rule" }, { exhausted: {}, usage: hot })!;
    expect(hint).toContain('hsub impl');
    expect(hint).toContain("codex:gpt-6.1-sol:medium");
  });
  test("everything exhausted -> says so", () => {
    const all = () => ({ usedPercent: 99, source: "t" });
    expect(buildHint(HK, { tier: "impl", source: "rule" }, { exhausted: {}, usage: all })).toContain("exhausted");
  });
  test("ignores slash commands, empty input, junk, and the inner guard", async () => {
    expect(await hook(input("/model haiku"), HK, ctx)).toBeNull();
    expect(await hook("not json", HK, ctx)).toBeNull();
    expect(await hook(input(""), HK, ctx)).toBeNull();
    process.env.HROUTE_INNER = "1";
    expect(await hook(input("fix the typo"), HK, ctx)).toBeNull();
    delete process.env.HROUTE_INNER;
  });
  test("claudeUsable reflects parking and threshold", () => {
    expect(claudeUsable(HK, ctx)).toBe(true);
    expect(claudeUsable(HK, { exhausted: { claude: {} as any }, usage: none })).toBe(false);
    expect(claudeUsable(HK, { exhausted: {}, usage: () => ({ usedPercent: 91, source: "t" }) })).toBe(false);
  });
});

describe("install-hook merge", () => {
  test("adds both hooks, keeps existing settings, and is idempotent", () => {
    const first = mergeHooks({ model: "sonnet", hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } });
    expect(first.changed).toBe(true);
    expect(first.settings.model).toBe("sonnet");
    expect(first.settings.hooks.Stop).toHaveLength(2); // existing + hroute handoff
    expect(first.settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe("hroute hook");
    expect(mergeHooks(first.settings).changed).toBe(false);
  });
});

describe("least-used strategy", () => {
  const c = parseConfig(`
[tiers.impl]
strategy = "least-used"
chain = ["claude:s", "codex:m", "agy:g"]
`);
  const usage = (map: Record<string, number>) => (t: any) => (t.account in map ? { usedPercent: map[t.account]!, source: "t" } : null);
  const order = (u: any, exhausted = {}) => planCandidates(c, "impl", { exhausted, usage: u }).filter((x) => !x.skip).map((x) => x.target.account);
  test("lowest known usage first, unknown last", () => {
    expect(order(usage({ claude: 70, codex: 20 }))).toEqual(["codex", "claude", "agy"]);
    expect(order(usage({ claude: 10, codex: 20 }))).toEqual(["claude", "codex", "agy"]);
  });
  test("unknown usage keeps chain order after known ones", () => {
    expect(order(usage({ codex: 80 }))).toEqual(["codex", "claude", "agy"]);
  });
  test("over-threshold and parked still drop out", () => {
    expect(order(usage({ claude: 95, codex: 30 }))).toEqual(["codex", "agy"]);
    expect(order(usage({ claude: 5, codex: 30 }), { claude: {} })).toEqual(["codex", "agy"]);
  });
  test("rejects unknown strategy", () => {
    expect(() => parseConfig('[tiers.a]\nstrategy="random"\nchain=["claude"]')).toThrow();
  });
});

import { parseEnv, loadEnvFile } from "../src/env.ts";
import { writeFileSync } from "node:fs";

describe("env file", () => {
  test("parses comments, export, quotes and inline comments", () => {
    expect(parseEnv('# c\nA=1\nexport B="two words"\nC=\'x y\'\nD=val # note\nbad line\n')).toEqual({ A: "1", B: "two words", C: "x y", D: "val" });
  });
  test("real environment wins over the file", () => {
    const f = join(mkdtempSync(join(tmpdir(), "hroute-e-")), ".env");
    writeFileSync(f, "OPENROUTER_API_KEY=from-file\nOTHER=1\n");
    const target: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: "from-shell" };
    expect(loadEnvFile(f, target)).toBe(f);
    expect(target.OPENROUTER_API_KEY).toBe("from-shell");
    expect(target.OTHER).toBe("1");
    expect(loadEnvFile(join(tmpdir(), "nope.env"), {})).toBeNull();
  });
});

import { clearHandoff, extractTranscriptText, handoffPath, loadHandoff, parseSections, renderHandoff, saveHandoff, summarizerPrompt, updateHandoff, withHandoff } from "../src/handoff.ts";

describe("handoff", () => {
  const cfg = parseConfig('[handoff]\nmax_chars = 400\nmin_interval = "2m"\n[tiers.a]\nchain=["claude"]');
  const dir = mk(join(tmpdir(), "hroute-h-"));
  const note = { goal: "Add pagination to /users", done: ["handler in api/users.ts"], next: ["write tests"], decisions: ["cursor based"], updatedAt: new Date().toISOString(), cwd: "/proj" };

  test("round-trips and keeps one note per directory", () => {
    saveHandoff(note, 400, dir);
    expect(loadHandoff("/proj", dir)).toEqual(note);
    expect(loadHandoff("/other", dir)).toBeNull();
    expect(handoffPath("/proj", dir)).not.toBe(handoffPath("/other", dir));
    expect(clearHandoff("/proj", dir)).toBe(true);
  });
  test("stays under the cap, dropping old items but keeping Next", () => {
    const big = { ...note, done: Array.from({ length: 30 }, (_, i) => `finished step number ${i} in some file`), next: ["keep me"] };
    const out = renderHandoff(big, 400);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain("keep me");
    expect(out).toContain("step number 29"); // newest survives
    expect(out).not.toContain("step number 0 ");
  });
  test("parses model replies and rejects replies without a Goal", () => {
    expect(parseSections("## Goal\nShip it\n## Done\n- a\n- b\n## Next\n- c\n## Decisions\n- d")).toEqual({ goal: "Ship it", done: ["a", "b"], next: ["c"], decisions: ["d"] });
    expect(parseSections("sorry I cannot")).toBeNull();
  });
  test("transcript extraction keeps prose and tool names, drops tool results, keeps the newest text", () => {
    const j = [
      { type: "user", message: { role: "user", content: "add pagination" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it" }, { type: "tool_use", name: "Edit", input: { file_path: "api/users.ts" } }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "HUGE OUTPUT" }] } },
    ].map((x) => JSON.stringify(x)).join("\n") + "\nnot json";
    const t = extractTranscriptText(j, 10_000);
    expect(t).toContain("User: add pagination");
    expect(t).toContain("[Edit api/users.ts]");
    expect(t).not.toContain("HUGE OUTPUT");
    expect(extractTranscriptText(j, 20).length).toBeLessThanOrEqual(20);
  });
  test("update: rewrites via the model, throttles, and survives bad replies", async () => {
    const d = mk(join(tmpdir(), "hroute-h2-"));
    const good = async () => "## Goal\nShip pagination\n## Done\n- x\n## Next\n- y\n## Decisions\n- z";
    const now = new Date();
    expect(await updateHandoff({ cwd: "/p", convo: "User: hi", config: cfg, dir: d, run: good, now })).toBe("updated");
    expect(await updateHandoff({ cwd: "/p", convo: "User: hi", config: cfg, dir: d, run: good, now: new Date(now.getTime() + 30_000) })).toBe("throttled");
    expect(await updateHandoff({ cwd: "/p", convo: "User: hi", config: cfg, dir: d, run: async () => "garbage", now: new Date(now.getTime() + 3e5) })).toBe("bad-reply");
    expect(await updateHandoff({ cwd: "/p", convo: "User: hi", config: cfg, dir: d, run: async () => null, now: new Date(now.getTime() + 3e5) })).toBe("failed");
    expect(await updateHandoff({ cwd: "/p", convo: "  ", config: cfg, dir: d, run: good, now })).toBe("no-conversation");
    expect(loadHandoff("/p", d)?.goal).toBe("Ship pagination");
  });
  test("summarizer prompt carries the previous note and the cap", () => {
    expect(summarizerPrompt(note, "User: hi", 400)).toContain("Add pagination to /users");
    expect(summarizerPrompt(null, "User: hi", 400)).toContain("400 characters");
  });
  test("withHandoff prepends fresh notes only, and respects enabled=false", () => {
    const d = mk(join(tmpdir(), "hroute-h3-"));
    saveHandoff({ ...note, cwd: "/nogit-xyz" }, 400, d);
    const out = withHandoff("do the thing", "/nogit-xyz", cfg, d);
    expect(out).toContain("Add pagination to /users");
    expect(out.endsWith("do the thing")).toBe(true);
    expect(withHandoff("do the thing", "/nogit-xyz", cfg, d, new Date(Date.now() + 25 * 36e5))).toBe("do the thing");
    expect(withHandoff("x", "/none", cfg, d)).toBe("x");
    const off = parseConfig('[handoff]\nenabled = false\n[tiers.a]\nchain=["claude"]');
    expect(withHandoff("x", "/nogit-xyz", off, d)).toBe("x");
  });
  test("install-hook also registers the Stop hook", () => {
    expect(mergeHooks({}).settings.hooks.Stop[0].hooks[0].command).toBe("hroute handoff update --hook");
  });
});
