import { Hono } from 'hono';
import { z } from 'zod';
import { authenticate, requireRole, requireVerifiedMember } from '../middleware';
import type { AppEnv } from '../types';
import { HttpError, parseBody, safeEqual } from '../util';

export const facilityRoutes = new Hono<AppEnv>();

// Public: verified facilities only (used by registration and the mother's facility picker).
facilityRoutes.get('/facilities', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const county = (c.req.query('county') ?? '').trim();
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, name, mfl_code, county, phone, latitude, longitude FROM facilities
        WHERE verified = 1
          AND (?1 = '' OR name LIKE '%' || ?1 || '%')
          AND (?2 = '' OR county = ?2)
        ORDER BY name LIMIT 50`,
    )
    .bind(q, county)
    .all();
  return c.json({ facilities: results });
});

// Platform admin only: verify a facility and its founding administrator.
facilityRoutes.post('/admin/facilities/:id/verify', async (c) => {
  const key = c.req.header('x-admin-key') ?? '';
  if (!c.env.ADMIN_API_KEY || !safeEqual(key, c.env.ADMIN_API_KEY)) throw new HttpError(403, 'forbidden', 'Admin key required');
  const id = c.req.param('id');
  const f = await c.env.DB.prepare('SELECT id FROM facilities WHERE id = ?').bind(id).first();
  if (!f) throw new HttpError(404, 'facility_not_found');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE facilities SET verified = 1 WHERE id = ?').bind(id),
    c.env.DB.prepare(
      `UPDATE staff_memberships SET status = 'verified', updated_at = ?2
        WHERE facility_id = ?1 AND staff_role = 'facility_admin' AND status = 'pending'`,
    ).bind(id, Date.now()),
  ]);
  return c.json({ ok: true });
});

// ---- Facility admins manage their own staff ---------------------------------

const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']) });

facilityRoutes.get('/staff/memberships/pending', authenticate, requireRole('staff'), async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT sm.id, sm.facility_id, f.name AS facility_name, sm.staff_role, sm.registration_number,
              u.full_name, u.phone, u.email, sm.created_at
         FROM staff_memberships sm
         JOIN facilities f ON f.id = sm.facility_id
         JOIN users u ON u.id = sm.user_id
        WHERE sm.status = 'pending'
          AND sm.facility_id IN (SELECT facility_id FROM staff_memberships
                                  WHERE user_id = ? AND staff_role = 'facility_admin' AND status = 'verified')
        ORDER BY sm.created_at`,
    )
    .bind(c.get('user').id)
    .all();
  return c.json({ pending: results });
});

facilityRoutes.post('/staff/memberships/:id/decision', authenticate, requireRole('staff'), async (c) => {
  const { decision } = await parseBody(c, decisionSchema);
  const m = await c.env.DB
    .prepare('SELECT facility_id, status FROM staff_memberships WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ facility_id: string; status: string }>();
  if (!m) throw new HttpError(404, 'membership_not_found');
  const role = await requireVerifiedMember(c.env.DB, c.get('user').id, m.facility_id);
  if (role !== 'facility_admin') throw new HttpError(403, 'forbidden', 'Only a facility administrator can do this');
  await c.env.DB
    .prepare('UPDATE staff_memberships SET status = ?, updated_at = ? WHERE id = ?')
    .bind(decision === 'approve' ? 'verified' : 'rejected', Date.now(), c.req.param('id'))
    .run();
  return c.json({ ok: true });
});
