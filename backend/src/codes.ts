import { sha256Hex } from './auth';
import { now, uuid } from './util';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I; byte % 32 is unbiased

export type CodeKind = 'claim' | 'reset';

/** 10 characters from a 32-symbol alphabet = 50 bits. Shown as XXXXX-XXXXX. */
export function newAccessCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const chars = [...bytes].map((b) => ALPHABET[b % 32]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const codeHash = (code: string): Promise<string> => sha256Hex(normalizeCode(code));

/** Issues a fresh code and retires any earlier unused code of the same kind for that user. */
export async function issueAccessCode(
  db: D1Database,
  opts: { userId: string; kind: CodeKind; createdBy: string; ttlMs: number },
): Promise<{ code: string; expiresAt: number }> {
  const code = newAccessCode();
  const t = now();
  const expiresAt = t + opts.ttlMs;
  await db.batch([
    db.prepare('UPDATE access_codes SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL').bind(t, opts.userId, opts.kind),
    db
      .prepare('INSERT INTO access_codes (id, user_id, kind, code_hash, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(uuid(), opts.userId, opts.kind, await codeHash(code), expiresAt, opts.createdBy, t),
  ]);
  return { code, expiresAt };
}

export const CLAIM_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
export const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
