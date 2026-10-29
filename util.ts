import type { Context } from 'hono';
import type { ZodTypeAny, z } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 429 | 500,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

export const now = (): number => Date.now();
export const uuid = (): string => crypto.randomUUID();

export async function parseBody<T extends ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(400, 'validation_error', 'Invalid request', result.error.flatten());
  }
  return result.data;
}

/** Normalise a Kenyan mobile number to +254XXXXXXXXX, or null if it is not one. */
export function normalizeKePhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, '');
  let national: string;
  if (/^\+254\d{9}$/.test(digits)) national = digits.slice(4);
  else if (/^254\d{9}$/.test(digits)) national = digits.slice(3);
  else if (/^0\d{9}$/.test(digits)) national = digits.slice(1);
  else if (/^\d{9}$/.test(digits)) national = digits;
  else return null;
  // Kenyan mobile ranges start with 7 or 1 (Safaricom, Airtel, Telkom, etc.)
  if (!/^[71]/.test(national)) return null;
  return `+254${national}`;
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
