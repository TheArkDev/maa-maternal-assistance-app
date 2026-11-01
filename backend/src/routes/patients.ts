import { Hono } from 'hono';
import { z } from 'zod';
import { audit, authenticate, requireMotherAccess, requireRole } from '../middleware';
import { readingRisk } from '../safety';
import type { AppEnv } from '../types';
import { HttpError, ISO_DATE, now, parseBody, uuid } from '../util';

export const patientRoutes = new Hono<AppEnv>();
patientRoutes.use('/patients/*', authenticate, requireRole('staff'));
patientRoutes.use('/patients', authenticate, requireRole('staff'));

// Patient list for every facility the caller is a verified member of, highest risk first.
patientRoutes.get('/patients', async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT m.id AS mother_id, u.full_name, u.phone, cl.facility_id, cl.assigned_staff_user_id,
              p.id AS pregnancy_id, p.due_date, p.lmp_date,
              (SELECT MAX(visit_date) FROM visits WHERE pregnancy_id = p.id AND deleted_at IS NULL) AS last_visit_date,
              (SELECT MIN(scheduled_at) FROM appointments
                WHERE pregnancy_id = p.id AND deleted_at IS NULL AND status = 'scheduled' AND scheduled_at >= ?2) AS next_appointment_at,
              (SELECT risk_flag FROM (
                 SELECT risk_flag, measured_at AS t FROM vitals
                  WHERE pregnancy_id = p.id AND deleted_at IS NULL AND risk_flag IS NOT NULL
                 UNION ALL
                 SELECT risk_flag, created_at AS t FROM visits
                  WHERE pregnancy_id = p.id AND deleted_at IS NULL AND risk_flag IS NOT NULL
               ) ORDER BY t DESC LIMIT 1) AS latest_risk
         FROM care_links cl
         JOIN staff_memberships sm ON sm.facility_id = cl.facility_id AND sm.user_id = ?1 AND sm.status = 'verified'
         JOIN mothers m ON m.id = cl.mother_id
         JOIN users u ON u.id = m.user_id
         LEFT JOIN pregnancies p ON p.id = (
              SELECT id FROM pregnancies WHERE mother_id = m.id AND status = 'active' AND deleted_at IS NULL
               ORDER BY updated_at DESC LIMIT 1)
        WHERE cl.revoked_at IS NULL
        ORDER BY CASE latest_risk WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, p.due_date`,
    )
    .bind(c.get('user').id, now())
    .all();
  return c.json({ patients: results });
});

patientRoutes.get('/patients/:motherId', async (c) => {
  const motherId = c.req.param('motherId');
  const db = c.env.DB;
  const facilityId = await requireMotherAccess(db, c.get('user').id, motherId);

  const profile = await db
    .prepare(
      `SELECT m.id, u.full_name, u.phone, m.date_of_birth, m.blood_group,
              m.emergency_contact_name, m.emergency_contact_phone
         FROM mothers m JOIN users u ON u.id = m.user_id WHERE m.id = ?`,
    )
    .bind(motherId)
    .first();
  const { results: pregnancies } = await db
    .prepare('SELECT id, lmp_date, due_date, status, gravida, parity FROM pregnancies WHERE mother_id = ? AND deleted_at IS NULL ORDER BY due_date DESC')
    .bind(motherId)
    .all<{ id: string }>();
  const active = pregnancies[0];
  let vitals: unknown[] = [], visits: unknown[] = [], medications: unknown[] = [], appointments: unknown[] = [], kicks: unknown[] = [];
  if (active) {
    const pid = active.id;
    vitals = (await db.prepare('SELECT * FROM vitals WHERE pregnancy_id = ? AND deleted_at IS NULL ORDER BY measured_at DESC LIMIT 30').bind(pid).all()).results;
    visits = (await db.prepare('SELECT * FROM visits WHERE pregnancy_id = ? AND deleted_at IS NULL ORDER BY visit_date DESC LIMIT 30').bind(pid).all()).results;
    medications = (await db.prepare('SELECT * FROM medications WHERE pregnancy_id = ? AND deleted_at IS NULL').bind(pid).all()).results;
    appointments = (await db.prepare('SELECT * FROM appointments WHERE pregnancy_id = ? AND deleted_at IS NULL ORDER BY scheduled_at DESC LIMIT 20').bind(pid).all()).results;
    kicks = (await db.prepare('SELECT * FROM kick_counts WHERE pregnancy_id = ? AND deleted_at IS NULL ORDER BY counted_at DESC LIMIT 10').bind(pid).all()).results;
  }
  await audit(db, { actor: c.get('user').id, action: 'view_record', facilityId, motherId });
  return c.json({ profile, pregnancies, vitals, visits, medications, appointments, kick_counts: kicks });
});

const num = (min: number, max: number) => z.number().min(min).max(max);
const visitSchema = z.object({
  id: z.string().uuid().optional(),
  pregnancy_id: z.string().uuid(),
  visit_date: z.string().regex(ISO_DATE),
  gestation_weeks: z.number().int().min(0).max(45).optional(),
  weight_kg: num(20, 250).optional(),
  systolic: z.number().int().min(50).max(300).optional(),
  diastolic: z.number().int().min(30).max(200).optional(),
  fundal_height_cm: num(0, 60).optional(),
  fetal_heart_rate: z.number().int().min(60).max(220).optional(),
  notes: z.string().max(4000).optional(),
  next_visit_date: z.string().regex(ISO_DATE).optional(),
});

async function requireOwnPregnancy(db: D1Database, motherId: string, pregnancyId: string) {
  const p = await db
    .prepare('SELECT id FROM pregnancies WHERE id = ? AND mother_id = ? AND deleted_at IS NULL')
    .bind(pregnancyId, motherId)
    .first();
  if (!p) throw new HttpError(404, 'pregnancy_not_found', 'Pregnancy not found for this patient');
}

patientRoutes.post('/patients/:motherId/visits', async (c) => {
  const motherId = c.req.param('motherId');
  const staffId = c.get('user').id;
  const facilityId = await requireMotherAccess(c.env.DB, staffId, motherId);
  const v = await parseBody(c, visitSchema);
  await requireOwnPregnancy(c.env.DB, motherId, v.pregnancy_id);
  const id = v.id ?? uuid();
  const t = now();
  const risk = readingRisk(v.systolic, v.diastolic);
  await c.env.DB
    .prepare(
      `INSERT INTO visits (id, pregnancy_id, facility_id, recorded_by, visit_date, gestation_weeks, weight_kg, systolic, diastolic,
                           fundal_height_cm, fetal_heart_rate, notes, next_visit_date, risk_flag, created_at, updated_at, server_updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(id, v.pregnancy_id, facilityId, staffId, v.visit_date, v.gestation_weeks ?? null, v.weight_kg ?? null, v.systolic ?? null,
      v.diastolic ?? null, v.fundal_height_cm ?? null, v.fetal_heart_rate ?? null, v.notes ?? null, v.next_visit_date ?? null, risk, t, t, t)
    .run();
  await audit(c.env.DB, { actor: staffId, action: 'create_visit', facilityId, motherId, entity: 'visit', entityId: id });
  return c.json({ id, risk_flag: risk }, 201);
});

const apptSchema = z.object({
  id: z.string().uuid().optional(),
  pregnancy_id: z.string().uuid(),
  scheduled_at: z.number().int().positive(),
  purpose: z.string().max(200).optional(),
});

patientRoutes.post('/patients/:motherId/appointments', async (c) => {
  const motherId = c.req.param('motherId');
  const staffId = c.get('user').id;
  const facilityId = await requireMotherAccess(c.env.DB, staffId, motherId);
  const a = await parseBody(c, apptSchema);
  await requireOwnPregnancy(c.env.DB, motherId, a.pregnancy_id);
  const id = a.id ?? uuid();
  const t = now();
  await c.env.DB
    .prepare(
      `INSERT INTO appointments (id, pregnancy_id, facility_id, scheduled_at, purpose, status, updated_at, server_updated_at)
       VALUES (?,?,?,?,?, 'scheduled', ?, ?)`,
    )
    .bind(id, a.pregnancy_id, facilityId, a.scheduled_at, a.purpose ?? null, t, t)
    .run();
  await audit(c.env.DB, { actor: staffId, action: 'create_appointment', facilityId, motherId, entity: 'appointment', entityId: id });
  return c.json({ id }, 201);
});

// ---- Editing a visit (medical report) ------------------------------------------------------------
// Only staff of the facility that recorded the visit, while it still holds an active care link, may
// edit it. The previous values are stored before every change, and each edit is audit-logged.

const EDITABLE = ['visit_date', 'gestation_weeks', 'weight_kg', 'systolic', 'diastolic', 'fundal_height_cm', 'fetal_heart_rate', 'notes', 'next_visit_date'] as const;

const visitPatchSchema = z
  .object({
    visit_date: z.string().regex(ISO_DATE).optional(),
    gestation_weeks: z.number().int().min(0).max(45).nullable().optional(),
    weight_kg: num(20, 250).nullable().optional(),
    systolic: z.number().int().min(50).max(300).nullable().optional(),
    diastolic: z.number().int().min(30).max(200).nullable().optional(),
    fundal_height_cm: num(0, 60).nullable().optional(),
    fetal_heart_rate: z.number().int().min(60).max(220).nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    next_visit_date: z.string().regex(ISO_DATE).nullable().optional(),
  })
  .strict();

async function loadVisitOfMother(db: D1Database, motherId: string, visitId: string): Promise<Record<string, unknown>> {
  const v = await db
    .prepare(
      `SELECT v.*, p.mother_id AS mother_id FROM visits v JOIN pregnancies p ON p.id = v.pregnancy_id
        WHERE v.id = ? AND v.deleted_at IS NULL`,
    )
    .bind(visitId)
    .first<Record<string, unknown>>();
  if (!v || v.mother_id !== motherId) throw new HttpError(404, 'visit_not_found', 'Visit not found for this patient');
  return v;
}

patientRoutes.patch('/patients/:motherId/visits/:visitId', async (c) => {
  const motherId = c.req.param('motherId');
  const visitId = c.req.param('visitId');
  const staffId = c.get('user').id;
  const db = c.env.DB;
  await requireMotherAccess(db, staffId, motherId);
  const v = await loadVisitOfMother(db, motherId, visitId);

  const own = await db
    .prepare(
      `SELECT 1 AS ok FROM care_links cl JOIN staff_memberships sm ON sm.facility_id = cl.facility_id
        WHERE cl.mother_id = ?1 AND cl.facility_id = ?2 AND cl.revoked_at IS NULL
          AND sm.user_id = ?3 AND sm.status = 'verified' LIMIT 1`,
    )
    .bind(motherId, v.facility_id, staffId)
    .first();
  if (!own) throw new HttpError(403, 'no_access', 'Only staff of the facility that recorded this visit can edit it');

  const patch = (await parseBody(c, visitPatchSchema)) as Record<string, unknown>;
  const keys = EDITABLE.filter((k) => k in patch);
  if (keys.length === 0) throw new HttpError(400, 'empty_patch', 'Nothing to change');

  const merged: Record<string, unknown> = { ...v };
  for (const k of keys) merged[k] = patch[k] ?? null;
  const sys = (merged.systolic as number | null) ?? null;
  const dia = (merged.diastolic as number | null) ?? null;
  if ((sys === null) !== (dia === null)) throw new HttpError(400, 'bp_incomplete', 'Enter both blood pressure numbers, or neither');
  const risk = readingRisk(sys, dia);

  const t = now();
  const previous = Object.fromEntries(EDITABLE.map((k) => [k, v[k] ?? null]));
  await db.batch([
    db
      .prepare('INSERT INTO visit_revisions (id, visit_id, edited_by, edited_at, previous_json) VALUES (?,?,?,?,?)')
      .bind(uuid(), visitId, staffId, t, JSON.stringify(previous)),
    db
      .prepare(`UPDATE visits SET ${keys.map((k) => `${k} = ?`).join(', ')}, risk_flag = ?, updated_at = ?, server_updated_at = ? WHERE id = ?`)
      .bind(...keys.map((k) => patch[k] ?? null), risk, t, t, visitId),
  ]);
  await audit(db, { actor: staffId, action: 'edit_visit', facilityId: v.facility_id as string, motherId, entity: 'visit', entityId: visitId });
  return c.json({ ok: true, risk_flag: risk });
});

patientRoutes.get('/patients/:motherId/visits/:visitId/revisions', async (c) => {
  const motherId = c.req.param('motherId');
  const visitId = c.req.param('visitId');
  const db = c.env.DB;
  await requireMotherAccess(db, c.get('user').id, motherId);
  await loadVisitOfMother(db, motherId, visitId);
  const { results } = await db
    .prepare(
      `SELECT r.id, r.edited_at, u.full_name AS edited_by_name, r.previous_json
         FROM visit_revisions r JOIN users u ON u.id = r.edited_by
        WHERE r.visit_id = ? ORDER BY r.edited_at DESC`,
    )
    .bind(visitId)
    .all<{ id: string; edited_at: number; edited_by_name: string; previous_json: string }>();
  return c.json({
    revisions: results.map((r) => ({ id: r.id, edited_at: r.edited_at, edited_by_name: r.edited_by_name, previous: JSON.parse(r.previous_json) })),
  });
});
