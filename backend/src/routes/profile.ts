import { Hono } from 'hono';
import { z } from 'zod';
import { authenticate, getMotherId, requireRole } from '../middleware';
import type { AppEnv } from '../types';
import { HttpError, ISO_DATE, normalizeKePhone, now, parseBody } from '../util';

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

const schema = z
  .object({
    date_of_birth: z.string().regex(ISO_DATE).nullable().optional(),
    blood_group: z.enum(BLOOD_GROUPS).nullable().optional(),
    emergency_contact_name: z.string().max(80).nullable().optional(),
    emergency_contact_phone: z.string().max(20).nullable().optional(),
  })
  .strict();

export const profileRoutes = new Hono<AppEnv>();

// A mother edits her own profile: date of birth, blood group and emergency contact.
profileRoutes.patch('/me/mother', authenticate, requireRole('mother'), async (c) => {
  const db = c.env.DB;
  const motherId = await getMotherId(db, c.get('user').id);
  const body = (await parseBody(c, schema)) as Record<string, string | null | undefined>;

  const sets: string[] = [];
  const values: unknown[] = [];
  const put = (col: string, v: string | null) => {
    sets.push(`${col} = ?`);
    values.push(v);
  };

  if ('date_of_birth' in body) {
    const dob = body.date_of_birth ?? null;
    const today = new Date().toISOString().slice(0, 10);
    if (dob !== null && (dob > today || dob < '1940-01-01')) throw new HttpError(400, 'invalid_date_of_birth', 'Check the date of birth');
    put('date_of_birth', dob);
  }
  if ('blood_group' in body) put('blood_group', body.blood_group ?? null);
  if ('emergency_contact_name' in body) put('emergency_contact_name', body.emergency_contact_name?.trim() || null);
  if ('emergency_contact_phone' in body) {
    const raw = body.emergency_contact_phone?.trim() ?? '';
    if (raw === '') {
      put('emergency_contact_phone', null);
    } else {
      const phone = normalizeKePhone(raw);
      if (!phone) throw new HttpError(400, 'invalid_phone', 'Enter a valid Kenyan mobile number, e.g. 0712 345 678');
      put('emergency_contact_phone', phone);
    }
  }
  if (sets.length === 0) throw new HttpError(400, 'empty_patch', 'Nothing to change');

  await db.prepare(`UPDATE mothers SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...values, now(), motherId).run();
  const mother = await db
    .prepare('SELECT id, date_of_birth, blood_group, emergency_contact_name, emergency_contact_phone FROM mothers WHERE id = ?')
    .bind(motherId)
    .first();
  return c.json({ mother });
});

