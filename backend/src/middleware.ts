import { createMiddleware } from 'hono/factory';
import { verifyJwt } from './auth';
import type { AppEnv } from './types';
import { HttpError, now, uuid } from './util';

export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = token ? await verifyJwt(token, c.env.JWT_SECRET) : null;
  if (!payload) throw new HttpError(401, 'unauthorized', 'Missing or invalid token');
  c.set('user', { id: payload.sub, role: payload.role });
  await next();
});

export const requireRole = (role: 'mother' | 'staff') =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (c.get('user').role !== role) throw new HttpError(403, 'forbidden', `This endpoint is for ${role} accounts`);
    await next();
  });

/** Platform admins are flagged in the database (never self-service) and re-checked on every request. */
export const requirePlatformAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const row = await c.env.DB
    .prepare('SELECT is_platform_admin FROM users WHERE id = ?')
    .bind(c.get('user').id)
    .first<{ is_platform_admin: number }>();
  if (!row || row.is_platform_admin !== 1) throw new HttpError(403, 'forbidden', 'Platform administrators only');
  await next();
});

export async function getMotherId(db: D1Database, userId: string): Promise<string> {
  const row = await db.prepare('SELECT id FROM mothers WHERE user_id = ?').bind(userId).first<{ id: string }>();
  if (!row) throw new HttpError(404, 'mother_not_found', 'No mother profile for this account');
  return row.id;
}

/**
 * THE access rule for clinical data. A staff member may touch a mother's record only if
 * they hold a VERIFIED membership at a facility that has an ACTIVE care link to her.
 * Returns that facility id, or throws 403. Every staff endpoint that reads or writes
 * mother data must go through this.
 */
export async function requireMotherAccess(db: D1Database, staffUserId: string, motherId: string): Promise<string> {
  const row = await db
    .prepare(
      `SELECT cl.facility_id AS facility_id
         FROM care_links cl
         JOIN staff_memberships sm ON sm.facility_id = cl.facility_id
        WHERE cl.mother_id = ?1 AND cl.revoked_at IS NULL
          AND sm.user_id = ?2 AND sm.status = 'verified'
        LIMIT 1`,
    )
    .bind(motherId, staffUserId)
    .first<{ facility_id: string }>();
  if (!row) throw new HttpError(403, 'no_access', 'You do not have access to this patient');
  return row.facility_id;
}

export async function requireVerifiedMember(db: D1Database, userId: string, facilityId: string) {
  const row = await db
    .prepare(`SELECT staff_role FROM staff_memberships WHERE user_id = ? AND facility_id = ? AND status = 'verified'`)
    .bind(userId, facilityId)
    .first<{ staff_role: string }>();
  if (!row) throw new HttpError(403, 'not_verified_member', 'You are not a verified member of this facility');
  return row.staff_role;
}

export async function audit(
  db: D1Database,
  entry: { actor: string; action: string; facilityId?: string | null; motherId?: string | null; entity?: string; entityId?: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_user_id, facility_id, mother_id, action, entity, entity_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(uuid(), entry.actor, entry.facilityId ?? null, entry.motherId ?? null, entry.action, entry.entity ?? null, entry.entityId ?? null, now())
    .run();
}
