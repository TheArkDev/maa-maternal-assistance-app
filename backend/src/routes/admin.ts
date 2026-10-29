import { Hono } from 'hono';
import { z } from 'zod';
import { audit, authenticate, requirePlatformAdmin } from '../middleware';
import type { AppEnv } from '../types';
import { HttpError, now, parseBody } from '../util';

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('/admin/facilities', authenticate, requirePlatformAdmin);
adminRoutes.use('/admin/facilities/:id/decision', authenticate, requirePlatformAdmin);

// Facilities awaiting a decision (default), or already verified / rejected.
adminRoutes.get('/admin/facilities', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  if (!['pending', 'verified', 'rejected'].includes(status)) throw new HttpError(400, 'invalid_status');
  const { results } = await c.env.DB
    .prepare(
      `SELECT f.id, f.name, f.mfl_code, f.county, f.phone, f.status, f.created_at,
              u.full_name AS founder_name, u.phone AS founder_phone, u.email AS founder_email,
              sm.registration_number AS founder_registration_number
         FROM facilities f
         LEFT JOIN staff_memberships sm ON sm.id = (
              SELECT id FROM staff_memberships
               WHERE facility_id = f.id AND staff_role = 'facility_admin' ORDER BY created_at LIMIT 1)
         LEFT JOIN users u ON u.id = sm.user_id
        WHERE f.status = ?
        ORDER BY f.created_at`,
    )
    .bind(status)
    .all();
  return c.json({ facilities: results });
});

const decisionSchema = z.object({ decision: z.enum(['approve', 'reject']) });

adminRoutes.post('/admin/facilities/:id/decision', async (c) => {
  const { decision } = await parseBody(c, decisionSchema);
  const id = c.req.param('id');
  const f = await c.env.DB.prepare('SELECT id FROM facilities WHERE id = ?').bind(id).first();
  if (!f) throw new HttpError(404, 'facility_not_found');
  const t = now();

  if (decision === 'approve') {
    // Verifies the facility and its founding administrator, who can then approve their own staff.
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE facilities SET verified = 1, status = 'verified' WHERE id = ?").bind(id),
      c.env.DB.prepare(
        `UPDATE staff_memberships SET status = 'verified', updated_at = ?2
          WHERE facility_id = ?1 AND staff_role = 'facility_admin' AND status = 'pending'`,
      ).bind(id, t),
    ]);
  } else {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE facilities SET verified = 0, status = 'rejected' WHERE id = ?").bind(id),
      c.env.DB.prepare("UPDATE staff_memberships SET status = 'rejected', updated_at = ?2 WHERE facility_id = ?1 AND status = 'pending'").bind(id, t),
    ]);
  }
  await audit(c.env.DB, { actor: c.get('user').id, action: `facility_${decision}`, facilityId: id, entity: 'facility', entityId: id });
  return c.json({ ok: true });
});
