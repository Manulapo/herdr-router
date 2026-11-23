const UNITS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };

/** Parse "90m", "5h", "1d", "30s" into milliseconds. */
export function parseDuration(input: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhd])\s*$/i.exec(input);
  if (!m) throw new Error(`Invalid duration "${input}" (use e.g. 30m, 5h, 1d)`);
  return Math.round(Number(m[1]) * UNITS[m[2]!.toLowerCase()]!);
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "now";
  const mins = Math.ceil(ms / 6e4);
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h}h${String(mins % 60).padStart(2, "0")}m` : `${mins}m`;
}
