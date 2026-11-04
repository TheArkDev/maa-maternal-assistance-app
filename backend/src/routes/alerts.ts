import { Hono } from 'hono';
import { z } from 'zod';
import { audit, authenticate, getMotherId, requireRole, requireVerifiedMember } from '../middleware';
import { hitRateLimit, rateLimited } from '../ratelimit';
import { SYMPTOMS, assess } from '../safety';
import type { AppEnv } from '../types';
import { HttpError, now, parseBody, uuid } from '../util';

export const alertRoutes = new Hono<AppEnv>();

const sendSchema = z.object({ symptoms: z.array(z.enum(SYMPTOMS)).min(1).max(SYMPTOMS.length) });
const HOUR = 60 * 60 * 1000;

// A mother tells the clinic(s) she currently shares her record with that she has danger signs.
// The level is worked out HERE from the symptoms, never taken from the phone.
alertRoutes.post('/alerts', authenticate, requireRole('mother'), async (c) => {
  const db = c.env.DB;
  const motherId = await getMotherId(db, c.get('user').id);
  const { symptoms } = await parseBody(c, sendSchema);
  const result = assess({ symptoms });
  if (result.level === 'routine') throw new HttpError(400, 'no_danger_signs', 'These symptoms do not need an alert');

  const key = `alert:${motherId}`;
  if (await rateLimited(db, key, 6, HOUR)) throw new HttpError(429, 'too_many_attempts', 'You have sent several alerts. Please call your clinic.');
  await hitRateLimit(db, key, HOUR);

  const { results: links } = await db.prepare('SELECT facility_id FROM care_links WHERE mother_id = ? AND revoked_at IS NULL').bind(motherId).all<{ facility_id: string }>();
  if (links.length === 0) throw new HttpError(400, 'no_clinic', 'You are not sharing your record with a clinic yet');

  const t = now();
  await db.batch(
    links.map((l) =>
      db
        .prepare('INSERT INTO alerts (id, mother_id, facility_id, level, symptoms_json, reasons_json, created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(uuid(), motherId, l.facility_id, result.level, JSON.stringify(symptoms), JSON.stringify(result.reasons), t),
    ),
  );
  return c.json({ sent_to: links.length, level: result.level }, 201);
});

// Open alerts (default) or handled ones, for every facility the caller is a verified member of.
alertRoutes.get('/alerts', authenticate, requireRole('staff'), async (c) => {
  const status = c.req.query('status') === 'handled' ? 'handled' : 'open';
  const { results } = await c.env.DB
    .prepare(
      `SELECT al.id, al.facility_id, al.level, al.symptoms_json, al.reasons_json, al.created_at, al.handled_at,
              m.id AS mother_id, u.full_name, u.phone
         FROM alerts al
         JOIN mothers m ON m.id = al.mother_id
         JOIN users u ON u.id = m.user_id
         JOIN care_links cl ON cl.mother_id = al.mother_id AND cl.facility_id = al.facility_id AND cl.revoked_at IS NULL
         JOIN staff_memberships sm ON sm.facility_id = al.facility_id AND sm.user_id = ?1 AND sm.status = 'verified'
        WHERE (?2 = 'open' AND al.handled_at IS NULL) OR (?2 = 'handled' AND al.handled_at IS NOT NULL)
        ORDER BY CASE al.level WHEN 'emergency' THEN 0 ELSE 1 END, al.created_at DESC
        LIMIT 100`,
    )
    .bind(c.get('user').id, status)
    .all<{ id: string; facility_id: string; level: string; symptoms_json: string; reasons_json: string; created_at: number; handled_at: number | null; mother_id: string; full_name: string; phone: string | null }>();
  return c.json({
    alerts: results.map((r) => ({
      id: r.id,
      level: r.level,
      symptoms: JSON.parse(r.symptoms_json),
      reasons: JSON.parse(r.reasons_json),
      created_at: r.created_at,
      handled_at: r.handled_at,
      mother_id: r.mother_id,
      full_name: r.full_name,
      phone: r.phone,
    })),
  });
});

alertRoutes.post('/alerts/:id/handle', authenticate, requireRole('staff'), async (c) => {
  const db = c.env.DB;
  const a = await db.prepare('SELECT facility_id, mother_id, handled_at FROM alerts WHERE id = ?').bind(c.req.param('id')).first<{ facility_id: string; mother_id: string; handled_at: number | null }>();
  if (!a) throw new HttpError(404, 'alert_not_found');
  await requireVerifiedMember(db, c.get('user').id, a.facility_id);
  if (a.handled_at === null) {
    await db.prepare('UPDATE alerts SET handled_at = ?, handled_by = ? WHERE id = ?').bind(now(), c.get('user').id, c.req.param('id')).run();
    await audit(db, { actor: c.get('user').id, action: 'handle_alert', facilityId: a.facility_id, motherId: a.mother_id, entity: 'alert', entityId: c.req.param('id') });
  }
  return c.json({ ok: true });
});
