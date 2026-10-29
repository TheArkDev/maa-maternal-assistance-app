import { Hono } from 'hono';
import { z } from 'zod';
import { hashPassword, randomToken, sha256Hex, signJwt, verifyPassword } from '../auth';
import { authenticate } from '../middleware';
import type { AppEnv } from '../types';
import { HttpError, ISO_DATE, normalizeKePhone, now, parseBody, uuid } from '../util';

const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const contact = {
  email: z.string().email().max(200).optional(),
  phone: z.string().max(20).optional(),
};

const mothersSchema = z.object({
  full_name: z.string().min(2).max(120),
  password: z.string().min(8).max(200),
  date_of_birth: z.string().regex(ISO_DATE).optional(),
  ...contact,
});

const staffSchema = z.object({
  full_name: z.string().min(2).max(120),
  password: z.string().min(8).max(200),
  staff_role: z.enum(['doctor', 'nurse', 'chw', 'facility_admin']),
  registration_number: z.string().min(2).max(60).optional(),
  facility_id: z.string().uuid().optional(),
  new_facility: z
    .object({
      name: z.string().min(2).max(160),
      mfl_code: z.string().max(20).optional(),
      county: z.string().max(60).optional(),
      phone: z.string().max(20).optional(),
    })
    .optional(),
  ...contact,
});

const loginSchema = z.object({ identifier: z.string().min(3).max(200), password: z.string().min(1).max(200) });
const refreshSchema = z.object({ refresh_token: z.string().min(10).max(200) });

function resolveContact(email?: string, phone?: string) {
  const e = email?.trim().toLowerCase() || null;
  let p: string | null = null;
  if (phone?.trim()) {
    p = normalizeKePhone(phone);
    if (!p) throw new HttpError(400, 'invalid_phone', 'Enter a valid Kenyan mobile number, e.g. 0712 345 678');
  }
  if (!e && !p) throw new HttpError(400, 'contact_required', 'Provide a phone number or an email address');
  return { email: e, phone: p };
}

async function issueTokens(db: D1Database, secret: string, user: { id: string; role: 'mother' | 'staff'; full_name: string }) {
  const accessToken = await signJwt({ sub: user.id, role: user.role }, secret, ACCESS_TTL_SECONDS);
  const refreshToken = randomToken(32);
  await db
    .prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,?)')
    .bind(uuid(), user.id, await sha256Hex(refreshToken), now() + REFRESH_TTL_MS, now())
    .run();
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: ACCESS_TTL_SECONDS,
    user: { id: user.id, role: user.role, full_name: user.full_name },
  };
}

function isUniqueError(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/auth/register/mother', async (c) => {
  const body = await parseBody(c, mothersSchema);
  const { email, phone } = resolveContact(body.email, body.phone);
  const userId = uuid();
  const t = now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO users (id, role, email, phone, password_hash, full_name, created_at, updated_at)
         VALUES (?, 'mother', ?, ?, ?, ?, ?, ?)`,
      ).bind(userId, email, phone, await hashPassword(body.password), body.full_name.trim(), t, t),
      c.env.DB.prepare(
        `INSERT INTO mothers (id, user_id, date_of_birth, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(uuid(), userId, body.date_of_birth ?? null, t, t),
    ]);
  } catch (e) {
    if (isUniqueError(e)) throw new HttpError(409, 'account_exists', 'An account with this phone or email already exists');
    throw e;
  }
  return c.json(await issueTokens(c.env.DB, c.env.JWT_SECRET, { id: userId, role: 'mother', full_name: body.full_name.trim() }), 201);
});

authRoutes.post('/auth/register/staff', async (c) => {
  const body = await parseBody(c, staffSchema);
  const { email, phone } = resolveContact(body.email, body.phone);
  if (!!body.facility_id === !!body.new_facility) {
    throw new HttpError(400, 'facility_required', 'Provide either facility_id or new_facility (not both)');
  }
  if ((body.staff_role === 'doctor' || body.staff_role === 'nurse') && !body.registration_number) {
    throw new HttpError(400, 'registration_required', 'Doctors and nurses must provide their professional registration number');
  }
  const t = now();
  const userId = uuid();
  let facilityId = body.facility_id ?? uuid();
  // A person who founds a facility is its administrator, pending platform verification.
  const staffRole = body.new_facility ? 'facility_admin' : body.staff_role;

  if (body.facility_id) {
    const f = await c.env.DB.prepare('SELECT verified FROM facilities WHERE id = ?').bind(body.facility_id).first<{ verified: number }>();
    if (!f) throw new HttpError(404, 'facility_not_found', 'Facility not found');
    if (!f.verified) throw new HttpError(400, 'facility_unverified', 'This facility has not been verified yet');
  }

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO users (id, role, email, phone, password_hash, full_name, created_at, updated_at)
       VALUES (?, 'staff', ?, ?, ?, ?, ?, ?)`,
    ).bind(userId, email, phone, await hashPassword(body.password), body.full_name.trim(), t, t),
  ];
  if (body.new_facility) {
    const nf = body.new_facility;
    stmts.push(
      c.env.DB.prepare(`INSERT INTO facilities (id, name, mfl_code, county, phone, verified, created_at) VALUES (?,?,?,?,?,0,?)`)
        .bind(facilityId, nf.name.trim(), nf.mfl_code?.trim() || null, nf.county?.trim() || null, nf.phone?.trim() || null, t),
    );
  }
  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO staff_memberships (id, user_id, facility_id, staff_role, registration_number, status, created_at, updated_at)
       VALUES (?,?,?,?,?, 'pending', ?, ?)`,
    ).bind(uuid(), userId, facilityId, staffRole, body.registration_number?.trim() || null, t, t),
  );

  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    if (isUniqueError(e)) throw new HttpError(409, 'account_exists', 'An account, phone, email or facility code already exists');
    throw e;
  }
  const tokens = await issueTokens(c.env.DB, c.env.JWT_SECRET, { id: userId, role: 'staff', full_name: body.full_name.trim() });
  return c.json({ ...tokens, membership: { facility_id: facilityId, staff_role: staffRole, status: 'pending' } }, 201);
});

// A fixed, valid hash so unknown-user logins cost the same as known-user logins.
const DUMMY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

authRoutes.post('/auth/login', async (c) => {
  const { identifier, password } = await parseBody(c, loginSchema);
  const id = identifier.trim();
  const phone = normalizeKePhone(id);
  const user = await c.env.DB
    .prepare('SELECT id, role, full_name, password_hash FROM users WHERE email = ?1 OR (?2 IS NOT NULL AND phone = ?2)')
    .bind(id.toLowerCase(), phone)
    .first<{ id: string; role: 'mother' | 'staff'; full_name: string; password_hash: string }>();
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'Incorrect phone/email or password');
  return c.json(await issueTokens(c.env.DB, c.env.JWT_SECRET, user));
});

authRoutes.post('/auth/refresh', async (c) => {
  const { refresh_token } = await parseBody(c, refreshSchema);
  const hash = await sha256Hex(refresh_token);
  const row = await c.env.DB
    .prepare(
      `SELECT rt.id AS rt_id, u.id, u.role, u.full_name
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = ? AND rt.revoked_at IS NULL AND rt.expires_at > ?`,
    )
    .bind(hash, now())
    .first<{ rt_id: string; id: string; role: 'mother' | 'staff'; full_name: string }>();
  if (!row) throw new HttpError(401, 'invalid_refresh_token', 'Please sign in again');
  await c.env.DB.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').bind(now(), row.rt_id).run();
  return c.json(await issueTokens(c.env.DB, c.env.JWT_SECRET, row));
});

authRoutes.post('/auth/logout', async (c) => {
  const { refresh_token } = await parseBody(c, refreshSchema);
  await c.env.DB.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .bind(now(), await sha256Hex(refresh_token))
    .run();
  return c.json({ ok: true });
});

authRoutes.get('/me', authenticate, async (c) => {
  const { id, role } = c.get('user');
  const u = await c.env.DB.prepare('SELECT id, role, full_name, email, phone FROM users WHERE id = ?').bind(id).first();
  if (!u) throw new HttpError(404, 'user_not_found');
  if (role === 'mother') {
    const m = await c.env.DB.prepare('SELECT id, date_of_birth, blood_group, emergency_contact_name, emergency_contact_phone FROM mothers WHERE user_id = ?').bind(id).first();
    return c.json({ user: u, mother: m });
  }
  const { results } = await c.env.DB
    .prepare(
      `SELECT sm.id, sm.facility_id, f.name AS facility_name, sm.staff_role, sm.status
         FROM staff_memberships sm JOIN facilities f ON f.id = sm.facility_id WHERE sm.user_id = ?`,
    )
    .bind(id)
    .all();
  return c.json({ user: u, memberships: results });
});
