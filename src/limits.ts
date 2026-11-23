/** Default signatures of a hit usage/rate limit in agent terminal output. */
export const DEFAULT_LIMIT_PATTERNS: RegExp[] = [
  /\b(usage|rate) limit (reached|exceeded|hit)\b/i,
  /\b5-hour limit reached\b/i,
  /you(?:'|’)ve hit your (?:usage )?limit/i,
  /\bout of (?:extra )?usage\b/i,
  /\bquota (?:exceeded|exhausted)\b/i,
  /\blimit will reset\b/i,
  /\bresource[_ ]exhausted\b/i,
  /you(?:'|’)ve reached your .{0,40}\blimit/i,
];

export function detectLimit(text: string, patterns: RegExp[]): string | null {
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[0];
  }
  return null;
}

/**
 * Best-effort extraction of when a limit resets. Handles:
 *   "resets 3pm", "resets at 3:30 PM", "try again at 15:00"
 *   "in 2 hours 10 minutes", "in 45 minutes"
 * Returns null when nothing recognisable is found.
 */
export function parseResetTime(text: string, now: Date = new Date()): Date | null {
  const rel = /\bin\s+(?:(\d+)\s*(?:hours?|hrs?|h)\b)?\s*(?:and\s+)?(?:(\d+)\s*(?:minutes?|mins?|m)\b)?/i.exec(text);
  if (rel && (rel[1] || rel[2])) {
    const ms = (Number(rel[1] ?? 0) * 60 + Number(rel[2] ?? 0)) * 6e4;
    if (ms > 0) return new Date(now.getTime() + ms);
  }

  const abs = /(?:resets?|try again|available again)(?:\s+(?:at|on))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (abs) {
    let hour = Number(abs[1]);
    const minute = Number(abs[2] ?? 0);
    const meridiem = abs[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  return null;
}
