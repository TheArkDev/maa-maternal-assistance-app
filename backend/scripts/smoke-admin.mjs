// Platform-admin tests. Prerequisite: an account already flagged as platform admin, e.g. in the D1 console:
//   UPDATE users SET is_platform_admin = 1 WHERE phone = '+254700000001';
// Run: BASE=... ADMIN_IDENTIFIER=0700000001 ADMIN_PASSWORD=... node scripts/smoke-admin.mjs
const BASE = process.env.BASE ?? 'http://localhost:8787';
let pass = 0, fail = 0;
async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const check = (name, cond, extra) => { cond ? (pass++, console.log('  ok  ', name)) : (fail++, console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : '')); };
const tag = Date.now().toString().slice(-6);

console.log('Platform admin');
let r = await call('POST', '/auth/login', { body: { identifier: process.env.ADMIN_IDENTIFIER, password: process.env.ADMIN_PASSWORD } });
check('admin signs in', r.status === 200, r);
const admin = r.json;
r = await call('GET', '/me', { token: admin.access_token });
check('/me reports is_platform_admin = 1', r.json?.user?.is_platform_admin === 1, r.json);

const founder = async (n, name) => (await call('POST', '/auth/register/staff', { body: { full_name: `Dr ${n}`, email: `${n}${tag}@example.com`, password: 'passw0rd!!', staff_role: 'doctor', registration_number: `R${n}${tag}`, new_facility: { name: `${name} ${tag}`, county: 'Nairobi' } } })).json;
const a = await founder('Alpha', 'Alpha Clinic');
const b = await founder('Beta', 'Beta Clinic');

console.log('Access control');
r = await call('GET', '/admin/facilities');
check('no token -> 401', r.status === 401, r);
r = await call('GET', '/admin/facilities', { token: a.access_token });
check('facility founder (not platform admin) -> 403', r.status === 403, r);
const mother = (await call('POST', '/auth/register/mother', { body: { full_name: 'Some Mother', phone: `07${tag}00`.slice(0, 10), password: 'passw0rd!!' } })).json;
r = await call('GET', '/admin/facilities', { token: mother.access_token });
check('mother -> 403', r.status === 403, r);
r = await call('POST', `/admin/facilities/${a.membership.facility_id}/decision`, { token: a.access_token, body: { decision: 'approve' } });
check('founder cannot approve their own facility -> 403', r.status === 403, r);

console.log('Review queue');
r = await call('GET', '/admin/facilities', { token: admin.access_token });
const mine = r.json?.facilities?.find((f) => f.id === a.membership.facility_id);
check('admin sees the pending facility with founder details', !!mine && mine.founder_name === 'Dr Alpha' && mine.founder_registration_number === `RAlpha${tag}` && mine.status === 'pending', r.json);
r = await call('GET', '/facilities?q=Alpha%20Clinic');
check('pending facility is NOT in the public list', r.json?.facilities?.length === 0, r.json);
r = await call('GET', '/admin/facilities?status=bogus', { token: admin.access_token });
check('invalid status filter -> 400', r.status === 400, r);

console.log('Approve');
r = await call('POST', `/admin/facilities/${a.membership.facility_id}/decision`, { token: admin.access_token, body: { decision: 'approve' } });
check('admin approves', r.status === 200, r);
r = await call('GET', '/me', { token: a.access_token });
check('founder membership is now verified', r.json?.memberships?.[0]?.status === 'verified', r.json);
r = await call('GET', '/facilities?q=Alpha%20Clinic');
check('facility now in public list', r.json?.facilities?.length === 1, r.json);
r = await call('POST', '/auth/register/staff', { body: { full_name: 'Nurse Joy', email: `joy${tag}@example.com`, password: 'passw0rd!!', staff_role: 'nurse', registration_number: `N${tag}`, facility_id: a.membership.facility_id } });
check('other staff can now register at the approved facility', r.status === 201, r);
const joy = r.json;
r = await call('GET', '/staff/memberships/pending', { token: a.access_token });
check('facility admin sees the nurse request', r.json?.pending?.length === 1, r.json);
r = await call('POST', `/staff/memberships/${r.json.pending[0].id}/decision`, { token: a.access_token, body: { decision: 'approve' } });
check('facility admin approves the nurse', r.status === 200, r);
r = await call('GET', '/me', { token: joy.access_token });
check('nurse is verified', r.json?.memberships?.[0]?.status === 'verified', r.json);

console.log('Reject');
r = await call('POST', `/admin/facilities/${b.membership.facility_id}/decision`, { token: admin.access_token, body: { decision: 'reject' } });
check('admin rejects the other facility', r.status === 200, r);
r = await call('GET', '/me', { token: b.access_token });
check('its founder is rejected', r.json?.memberships?.[0]?.status === 'rejected', r.json);
r = await call('GET', '/facilities?q=Beta%20Clinic');
check('rejected facility not in public list', r.json?.facilities?.length === 0, r.json);
r = await call('GET', '/admin/facilities?status=rejected', { token: admin.access_token });
check('appears under status=rejected', r.json?.facilities?.some((f) => f.id === b.membership.facility_id), r.json);
r = await call('POST', '/auth/register/staff', { body: { full_name: 'Late Joiner', email: `late${tag}@example.com`, password: 'passw0rd!!', staff_role: 'doctor', registration_number: `L${tag}`, facility_id: b.membership.facility_id } });
check('cannot register at a rejected facility', r.status === 400, r);
r = await call('POST', `/admin/facilities/00000000-0000-0000-0000-000000000000/decision`, { token: admin.access_token, body: { decision: 'approve' } });
check('unknown facility -> 404', r.status === 404, r);
r = await call('POST', `/admin/facilities/${a.membership.facility_id}/decision`, { token: admin.access_token, body: { decision: 'maybe' } });
check('invalid decision -> 400', r.status === 400, r);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
