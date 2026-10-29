// End-to-end smoke test. Run against a local `wrangler dev` with a fresh DB:
//   BASE=http://localhost:8787 ADMIN_KEY=change-me-admin-key node scripts/smoke.mjs
const BASE = process.env.BASE ?? 'http://localhost:8787';
const ADMIN_KEY = process.env.ADMIN_KEY ?? 'change-me-admin-key';
let pass = 0, fail = 0;

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const uid = () => crypto.randomUUID();
const tag = Date.now().toString().slice(-6);
const phone = (n) => `07${String(10000000 + n).slice(-8)}`;

console.log('Registration & auth');
let r = await call('POST', '/auth/register/mother', { body: { full_name: 'Amina Wanjiru', phone: phone(Number(tag)), password: 'passw0rd!!' } });
check('mother registers', r.status === 201 && r.json.access_token, r);
const mother = r.json;
r = await call('POST', '/auth/register/mother', { body: { full_name: 'Dup', phone: phone(Number(tag)), password: 'passw0rd!!' } });
check('duplicate phone -> 409', r.status === 409, r);
r = await call('POST', '/auth/register/mother', { body: { full_name: 'Bad Phone', phone: '12345', password: 'passw0rd!!' } });
check('invalid phone -> 400', r.status === 400, r);
r = await call('POST', '/auth/login', { body: { identifier: '+254' + phone(Number(tag)).slice(1), password: 'passw0rd!!' } });
check('login with +254 form of same number works', r.status === 200, r);
r = await call('POST', '/auth/login', { body: { identifier: phone(Number(tag)), password: 'wrong-password' } });
check('wrong password -> 401', r.status === 401, r);
r = await call('POST', '/auth/refresh', { body: { refresh_token: mother.refresh_token } });
check('refresh works once', r.status === 200 && r.json.refresh_token !== mother.refresh_token, r);
const rotated = r.json;
r = await call('POST', '/auth/refresh', { body: { refresh_token: mother.refresh_token } });
check('old refresh token rejected after rotation', r.status === 401, r);
mother.access_token = rotated.access_token;
r = await call('GET', '/me');
check('/me without token -> 401', r.status === 401);

console.log('Staff, facility verification');
r = await call('POST', '/auth/register/staff', { body: { full_name: 'Dr Otieno', email: `otieno${tag}@example.com`, password: 'passw0rd!!', staff_role: 'doctor', registration_number: 'A1234', new_facility: { name: `Test Clinic ${tag}`, county: 'Nairobi', mfl_code: `T${tag}` } } });
check('founding doctor registers (becomes admin, pending)', r.status === 201 && r.json.membership.staff_role === 'facility_admin' && r.json.membership.status === 'pending', r);
const doc = r.json; const facilityId = doc.membership.facility_id;
r = await call('POST', '/care/redeem', { token: doc.access_token, body: { code: 'ABCDEFGH', facility_id: facilityId } });
check('unverified staff cannot redeem codes -> 403', r.status === 403, r);
r = await call('POST', `/admin/facilities/${facilityId}/verify`, {});
check('verify without admin key -> 403', r.status === 403, r);
r = await call('POST', `/admin/facilities/${facilityId}/verify`, { headers: { 'x-admin-key': ADMIN_KEY } });
check('verify with admin key', r.status === 200, r);
r = await call('GET', `/facilities?q=Test%20Clinic%20${tag}`);
check('facility now publicly listed', r.json?.facilities?.length === 1, r);

console.log('Second doctor joins; admin approves');
r = await call('POST', '/auth/register/staff', { body: { full_name: 'Dr Mwangi', email: `mwangi${tag}@example.com`, password: 'passw0rd!!', staff_role: 'doctor', registration_number: 'B5678', facility_id: facilityId } });
check('second doctor registers (pending)', r.status === 201, r);
const doc2 = r.json;
r = await call('GET', '/staff/memberships/pending', { token: doc.access_token });
check('admin sees pending request', r.json?.pending?.length === 1, r);
r = await call('GET', '/staff/memberships/pending', { token: doc2.access_token });
check('non-admin sees nothing pending', r.json?.pending?.length === 0, r);
r = await call('POST', `/staff/memberships/${doc2.membership ? (await call('GET', '/staff/memberships/pending', { token: doc.access_token })).json.pending[0].id : ''}/decision`, { token: doc2.access_token, body: { decision: 'approve' } });
check('pending doctor cannot approve themselves -> 403', r.status === 403, r);
const pendingId = (await call('GET', '/staff/memberships/pending', { token: doc.access_token })).json.pending[0].id;
r = await call('POST', `/staff/memberships/${pendingId}/decision`, { token: doc.access_token, body: { decision: 'approve' } });
check('admin approves second doctor', r.status === 200, r);

console.log('Mother data push / pull (offline sync)');
const pregId = uid(), vitalId = uid(), kickId = uid(), medId = uid();
const t0 = Date.now();
r = await call('POST', '/sync/push', { token: mother.access_token, body: {
  pregnancies: [{ id: pregId, due_date: '2027-03-01', lmp_date: '2026-06-01', updated_at: t0 }],
  vitals: [{ id: vitalId, pregnancy_id: pregId, measured_at: t0, systolic: 150, diastolic: 95, updated_at: t0 }],
  kick_counts: [{ id: kickId, pregnancy_id: pregId, counted_at: t0, kicks: 10, minutes: 45, updated_at: t0 }],
  medications: [{ id: medId, pregnancy_id: pregId, name: 'Folic acid', times_per_day: 1, updated_at: t0 }],
} });
check('push accepted', r.status === 200, r);
r = await call('GET', '/sync/pull?since=0', { token: mother.access_token });
check('pull returns pregnancy, vital, kick, med', r.json?.pregnancies?.length === 1 && r.json.vitals.length === 1 && r.json.kick_counts.length === 1 && r.json.medications.length === 1, r);
check('server computed risk_flag=urgent for 150/95', r.json?.vitals?.[0]?.risk_flag === 'urgent', r.json?.vitals);
r = await call('POST', '/sync/push', { token: mother.access_token, body: { vitals: [{ id: vitalId, pregnancy_id: pregId, measured_at: t0, systolic: 110, diastolic: 70, updated_at: t0 - 5000 }] } });
r = await call('GET', '/sync/pull?since=0', { token: mother.access_token });
check('stale (older updated_at) write ignored: still 150', r.json?.vitals?.[0]?.systolic === 150, r.json?.vitals);
await call('POST', '/sync/push', { token: mother.access_token, body: { vitals: [{ id: vitalId, pregnancy_id: pregId, measured_at: t0, systolic: 118, diastolic: 76, updated_at: t0 + 5000 }] } });
r = await call('GET', '/sync/pull?since=0', { token: mother.access_token });
check('newer write wins and risk recomputed to routine', r.json?.vitals?.[0]?.systolic === 118 && r.json.vitals[0].risk_flag === 'routine', r.json?.vitals);

console.log('Tenant isolation: another mother cannot touch these records');
r = await call('POST', '/auth/register/mother', { body: { full_name: 'Other Mother', phone: phone(Number(tag) + 1), password: 'passw0rd!!' } });
const other = r.json;
r = await call('POST', '/sync/push', { token: other.access_token, body: { vitals: [{ id: uid(), pregnancy_id: pregId, measured_at: t0, systolic: 90, diastolic: 60, updated_at: t0 }] } });
check("pushing a vital onto someone else's pregnancy -> 403", r.status === 403, r);
r = await call('POST', '/sync/push', { token: other.access_token, body: { pregnancies: [{ id: pregId, due_date: '2030-01-01', updated_at: t0 + 999999 }] } });
r = await call('GET', '/sync/pull?since=0', { token: mother.access_token });
check("hijacking someone else's pregnancy id does not modify it", r.json?.pregnancies?.[0]?.due_date === '2027-03-01', r.json?.pregnancies);
r = await call('GET', '/sync/pull?since=0', { token: other.access_token });
check("other mother's pull does not contain our data", r.json?.vitals?.length === 0, r.json?.vitals);
r = await call('GET', '/sync/pull?since=0', { token: doc.access_token });
check('staff token on mother-only endpoint -> 403', r.status === 403, r);

console.log('Care link consent');
r = await call('GET', '/patients', { token: doc.access_token });
check('doctor sees no patients before consent', r.json?.patients?.length === 0, r);
r = await call('POST', '/care/join-code', { token: mother.access_token });
check('mother gets join code', r.status === 200 && r.json.code?.length === 8, r);
const code = r.json.code;
r = await call('POST', '/care/redeem', { token: doc.access_token, body: { code, facility_id: facilityId } });
check('doctor redeems code', r.status === 200, r);
const motherId = r.json?.mother_id;
r = await call('POST', '/care/redeem', { token: doc2.access_token, body: { code, facility_id: facilityId } });
check('code is single-use -> 400 on replay', r.status === 400, r);
r = await call('GET', '/patients', { token: doc2.access_token });
check('colleague at same facility also sees patient', r.json?.patients?.length === 1 && r.json.patients[0].mother_id === motherId, r);
r = await call('GET', `/patients/${motherId}`, { token: doc2.access_token });
check('colleague can open record', r.status === 200 && r.json.vitals.length === 1, r);

console.log('Facility outsider cannot see the record');
r = await call('POST', '/auth/register/staff', { body: { full_name: 'Dr Elsewhere', email: `else${tag}@example.com`, password: 'passw0rd!!', staff_role: 'doctor', registration_number: 'C999', new_facility: { name: `Other Clinic ${tag}`, county: 'Kisumu' } } });
const outsider = r.json;
await call('POST', `/admin/facilities/${outsider.membership.facility_id}/verify`, { headers: { 'x-admin-key': ADMIN_KEY } });
r = await call('GET', `/patients/${motherId}`, { token: outsider.access_token });
check('verified doctor at an unlinked facility -> 403', r.status === 403, r);
r = await call('GET', '/patients', { token: outsider.access_token });
check('outsider patient list is empty', r.json?.patients?.length === 0, r);
r = await call('POST', `/patients/${motherId}/visits`, { token: outsider.access_token, body: { pregnancy_id: pregId, visit_date: '2026-10-28' } });
check('outsider cannot write a visit -> 403', r.status === 403, r);

console.log('Visits, appointments, risk ordering');
r = await call('POST', `/patients/${motherId}/visits`, { token: doc.access_token, body: { pregnancy_id: pregId, visit_date: '2026-10-28', gestation_weeks: 21, systolic: 165, diastolic: 112, notes: 'ANC visit 3', next_visit_date: '2026-11-25' } });
check('visit saved with emergency flag for 165/112', r.status === 201 && r.json.risk_flag === 'emergency', r);
r = await call('POST', `/patients/${motherId}/appointments`, { token: doc.access_token, body: { pregnancy_id: pregId, scheduled_at: Date.now() + 86400000, purpose: 'Review' } });
check('appointment created', r.status === 201, r);
r = await call('GET', '/patients', { token: doc.access_token });
check('patient list shows latest_risk=emergency', r.json?.patients?.[0]?.latest_risk === 'emergency', r.json?.patients);
r = await call('GET', '/sync/pull?since=0', { token: mother.access_token });
check('mother pulls the clinic visit and appointment', r.json?.visits?.length === 1 && r.json.appointments.length === 1, r);
r = await call('POST', '/sync/push', { token: mother.access_token, body: { vitals: [{ id: uid(), pregnancy_id: pregId, measured_at: Date.now(), systolic: 120, diastolic: 80, updated_at: Date.now() }] } });
r = await call('GET', `/patients/${motherId}`, { token: doc.access_token });
check('audit-logged record view still works', r.status === 200, r);

console.log('Revocation');
r = await call('GET', '/care/links', { token: mother.access_token });
const linkId = r.json?.links?.[0]?.id;
check('mother lists her link', r.json?.links?.length === 1, r);
r = await call('DELETE', `/care/links/${linkId}`, { token: mother.access_token });
check('mother revokes link', r.status === 200, r);
r = await call('GET', `/patients/${motherId}`, { token: doc.access_token });
check('doctor loses access immediately -> 403', r.status === 403, r);
r = await call('DELETE', `/care/links/${linkId}`, { token: other.access_token });
check("another mother cannot revoke someone else's link -> 404", r.status === 404, r);

console.log('Danger-sign assessment (public)');
r = await call('POST', '/assess', { body: { symptoms: ['vaginal_bleeding'] } });
check('bleeding -> emergency', r.json?.level === 'emergency', r);
r = await call('POST', '/assess', { body: { systolic: 145, diastolic: 92, symptoms: ['severe_headache'] } });
check('raised BP + headache -> emergency (possible pre-eclampsia)', r.json?.level === 'emergency' && r.json.reasons.includes('possible_preeclampsia'), r);
r = await call('POST', '/assess', { body: { symptoms: ['reduced_fetal_movement'] } });
check('reduced movement -> urgent', r.json?.level === 'urgent', r);
r = await call('POST', '/assess', { body: { systolic: 118, diastolic: 76 } });
check('normal BP, no symptoms -> routine', r.json?.level === 'routine', r);
r = await call('POST', '/assess', { body: { symptoms: ['not_a_symptom'] } });
check('unknown symptom -> 400', r.status === 400, r);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
