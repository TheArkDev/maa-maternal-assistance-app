import { Hono } from 'hono';
import { z } from 'zod';
import { audit, authenticate, getMotherId, requireRole, requireVerifiedMember } from '../middleware';
import type { AppEnv } from '../types';
import { HttpError, now, parseBody, uuid } from '../util';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I
const CODE_TTL_MS = 15 * 60 * 1000;

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => CODE_ALPHABET[b % 32]).join('');
}

export const careRoutes = new Hono<AppEnv>();

// ---- Mother side -------------------------------------------------------------

careRoutes.post('/care/join-code', authenticate, requireRole('mother'), async (c) => {
  const motherId = await getMotherId(c.env.DB, c.get('user').id);
  const code = newCode();
  const expiresAt = now() + CODE_TTL_MS;
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM join_codes WHERE mother_id = ? AND used_at IS NULL').bind(motherId),
    c.env.DB.prepare('INSERT INTO join_codes (code, mother_id, expires_at) VALUES (?,?,?)').bind(code, motherId, expiresAt),
  ]);
  return c.json({ code, expires_at: expiresAt });
});

careRoutes.get('/care/links', authenticate, requireRole('mother'), async (c) => {
  const motherId = await getMotherId(c.env.DB, c.get('user').id);
  const { results } = await c.env.DB
    .prepare(
      `SELECT cl.id, cl.facility_id, f.name AS facility_name, f.county, f.phone, cl.granted_at, cl.revoked_at,
              u.full_name AS assigned_staff_name
         FROM care_links cl
         JOIN facilities f ON f.id = cl.facility_id
         LEFT JOIN users u ON u.id = cl.assigned_staff_user_id
        WHERE cl.mother_id = ? ORDER BY cl.granted_at DESC`,
    )
    .bind(motherId)
    .all();
  return c.json({ links: results });
});

careRoutes.delete('/care/links/:id', authenticate, requireRole('mother'), async (c) => {
  const motherId = await getMotherId(c.env.DB, c.get('user').id);
  const r = await c.env.DB
    .prepare('UPDATE care_links SET revoked_at = ? WHERE id = ? AND mother_id = ? AND revoked_at IS NULL')
    .bind(now(), c.req.param('id'), motherId)
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'link_not_found', 'No active link found');
  await audit(c.env.DB, { actor: c.get('user').id, action: 'revoke_link', motherId, entity: 'care_link', entityId: c.req.param('id') });
  return c.json({ ok: true });
});

// ---- Staff side --------------------------------------------------------------

const redeemSchema = z.object({ code: z.string().min(6).max(12), facility_id: z.string().uuid() });

careRoutes.post('/care/redeem', authenticate, requireRole('staff'), async (c) => {
  const { code, facility_id } = await parseBody(c, redeemSchema);
  const staffId = c.get('user').id;
  const staffRole = await requireVerifiedMember(c.env.DB, staffId, facility_id);
  const t = now();
  const normalized = code.trim().toUpperCase();

  // Single-use claim: only one request can flip used_at from NULL.
  const claim = await c.env.DB
    .prepare('UPDATE join_codes SET used_at = ?1 WHERE code = ?2 AND used_at IS NULL AND expires_at > ?1')
    .bind(t, normalized)
    .run();
  if (!claim.meta.changes) throw new HttpError(400, 'invalid_code', 'This code is invalid or has expired');

  const jc = await c.env.DB.prepare('SELECT mother_id FROM join_codes WHERE code = ?').bind(normalized).first<{ mother_id: string }>();
  if (!jc) throw new HttpError(400, 'invalid_code');

  const assigned = staffRole === 'doctor' ? staffId : null;
  await c.env.DB
    .prepare('INSERT OR IGNORE INTO care_links (id, mother_id, facility_id, assigned_staff_user_id, granted_at) VALUES (?,?,?,?,?)')
    .bind(uuid(), jc.mother_id, facility_id, assigned, t)
    .run();
  await audit(c.env.DB, { actor: staffId, action: 'redeem_link', facilityId: facility_id, motherId: jc.mother_id, entity: 'care_link' });
  return c.json({ ok: true, mother_id: jc.mother_id });
});
