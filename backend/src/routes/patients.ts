import { Hono } from 'hono';
import { z } from 'zod';
import { CLAIM_TTL_MS, RESET_TTL_MS, issueAccessCode } from '../codes';
import { audit, authenticate, requireMotherAccess, requireRole, requireVerifiedMember } from '../middleware';
import { hitRateLimit, rateLimited } from '../ratelimit';
import { readingRisk } from '../safety';
import type { AppEnv } from '../types';
import { HttpError, ISO_DATE, normalizeKePhone, now, parseBody, uuid } from '../util';

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
              (SELECT COUNT(*) FROM visits WHERE pregnancy_id = p.id AND deleted_at IS NULL) AS visit_count,
              (SELECT next_visit_date FROM visits WHERE pregnancy_id = p.id AND deleted_at IS NULL
                ORDER BY visit_date DESC, created_at DESC LIMIT 1) AS next_visit_date,
              (SELECT COUNT(*) FROM alerts al WHERE al.mother_id = m.id AND al.facility_id = cl.facility_id AND al.handled_at IS NULL) AS open_alerts,
              CASE WHEN u.password_hash LIKE 'pbkdf2$%' THEN 1 ELSE 0 END AS has_login,
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
              m.emergency_contact_name, m.emergency_contact_phone,
              CASE WHEN u.password_hash LIKE 'pbkdf2$%' THEN 1 ELSE 0 END AS has_login
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
  const { results: alertRows } = await db
    .prepare('SELECT id, level, symptoms_json, created_at, handled_at FROM alerts WHERE mother_id = ? AND facility_id = ? ORDER BY created_at DESC LIMIT 10')
    .bind(motherId, facilityId)
    .all<{ id: string; level: string; symptoms_json: string; created_at: number; handled_at: number | null }>();
  const alerts = alertRows.map((a) => ({ id: a.id, level: a.level, symptoms: JSON.parse(a.symptoms_json), created_at: a.created_at, handled_at: a.handled_at }));
  await audit(db, { actor: c.get('user').id, action: 'view_record', facilityId, motherId });
  return c.json({ profile, pregnancies, vitals, visits, medications, appointments, kick_counts: kicks, alerts });
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

// ---- A health worker registers a mother (she may have no phone or app) --------------------------------
// The mother gets a record, a care link to the facility and a pregnancy straight away. She can open her own
// account later with a one-time claim code. Her account cannot be signed in to until then: the placeholder
// email ends in @no-login.invalid and the password hash is not a valid hash.

const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

const registerSchema = z
  .object({
    facility_id: z.string().uuid(),
    full_name: z.string().trim().min(2).max(120),
    phone: z.string().max(20).optional(),
    date_of_birth: z.string().regex(ISO_DATE).optional(),
    blood_group: z.enum(BLOOD).optional(),
    emergency_contact_name: z.string().trim().max(80).optional(),
    emergency_contact_phone: z.string().max(20).optional(),
    lmp_date: z.string().regex(ISO_DATE).optional(),
    due_date: z.string().regex(ISO_DATE).optional(),
    consent: z.literal(true), // the health worker confirms the mother was told and agreed
  })
  .strict();

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Works out and sanity-checks the pregnancy dates. Returns { lmp, due }. */
function pregnancyDates(lmp?: string, due?: string): { lmp: string | null; due: string } {
  if (!lmp && !due) throw new HttpError(400, 'dates_required', 'Enter the last period date or the due date');
  const t = today();
  if (lmp && (lmp > t || lmp < addDays(t, -300))) throw new HttpError(400, 'invalid_date', 'Check the last period date');
  const dueDate = due ?? addDays(lmp as string, 280);
  if (dueDate < addDays(t, -30) || dueDate > addDays(t, 300)) throw new HttpError(400, 'invalid_date', 'Check the due date');
  return { lmp: lmp ?? null, due: dueDate };
}

function optionalPhone(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  const p = normalizeKePhone(v);
  if (!p) throw new HttpError(400, 'invalid_phone', 'Enter a valid Kenyan mobile number, e.g. 0712 345 678');
  return p;
}

patientRoutes.post('/patients', async (c) => {
  const db = c.env.DB;
  const staffId = c.get('user').id;
  const b = await parseBody(c, registerSchema);
  const staffRole = await requireVerifiedMember(db, staffId, b.facility_id);
  const phone = optionalPhone(b.phone);
  const ecPhone = optionalPhone(b.emergency_contact_phone);
  const { lmp, due } = pregnancyDates(b.lmp_date, b.due_date);

  if (phone) {
    const exists = await db.prepare('SELECT id FROM users WHERE phone = ?').bind(phone).first();
    if (exists) {
      throw new HttpError(409, 'already_registered', 'Someone is already registered with this number. Ask her to create a link code in My clinic.');
    }
  }

  const userId = uuid();
  const motherId = uuid();
  const pregnancyId = uuid();
  const t = now();
  await db.batch([
    db
      .prepare(`INSERT INTO users (id, role, email, phone, password_hash, full_name, created_at, updated_at) VALUES (?, 'mother', ?, ?, 'none', ?, ?, ?)`)
      .bind(userId, `proxy-${userId}@no-login.invalid`, phone, b.full_name, t, t),
    db
      .prepare(
        `INSERT INTO mothers (id, user_id, date_of_birth, blood_group, emergency_contact_name, emergency_contact_phone, registered_by, consent_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(motherId, userId, b.date_of_birth ?? null, b.blood_group ?? null, b.emergency_contact_name || null, ecPhone, staffId, t, t, t),
    db
      .prepare('INSERT INTO care_links (id, mother_id, facility_id, assigned_staff_user_id, granted_at) VALUES (?,?,?,?,?)')
      .bind(uuid(), motherId, b.facility_id, staffRole === 'doctor' ? staffId : null, t),
    db
      .prepare(`INSERT INTO pregnancies (id, mother_id, lmp_date, due_date, status, updated_at, server_updated_at) VALUES (?,?,?,?, 'active', ?, ?)`)
      .bind(pregnancyId, motherId, lmp, due, t, t),
  ]);
  await audit(db, { actor: staffId, action: 'register_mother', facilityId: b.facility_id, motherId, entity: 'mother', entityId: motherId });
  return c.json({ mother_id: motherId, pregnancy_id: pregnancyId }, 201);
});

const pregnancySchema = z.object({ lmp_date: z.string().regex(ISO_DATE).optional(), due_date: z.string().regex(ISO_DATE).optional() }).strict();

// Start a new pregnancy for an existing patient (only when she has no active one).
patientRoutes.post('/patients/:motherId/pregnancies', async (c) => {
  const db = c.env.DB;
  const motherId = c.req.param('motherId');
  const staffId = c.get('user').id;
  const facilityId = await requireMotherAccess(db, staffId, motherId);
  const b = await parseBody(c, pregnancySchema);
  const { lmp, due } = pregnancyDates(b.lmp_date, b.due_date);
  const active = await db.prepare(`SELECT id FROM pregnancies WHERE mother_id = ? AND status = 'active' AND deleted_at IS NULL`).bind(motherId).first();
  if (active) throw new HttpError(409, 'pregnancy_exists', 'This patient already has an active pregnancy');
  const id = uuid();
  const t = now();
  await db
    .prepare(`INSERT INTO pregnancies (id, mother_id, lmp_date, due_date, status, updated_at, server_updated_at) VALUES (?,?,?,?, 'active', ?, ?)`)
    .bind(id, motherId, lmp, due, t, t)
    .run();
  await audit(db, { actor: staffId, action: 'create_pregnancy', facilityId, motherId, entity: 'pregnancy', entityId: id });
  return c.json({ pregnancy_id: id }, 201);
});

// One-time code, handed over in person: "claim" opens an account for a mother registered by a health worker,
// "reset" lets a mother who has an account choose a new password.
patientRoutes.post('/patients/:motherId/access-code', async (c) => {
  const db = c.env.DB;
  const motherId = c.req.param('motherId');
  const staffId = c.get('user').id;
  const facilityId = await requireMotherAccess(db, staffId, motherId);
  if (await rateLimited(db, `issue:${staffId}`, 20, 60 * 60 * 1000)) throw new HttpError(429, 'too_many_attempts', 'Too many codes issued. Try again later.');
  await hitRateLimit(db, `issue:${staffId}`, 60 * 60 * 1000);
  const m = await db
    .prepare('SELECT u.id AS user_id, u.full_name, u.password_hash FROM mothers m JOIN users u ON u.id = m.user_id WHERE m.id = ?')
    .bind(motherId)
    .first<{ user_id: string; full_name: string; password_hash: string }>();
  if (!m) throw new HttpError(404, 'mother_not_found');
  const kind = m.password_hash.startsWith('pbkdf2$') ? 'reset' : 'claim';
  const { code, expiresAt } = await issueAccessCode(db, { userId: m.user_id, kind, createdBy: staffId, ttlMs: kind === 'claim' ? CLAIM_TTL_MS : RESET_TTL_MS });
  await audit(db, { actor: staffId, action: `issue_${kind}_code`, facilityId, motherId, entity: 'user', entityId: m.user_id });
  return c.json({ code, kind, expires_at: expiresAt, full_name: m.full_name });
});
