/** Seconds to wait from a Telegram FLOOD_WAIT error text, or null for other errors. */
export function parseFloodWait(err: unknown): number | null {
  const s = String(err);
  if (!s.includes('FLOOD_WAIT')) return null;
  const m = s.match(/\(value:\s*(\d+)\)/) ?? s.match(/FLOOD_WAIT_?(\d+)/);
  return m ? Math.min(Number(m[1]), 600) : 30;
}
