// Fixed-window counters in D1. Good enough to stop password and code guessing; a Cloudflare
// rate-limiting rule in front of the Worker is still worth adding for volumetric abuse.
//
// FAIL OPEN: if the counter table is missing (a migration not applied yet) or D1 hiccups, these helpers
// log the problem and let the request through. A protective feature must never be able to take down
// sign-in for everyone. Apply migration 0004 to switch the protection on.

export const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** True when `key` has already used up its allowance in the current window (does not count). */
export async function rateLimited(db: D1Database, key: string, max: number, windowMs: number): Promise<boolean> {
  try {
    const row = await db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key).first<{ count: number; window_start: number }>();
    if (!row) return false;
    if (Date.now() - row.window_start > windowMs) return false;
    return row.count >= max;
  } catch (e) {
    console.error('rate limiter unavailable (is migration 0004 applied?)', e);
    return false;
  }
}

/** Counts one event against `key`, starting a fresh window when the old one has expired. */
export async function hitRateLimit(db: D1Database, key: string, windowMs: number): Promise<void> {
  try {
    const t = Date.now();
    await db
      .prepare(
        `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN ?2 - window_start > ?3 THEN 1 ELSE count + 1 END,
           window_start = CASE WHEN ?2 - window_start > ?3 THEN ?2 ELSE window_start END`,
      )
      .bind(key, t, windowMs)
      .run();
  } catch (e) {
    console.error('rate limiter unavailable (is migration 0004 applied?)', e);
  }
}

export async function clearRateLimit(db: D1Database, key: string): Promise<void> {
  try {
    await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
  } catch (e) {
    console.error('rate limiter unavailable (is migration 0004 applied?)', e);
  }
}
