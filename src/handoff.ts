import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runHaiku } from "./classify.ts";
import { formatRemaining } from "./duration.ts";
import { statePath } from "./state.ts";
import type { Config } from "./types.ts";

export interface Handoff {
  goal: string;
  done: string[];
  next: string[];
  decisions: string[];
  updatedAt: string;
  cwd: string;
}

const LIST_KEYS = ["done", "next", "decisions"] as const;

export function handoffDir(): string {
  return join(dirname(statePath()), "handoff");
}

/** One note per working directory, so switching agents in the same repo shares it. */
export function handoffPath(cwd: string, dir = handoffDir()): string {
  return join(dir, `${createHash("sha1").update(cwd).digest("hex").slice(0, 12)}.md`);
}

export function renderHandoff(h: Handoff, maxChars: number): string {
  const copy = { ...h, done: [...h.done], next: [...h.next], decisions: [...h.decisions] };
  const render = () =>
    [
      `<!-- hroute-handoff updated=${copy.updatedAt} cwd=${copy.cwd} -->`,
      "## Goal",
      copy.goal,
      ...LIST_KEYS.flatMap((k) => [`## ${k[0]!.toUpperCase()}${k.slice(1)}`, ...copy[k].map((i) => `- ${i}`)]),
      "",
    ].join("\n");
  // Stay under the cap by dropping the oldest items first, never the Next list.
  while (render().length > maxChars && (copy.done.length > 1 || copy.decisions.length > 1)) {
    (copy.done.length >= copy.decisions.length ? copy.done : copy.decisions).shift();
  }
  let out = render();
  if (out.length > maxChars) {
    copy.goal = copy.goal.slice(0, Math.max(40, copy.goal.length - (out.length - maxChars)));
    out = render().slice(0, maxChars);
  }
  return out;
}

const clean = (s: string) => s.trim().replace(/^[-*]\s+/, "");

/** Parse either the stored file or the model's reply: `## Goal|Done|Next|Decisions` sections. */
export function parseSections(text: string): Pick<Handoff, "goal" | "done" | "next" | "decisions"> | null {
  const parts = text.split(/^##\s+/m).slice(1);
  const sections: Record<string, string[]> = {};
  for (const p of parts) {
    const [head, ...body] = p.split("\n");
    sections[head!.trim().toLowerCase()] = body.map(clean).filter(Boolean);
  }
  if (!sections.goal || !sections.goal.length) return null;
  return {
    goal: sections.goal.join(" "),
    done: sections.done ?? [],
    next: sections.next ?? [],
    decisions: sections.decisions ?? [],
  };
}

export function loadHandoff(cwd: string, dir = handoffDir()): Handoff | null {
  try {
    const text = readFileSync(handoffPath(cwd, dir), "utf8");
    const meta = /<!-- hroute-handoff updated=(\S+) cwd=(.*?) -->/.exec(text);
    const body = parseSections(text);
    return meta && body ? { ...body, updatedAt: meta[1]!, cwd: meta[2]! } : null;
  } catch {
    return null;
  }
}

export function saveHandoff(h: Handoff, maxChars: number, dir = handoffDir()): void {
  const path = handoffPath(h.cwd, dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, renderHandoff(h, maxChars));
  renameSync(`${path}.tmp`, path); // atomic: a reader never sees a half-written note
}

export function clearHandoff(cwd: string, dir = handoffDir()): boolean {
  const path = handoffPath(cwd, dir);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// ---- reading a Claude Code transcript (JSONL) ------------------------------

/** Compact conversation text: user/assistant prose and one-line tool calls, newest `maxChars` kept. */
export function extractTranscriptText(jsonl: string, maxChars: number): string {
  const lines: string[] = [];
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    const role = o.message?.role ?? o.type;
    if (role !== "user" && role !== "assistant") continue;
    const content = o.message?.content;
    const parts: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const p of parts) {
      if (p.type === "text" && p.text?.trim()) lines.push(`${role === "user" ? "User" : "Assistant"}: ${p.text.trim().slice(0, 1500)}`);
      else if (p.type === "tool_use") {
        const target = p.input?.file_path ?? p.input?.command ?? p.input?.pattern ?? "";
        lines.push(`[${p.name} ${String(target).slice(0, 120)}]`);
      }
    }
  }
  return lines.join("\n").slice(-maxChars);
}

export function summarizerPrompt(prev: Handoff | null, convo: string, maxChars: number): string {
  return [
    "You maintain a handoff note so a DIFFERENT AI coding agent can continue this work with no other context.",
    "REWRITE the note from the previous note plus the recent conversation. Do not append: merge, dedupe, drop what is finished or stale.",
    `Hard limit ${maxChars} characters. Terse facts only: file paths, function names, exact decisions and why. No pleasantries.`,
    "Reply with EXACTLY these sections and nothing else (max 6 bullets each, Goal is one sentence):",
    "## Goal\n## Done\n## Next\n## Decisions",
    prev ? `\nPREVIOUS NOTE:\n${renderHandoff(prev, maxChars)}` : "\nPREVIOUS NOTE: (none)",
    `\nRECENT CONVERSATION:\n${convo}`,
  ].join("\n");
}

export interface UpdateOptions {
  cwd: string;
  convo: string;
  config: Config;
  dir?: string;
  run?: (input: string, model: string, timeoutMs: number) => Promise<string | null>;
  now?: Date;
  force?: boolean;
}

export type UpdateResult = "updated" | "throttled" | "no-conversation" | "bad-reply" | "failed";

/** Ask Haiku to rewrite the note. Throttled so a Stop hook on every turn stays cheap. */
export async function updateHandoff(o: UpdateOptions): Promise<UpdateResult> {
  const { handoff } = o.config;
  const now = o.now ?? new Date();
  const prev = loadHandoff(o.cwd, o.dir);
  if (!o.convo.trim()) return "no-conversation";
  if (!o.force && prev && now.getTime() - new Date(prev.updatedAt).getTime() < handoff.minIntervalMs) return "throttled";
  const out = await (o.run ?? runHaiku)(summarizerPrompt(prev, o.convo, handoff.maxChars), o.config.classifier.haikuModel, 90_000);
  if (!out) return "failed";
  const parsed = parseSections(out);
  if (!parsed) return "bad-reply";
  saveHandoff({ ...parsed, updatedAt: now.toISOString(), cwd: o.cwd }, handoff.maxChars, o.dir);
  return "updated";
}

// ---- feeding the note to the next agent ------------------------------------

/** Live repo facts, read at handoff time so they are never stale. Empty outside git. */
export function gitFacts(cwd: string): string {
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : "";
  };
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (!branch) return "";
  const changed = git("status", "--porcelain").split("\n").filter(Boolean);
  const stat = git("diff", "--stat", "HEAD").split("\n").pop() ?? "";
  const files = changed.slice(0, 12).map((l) => l.trim()).join(", ");
  return `branch ${branch}; ${changed.length} changed file(s)${files ? `: ${files}` : ""}${stat ? ` (${stat.trim()})` : ""}`;
}

/** Prepend the note (if any, fresh enough) to a prompt. Returns the prompt unchanged otherwise. */
export function withHandoff(prompt: string, cwd: string, config: Config, dir?: string, now = new Date()): string {
  if (!config.handoff.enabled) return prompt;
  const h = loadHandoff(cwd, dir);
  if (!h) return prompt;
  const age = now.getTime() - new Date(h.updatedAt).getTime();
  if (age > config.handoff.maxAgeMs) return prompt;
  const facts = gitFacts(cwd);
  return [
    `[Handoff from the previous agent in this directory, updated ${formatRemaining(age)} ago. Background only: verify against the repo before relying on it.]`,
    renderHandoff(h, config.handoff.maxChars).replace(/^<!--.*-->\n/, "").trim(),
    ...(facts ? [`## Working tree (live)\n${facts}`] : []),
    "[End of handoff]",
    "",
    prompt,
  ].join("\n");
}
