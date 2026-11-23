export class HerdrError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/** Run a herdr CLI command and return its parsed JSON output (or raw text). */
export function herdr(args: string[], opts: { allowFail?: boolean } = {}): any {
  const p = Bun.spawnSync(["herdr", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  const err = p.stderr.toString().trim();
  let json: any;
  try {
    json = out ? JSON.parse(out) : undefined;
  } catch {
    json = undefined;
  }
  if (p.exitCode !== 0 && !opts.allowFail) {
    const code = json?.error?.code as string | undefined;
    throw new HerdrError(json?.error?.message ?? (err || out || `herdr ${args[0]} failed`), code);
  }
  return json ?? out;
}

export const insideHerdr = (): boolean => process.env.HERDR_ENV === "1";

export function splitPane(cwd: string, direction: "right" | "down", env: Record<string, string> = {}): string {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
  const r = herdr(["pane", "split", "--current", "--direction", direction, "--cwd", cwd, "--no-focus", ...envArgs]);
  const id = r?.result?.pane?.pane_id;
  if (!id) throw new HerdrError("pane split returned no pane id");
  return id;
}

export function startAgent(name: string, kind: string, pane: string, args: string[]): void {
  herdr(["agent", "start", name, "--kind", kind, "--pane", pane, ...(args.length ? ["--", ...args] : [])]);
}

export function sendPrompt(name: string, text: string, timeoutMs: number): void {
  herdr(["agent", "prompt", name, text, "--wait", "--until", "working", "--timeout", String(timeoutMs)]);
}

export function readAgent(target: string, lines = 80): string {
  const r = herdr(["agent", "read", target, "--source", "recent", "--lines", String(lines), "--format", "text"], {
    allowFail: true,
  });
  return typeof r === "string" ? r : (r?.result?.text ?? JSON.stringify(r?.result ?? ""));
}

export function readPane(pane: string, lines = 80): string {
  const r = herdr(["pane", "read", pane, "--source", "recent", "--lines", String(lines), "--format", "text"], {
    allowFail: true,
  });
  return typeof r === "string" ? r : (r?.result?.text ?? JSON.stringify(r?.result ?? ""));
}

export function closePane(pane: string): void {
  herdr(["pane", "close", pane], { allowFail: true });
}

export function waitAgent(name: string, timeoutMs?: number): void {
  herdr(["agent", "wait", name, ...(timeoutMs ? ["--timeout", String(timeoutMs)] : [])], { allowFail: true });
}
