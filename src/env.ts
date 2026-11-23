import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Parse KEY=VALUE lines. Supports comments, `export`, and single/double quotes. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]!] = v;
  }
  return out;
}

/** $HROUTE_ENV, else ~/.config/herdr-router/.env. Never a project-local .env. */
export function envFilePath(): string {
  return (
    process.env.HROUTE_ENV ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "herdr-router", ".env")
  );
}

/** Load the env file into process.env. Variables already set in the real environment win. */
export function loadEnvFile(path = envFilePath(), target: NodeJS.ProcessEnv = process.env): string | null {
  if (!existsSync(path)) return null;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    if (target[k] === undefined) target[k] = v;
  }
  return path;
}

/** True when group/other can read the file (it holds a secret). */
export function isTooOpen(path: string): boolean {
  try {
    return (statSync(path).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}
