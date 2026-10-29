// Offline-first sync for mother-owned data.
//   POST /sync/push  : client sends rows changed locally; last-write-wins on updated_at.
//   GET  /sync/pull  : client fetches rows changed on the server since a cursor
//                      (including staff-written visits and clinic-scheduled appointments).
// The server never trusts ownership fields from the payload: mother_id comes from the token,
// and every pregnancy_id must belong to that mother.

import { Hono } from 'hono';
import { z } from 'zod';
import { authenticate, getMotherId, requireRole } from '../middleware';
import { readingRisk } from '../safety';
import type { AppEnv } from '../types';
import { HttpError, ISO_DATE, now, parseBody } from '../util';

const base = {
  id: z.string().uuid(),
  updated_at: z.number().int().positive(),
  deleted_at: z.number().int().positive().nullable().optional(),
};
const int = (min: number, max: number) => z.number().int().min(min).max(max).nullable().optional();
const dec = (min: number, max: number) => z.number().min(min).max(max).nullable().optional();
const date = z.string().regex(ISO_DATE).nullable().optional();

const pregnancySchema = z.object({
  ...base,
  lmp_date: date,
  due_date: z.string().regex(ISO_DATE),
  status: z.enum(['active', 'delivered', 'lost']).default('active'),
  gravida: int(0, 30),
  parity: int(0, 30),
});
const vitalSchema = z.object({
  ...base,
  pregnancy_id: z.string().uuid(),
  measured_at: z.number().int().positive(),
  systolic: int(50, 300),
  diastolic: int(30, 200),
  weight_kg: dec(20, 250),
  temperature_c: dec(30, 45),
});
const kickSchema = z.object({
  ...base,
  pregnancy_id: z.string().uuid(),
  counted_at: z.number().int().positive(),
  kicks: z.number().int().min(0).max(500),
  minutes: z.number().int().min(1).max(600),
});
const medSchema = z.object({
  ...base,
  pregnancy_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  dose: z.string().max(80).nullable().optional(),
  times_per_day: int(1, 12),
  start_date: date,
  end_date: date,
  notes: z.string().max(500).nullable().optional(),
});
const apptSchema = z.object({
  ...base,
  pregnancy_id: z.string().uuid(),
  facility_id: z.string().uuid().nullable().optional(),
  scheduled_at: z.number().int().positive(),
  purpose: z.string().max(200).nullable().optional(),
  status: z.enum(['scheduled', 'attended', 'missed', 'cancelled']).default('scheduled'),
});

const MAX_ROWS = 200;
const pushSchema = z.object({
  pregnancies: z.array(pregnancySchema).max(MAX_ROWS).default([]),
  vitals: z.array(vitalSchema).max(MAX_ROWS).default([]),
  kick_counts: z.array(kickSchema).max(MAX_ROWS).default([]),
  medications: z.array(medSchema).max(MAX_ROWS).default([]),
  appointments: z.array(apptSchema).max(MAX_ROWS).default([]),
});

type Row = Record<string, unknown>;

function upsert(db: D1Database, table: string, ownerCol: 'mother_id' | 'pregnancy_id', cols: string[], row: Row, serverNow: number) {
  const all = ['id', ownerCol, ...cols, 'updated_at', 'server_updated_at', 'deleted_at'];
  const values = all.map((k) => {
    if (k === 'server_updated_at') return serverNow;
    const v = row[k];
    return v === undefined ? null : v;
  });
  const assignments = all.filter((k) => k !== 'id' && k !== ownerCol).map((k) => `${k} = excluded.${k}`).join(', ');
  const sql =
    `INSERT INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${assignments} ` +
    `WHERE excluded.updated_at > ${table}.updated_at AND ${table}.${ownerCol} = excluded.${ownerCol}`;
  return db.prepare(sql).bind(...values);
}

export const syncRoutes = new Hono<AppEnv>();
syncRoutes.use('/sync/*', authenticate, requireRole('mother'));

syncRoutes.post('/sync/push', async (c) => {
  const db = c.env.DB;
  const motherId = await getMotherId(db, c.get('user').id);
  const data = await parseBody(c, pushSchema);
  const t = now();

  try {
    // 1) pregnancies first, so children can reference them in the same push
    if (data.pregnancies.length) {
      await db.batch(
        data.pregnancies.map((p) =>
          upsert(db, 'pregnancies', 'mother_id', ['lmp_date', 'due_date', 'status', 'gravida', 'parity'], { ...p, mother_id: motherId }, t),
        ),
      );
    }

    // 2) children: every pregnancy_id must belong to this mother
    const { results } = await db.prepare('SELECT id FROM pregnancies WHERE mother_id = ?').bind(motherId).all<{ id: string }>();
    const owned = new Set(results.map((r) => r.id));
    const children = [...data.vitals, ...data.kick_counts, ...data.medications, ...data.appointments];
    if (children.some((r) => !owned.has(r.pregnancy_id))) {
      throw new HttpError(403, 'foreign_pregnancy', 'A record references a pregnancy that is not yours');
    }

    const stmts: D1PreparedStatement[] = [];
    for (const v of data.vitals) {
      const risk = readingRisk(v.systolic, v.diastolic, v.temperature_c);
      stmts.push(upsert(db, 'vitals', 'pregnancy_id', ['source', 'measured_at', 'systolic', 'diastolic', 'weight_kg', 'temperature_c', 'risk_flag'], { ...v, source: 'self', risk_flag: risk }, t));
    }
    for (const k of data.kick_counts) stmts.push(upsert(db, 'kick_counts', 'pregnancy_id', ['counted_at', 'kicks', 'minutes'], k, t));
    for (const m of data.medications) stmts.push(upsert(db, 'medications', 'pregnancy_id', ['name', 'dose', 'times_per_day', 'start_date', 'end_date', 'notes'], m, t));
    for (const a of data.appointments) stmts.push(upsert(db, 'appointments', 'pregnancy_id', ['facility_id', 'scheduled_at', 'purpose', 'status'], a, t));
    if (stmts.length) await db.batch(stmts);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Error && /FOREIGN KEY/i.test(e.message)) throw new HttpError(400, 'invalid_reference', 'A record references something that does not exist');
    throw e;
  }
  return c.json({ ok: true, server_time: t });
});

const PULL_LIMIT = 500;

syncRoutes.get('/sync/pull', async (c) => {
  const db = c.env.DB;
  const motherId = await getMotherId(db, c.get('user').id);
  const since = Math.max(0, Number(c.req.query('since') ?? '0') || 0);
  const t = now();

  const children = (table: string) =>
    db
      .prepare(
        `SELECT * FROM ${table}
          WHERE pregnancy_id IN (SELECT id FROM pregnancies WHERE mother_id = ?1) AND server_updated_at >= ?2
          ORDER BY server_updated_at LIMIT ${PULL_LIMIT}`,
      )
      .bind(motherId, since);

  const [preg, vitals, kicks, meds, appts, visits] = await db.batch<Row>([
    db.prepare(`SELECT * FROM pregnancies WHERE mother_id = ?1 AND server_updated_at >= ?2 ORDER BY server_updated_at LIMIT ${PULL_LIMIT}`).bind(motherId, since),
    children('vitals'),
    children('kick_counts'),
    children('medications'),
    children('appointments'),
    children('visits'),
  ]);

  const sets = { pregnancies: preg, vitals, kick_counts: kicks, medications: meds, appointments: appts, visits } as const;
  let hasMore = false;
  let cursor = Math.max(since, t - 2000); // small overlap; client upserts are idempotent
  for (const r of Object.values(sets)) {
    const rows = r?.results ?? [];
    if (rows.length >= PULL_LIMIT) {
      hasMore = true;
      cursor = Math.min(cursor, Number(rows[rows.length - 1]?.server_updated_at ?? since));
    }
  }
  return c.json({
    server_time: t,
    next_cursor: cursor,
    has_more: hasMore,
    pregnancies: preg?.results ?? [],
    vitals: vitals?.results ?? [],
    kick_counts: kicks?.results ?? [],
    medications: meds?.results ?? [],
    appointments: appts?.results ?? [],
    visits: visits?.results ?? [],
  });
});
