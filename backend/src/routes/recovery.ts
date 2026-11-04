import { Hono } from 'hono';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth';
import { CLAIM_TTL_MS, RESET_TTL_MS, codeHash, issueAccessCode } from '../codes';
import { audit, authenticate, requirePlatformAdmin, requireRole, requireVerifiedMember } from '../middleware';
import { FIFTEEN_MINUTES, clearRateLimit, hitRateLimit, rateLimited } from '../ratelimit';
import type { AppEnv } from '../types';
import { HttpError, normalizeKePhone, now, parseBody } from '../util';
import { isUniqueError, issueTokens, resolveContact } from './auth';

export const recoveryRoutes = new Hono<AppEnv>();

const ip = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header('cf-connecting-ip') ?? 'local';
const PLACEHOLDER = /@no-login\.invalid$/;
const strongEnough = z.string().min(8).max(200);

const claimSchema = z.object({
  code: z.string().min(6).max(20),
  password: strongEnough,
  phone: z.string().max(20).optional(),
  email: z.string().email().max(200).optional(),
  accept_terms: z.boolean().optional(),
});

// A mother whom a health worker registered opens her own account with the code she was given in person.
recoveryRoutes.post('/auth/claim', async (c) => {
  const db = c.env.DB;
  const body = await parseBody(c, claimSchema);
  const ipKey = `claim:ip:${ip(c)}`;
  if (await rateLimited(db, ipKey, 20, FIFTEEN_MINUTES)) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again later.');

  const row = await db
    .prepare(
      `SELECT ac.id AS code_id, u.id AS user_id, u.role, u.full_name, u.email, u.phone, u.password_hash
         FROM access_codes ac JOIN users u ON u.id = ac.user_id
        WHERE ac.kind = 'claim' AND ac.code_hash = ? AND ac.used_at IS NULL AND ac.expires_at > ?`,
    )
    .bind(await codeHash(body.code), now())
    .first<{ code_id: string; user_id: string; role: 'mother' | 'staff'; full_name: string; email: string | null; phone: string | null; password_hash: string }>();
  if (!row || row.password_hash.startsWith('pbkdf2$')) {
    await hitRateLimit(db, ipKey, FIFTEEN_MINUTES);
    throw new HttpError(400, 'invalid_code', 'This code is invalid or has expired. Ask your clinic for a new one.');
  }

  // She needs a way to sign in: a phone or an email, her own or the one her clinic recorded.
  const given = resolveContact(body.email ?? undefined, body.phone ?? undefined, { required: false });
  const keptEmail = row.email && !PLACEHOLDER.test(row.email) ? row.email : null;
  const email = given.email ?? keptEmail;
  const phone = given.phone ?? row.phone;
  if (!email && !phone) throw new HttpError(400, 'contact_required', 'Add a phone number or an email so you can sign in');

  const t = now();
  try {
    await db.batch([
      db.prepare('UPDATE users SET email = ?, phone = ?, password_hash = ?, updated_at = ? WHERE id = ?').bind(email, phone, await hashPassword(body.password), t, row.user_id),
      db.prepare('UPDATE access_codes SET used_at = ? WHERE id = ?').bind(t, row.code_id),
      ...(body.accept_terms ? [db.prepare('UPDATE mothers SET consent_at = COALESCE(consent_at, ?) WHERE user_id = ?').bind(t, row.user_id)] : []),
    ]);
  } catch (e) {
    if (isUniqueError(e)) throw new HttpError(409, 'account_exists', 'Another account already uses this phone or email');
    throw e;
  }
  await audit(db, { actor: row.user_id, action: 'claim_account', entity: 'user', entityId: row.user_id });
  return c.json(await issueTokens(db, c.env.JWT_SECRET, { id: row.user_id, role: row.role, full_name: row.full_name }), 201);
});

const resetSchema = z.object({ identifier: z.string().min(3).max(200), code: z.string().min(6).max(20), new_password: strongEnough });

// Forgot your password? Your clinic gives you a one-time code in person.
recoveryRoutes.post('/auth/reset-password', async (c) => {
  const db = c.env.DB;
  const body = await parseBody(c, resetSchema);
  const ipKey = `reset:ip:${ip(c)}`;
  if (await rateLimited(db, ipKey, 30, FIFTEEN_MINUTES)) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again later.');

  const id = body.identifier.trim();
  const phone = normalizeKePhone(id);
  const user = await db
    .prepare('SELECT id, role, full_name FROM users WHERE email = ?1 OR (?2 IS NOT NULL AND phone = ?2)')
    .bind(id.toLowerCase(), phone)
    .first<{ id: string; role: 'mother' | 'staff'; full_name: string }>();
  const invalid = () => new HttpError(400, 'invalid_code', 'This code is invalid or has expired. Ask your clinic for a new one.');
  if (!user) {
    await hitRateLimit(db, ipKey, FIFTEEN_MINUTES);
    throw invalid();
  }
  const userKey = `reset:u:${user.id}`;
  if (await rateLimited(db, userKey, 6, FIFTEEN_MINUTES)) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Ask your clinic for a new code.');

  const row = await db
    .prepare(`SELECT id FROM access_codes WHERE user_id = ? AND kind = 'reset' AND code_hash = ? AND used_at IS NULL AND expires_at > ?`)
    .bind(user.id, await codeHash(body.code), now())
    .first<{ id: string }>();
  if (!row) {
    await hitRateLimit(db, userKey, FIFTEEN_MINUTES);
    await hitRateLimit(db, ipKey, FIFTEEN_MINUTES);
    throw invalid();
  }
  const t = now();
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(await hashPassword(body.new_password), t, user.id),
    db.prepare('UPDATE access_codes SET used_at = ? WHERE id = ?').bind(t, row.id),
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(t, user.id), // sign out every old session
  ]);
  await clearRateLimit(db, `login:u:${user.id}`);
  await clearRateLimit(db, userKey);
  await audit(db, { actor: user.id, action: 'reset_password', entity: 'user', entityId: user.id });
  return c.json(await issueTokens(db, c.env.JWT_SECRET, user));
});

const changeSchema = z.object({ current_password: z.string().min(1).max(200), new_password: strongEnough });

recoveryRoutes.post('/auth/change-password', authenticate, async (c) => {
  const db = c.env.DB;
  const { id } = c.get('user');
  const body = await parseBody(c, changeSchema);
  const key = `login:u:${id}`;
  if (await rateLimited(db, key, 8, FIFTEEN_MINUTES)) throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again in 15 minutes.');
  const user = await db.prepare('SELECT id, role, full_name, password_hash FROM users WHERE id = ?').bind(id).first<{ id: string; role: 'mother' | 'staff'; full_name: string; password_hash: string }>();
  if (!user || !(await verifyPassword(body.current_password, user.password_hash))) {
    await hitRateLimit(db, key, FIFTEEN_MINUTES);
    throw new HttpError(401, 'invalid_credentials', 'Your current password is incorrect');
  }
  const t = now();
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').bind(await hashPassword(body.new_password), t, id),
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').bind(t, id),
  ]);
  await clearRateLimit(db, key);
  await audit(db, { actor: id, action: 'change_password', entity: 'user', entityId: id });
  return c.json(await issueTokens(db, c.env.JWT_SECRET, user));
});

// ---- Team password resets -------------------------------------------------------------------------

// A facility administrator sees their team and can issue a reset code to a colleague in person.
recoveryRoutes.get('/staff/team', authenticate, requireRole('staff'), async (c) => {
  const uid = c.get('user').id;
  const { results } = await c.env.DB
    .prepare(
      `SELECT sm.id, sm.facility_id, f.name AS facility_name, sm.staff_role, sm.status, u.id AS user_id, u.full_name, u.phone, u.email
         FROM staff_memberships sm JOIN facilities f ON f.id = sm.facility_id JOIN users u ON u.id = sm.user_id
        WHERE sm.status IN ('verified','pending')
          AND sm.facility_id IN (SELECT facility_id FROM staff_memberships WHERE user_id = ?1 AND staff_role = 'facility_admin' AND status = 'verified')
        ORDER BY f.name, u.full_name`,
    )
    .bind(uid)
    .all<Record<string, unknown>>();
  return c.json({ team: results.map(({ user_id, ...rest }) => ({ ...rest, is_self: user_id === uid })) });
});

recoveryRoutes.post('/staff/team/:membershipId/reset-code', authenticate, requireRole('staff'), async (c) => {
  const db = c.env.DB;
  const uid = c.get('user').id;
  const m = await db
    .prepare(`SELECT sm.facility_id, sm.user_id, u.full_name FROM staff_memberships sm JOIN users u ON u.id = sm.user_id WHERE sm.id = ? AND sm.status IN ('verified','pending')`)
    .bind(c.req.param('membershipId'))
    .first<{ facility_id: string; user_id: string; full_name: string }>();
  if (!m) throw new HttpError(404, 'membership_not_found');
  const role = await requireVerifiedMember(db, uid, m.facility_id);
  if (role !== 'facility_admin') throw new HttpError(403, 'forbidden', 'Only a facility administrator can do this');
  if (m.user_id === uid) throw new HttpError(400, 'use_change_password', 'Use Change password for your own account');
  if (await rateLimited(db, `issue:${uid}`, 20, 60 * 60 * 1000)) throw new HttpError(429, 'too_many_attempts', 'Too many codes issued. Try again later.');
  await hitRateLimit(db, `issue:${uid}`, 60 * 60 * 1000);
  const { code, expiresAt } = await issueAccessCode(db, { userId: m.user_id, kind: 'reset', createdBy: uid, ttlMs: RESET_TTL_MS });
  await audit(db, { actor: uid, action: 'issue_reset_code', facilityId: m.facility_id, entity: 'user', entityId: m.user_id });
  return c.json({ code, expires_at: expiresAt, full_name: m.full_name });
});

// Last resort when a facility administrator is locked out: the platform admin issues the code.
recoveryRoutes.post('/admin/users/:userId/reset-code', authenticate, requirePlatformAdmin, async (c) => {
  const db = c.env.DB;
  const target = await db.prepare('SELECT id, full_name FROM users WHERE id = ?').bind(c.req.param('userId')).first<{ id: string; full_name: string }>();
  if (!target) throw new HttpError(404, 'user_not_found');
  const { code, expiresAt } = await issueAccessCode(db, { userId: target.id, kind: 'reset', createdBy: c.get('user').id, ttlMs: RESET_TTL_MS });
  await audit(db, { actor: c.get('user').id, action: 'admin_issue_reset_code', entity: 'user', entityId: target.id });
  return c.json({ code, expires_at: expiresAt, full_name: target.full_name });
});

export { CLAIM_TTL_MS };
