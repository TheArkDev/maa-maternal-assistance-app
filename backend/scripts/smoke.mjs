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
const visitId = r.json?.id;
r = await call('POST', `/patients/${motherId}/appointments`, { token: doc.access_token, body: { pregnancy_id: pregId, scheduled_at: Date.now() + 86400000, purpose: 'Review' } });
check('appointment created', r.status === 201, r);
r = await call('GET', '/patients', { token: doc.access_token });
check('patient list shows latest_risk=emergency', r.json?.patients?.[0]?.latest_risk === 'emergency', r.json?.patients);
check('patient list reports last_visit_date', r.json?.patients?.[0]?.last_visit_date === '2026-10-28', r.json?.patients);
check('patient list reports next_appointment_at (a number in the future)', typeof r.json?.patients?.[0]?.next_appointment_at === 'number' && r.json.patients[0].next_appointment_at > Date.now(), r.json?.patients);
r = await call('GET', '/sync/pull?since=0', { token: mother.access_token });
check('mother pulls the clinic visit and appointment', r.json?.visits?.length === 1 && r.json.appointments.length === 1, r);
r = await call('POST', '/sync/push', { token: mother.access_token, body: { vitals: [{ id: uid(), pregnancy_id: pregId, measured_at: Date.now(), systolic: 120, diastolic: 80, updated_at: Date.now() }] } });
r = await call('GET', `/patients/${motherId}`, { token: doc.access_token });
check('audit-logged record view still works', r.status === 200, r);

console.log('Editing a medical report (visit)');
r = await call('PATCH', `/patients/${motherId}/visits/${visitId}`, { token: doc.access_token, body: { systolic: 118, diastolic: 76, notes: 'Re-measured: first reading was wrong' } });
check('staff edits the visit; risk recomputed to routine', r.status === 200 && r.json.risk_flag === 'routine', r);
r = await call('GET', `/patients/${motherId}`, { token: doc.access_token });
const edited = r.json?.visits?.find((v) => v.id === visitId);
check('record shows the new values', edited?.systolic === 118 && edited?.notes === 'Re-measured: first reading was wrong' && edited?.risk_flag === 'routine', edited);
check('updated_at moved past created_at (so the UI can show "Edited")', edited?.updated_at > edited?.created_at, edited);
r = await call('GET', '/sync/pull?since=0', { token: mother.access_token });
const mv = r.json?.visits?.find((v) => v.id === visitId);
check('the mother receives the corrected visit', mv?.systolic === 118 && mv?.next_visit_date === '2026-11-25', mv);
r = await call('GET', `/patients/${motherId}/visits/${visitId}/revisions`, { token: doc.access_token });
check('history keeps the ORIGINAL values', r.json?.revisions?.length === 1 && r.json.revisions[0].previous.systolic === 165 && r.json.revisions[0].edited_by_name === 'Dr Otieno', r.json);
r = await call('PATCH', `/patients/${motherId}/visits/${visitId}`, { token: doc2.access_token, body: { next_visit_date: null, weight_kg: 64.5 } });
check('a colleague at the same facility can edit too, and can clear the next visit date', r.status === 200, r);
r = await call('GET', '/sync/pull?since=0', { token: mother.access_token });
check('mother sees the cleared date and new weight', r.json?.visits?.find((v) => v.id === visitId)?.next_visit_date === null && r.json.visits.find((v) => v.id === visitId).weight_kg === 64.5, r.json?.visits);
r = await call('GET', `/patients/${motherId}/visits/${visitId}/revisions`, { token: doc.access_token });
check('two edits, newest first', r.json?.revisions?.length === 2 && r.json.revisions[0].edited_by_name === 'Dr Mwangi', r.json);
r = await call('PATCH', `/patients/${motherId}/visits/${visitId}`, { token: doc.access_token, body: { diastolic: null } });
check('clearing only one blood-pressure number is rejected (both numbers or neither)', r.status === 400 && r.json?.error?.code === 'bp_incomplete', r);
r = await call('GET', `/patients/${motherId}`, { token: doc.access_token });
check('...and the rejected edit changed nothing', r.json?.visits?.find((v) => v.id === visitId)?.diastolic === 76, r.json?.visits);
r = await call('PATCH', `/patients/${motherId}/visits/${visitId}`, { token: doc.access_token, body: {} });
check('empty edit is rejected', r.status === 400, r);
r = await call('PATCH', `/patients/${motherId}/visits/${visitId}`, { token: doc.access_token, body: { pregnancy_id: uid() } });
check('a visit cannot be moved to another pregnancy (unknown field rejected)', r.status === 400, r);
r = await call('PATCH', `/patients/${motherId}/visits/${visitId}`, { token: doc.access_token, body: { systolic: 999, diastolic: 80 } });
check('absurd values rejected', r.status === 400, r);
r = await call('PATCH', `/patients/${motherId}/visits/${visitId}`, { token: outsider.access_token, body: { notes: 'x' } });
check('verified staff at an unlinked facility cannot edit -> 403', r.status === 403, r);
r = await call('PATCH', `/patients/${motherId}/visits/${visitId}`, { token: mother.access_token, body: { notes: 'x' } });
check('the mother cannot edit a medical report -> 403', r.status === 403, r);
r = await call('PATCH', `/patients/${motherId}/visits/${uid()}`, { token: doc.access_token, body: { notes: 'x' } });
check('unknown visit -> 404', r.status === 404, r);
r = await call('GET', `/patients/${motherId}/visits/${visitId}/revisions`, { token: outsider.access_token });
check('outsider cannot read the edit history -> 403', r.status === 403, r);

console.log('Mother profile');
r = await call('PATCH', '/me/mother', { token: mother.access_token, body: { blood_group: 'O+', emergency_contact_name: 'John Mwangi', emergency_contact_phone: '0722 111 222', date_of_birth: '1995-04-02' } });
check('mother saves blood group, emergency contact and date of birth', r.status === 200 && r.json.mother.blood_group === 'O+' && r.json.mother.emergency_contact_phone === '+254722111222', r);
r = await call('GET', `/patients/${motherId}`, { token: doc.access_token });
check('the health worker sees them on the record', r.json?.profile?.blood_group === 'O+' && r.json.profile.emergency_contact_name === 'John Mwangi', r.json?.profile);
r = await call('PATCH', '/me/mother', { token: mother.access_token, body: { blood_group: 'Z+' } });
check('invalid blood group -> 400', r.status === 400, r);
r = await call('PATCH', '/me/mother', { token: mother.access_token, body: { emergency_contact_phone: '12345' } });
check('invalid phone -> 400', r.status === 400, r);
r = await call('PATCH', '/me/mother', { token: mother.access_token, body: { date_of_birth: '2999-01-01' } });
check('date of birth in the future -> 400', r.status === 400, r);
r = await call('PATCH', '/me/mother', { token: mother.access_token, body: { emergency_contact_phone: '', emergency_contact_name: '  ' } });
check('empty strings clear the contact', r.status === 200 && r.json.mother.emergency_contact_phone === null && r.json.mother.emergency_contact_name === null, r);
check('blood group is untouched by that clear', r.json?.mother?.blood_group === 'O+', r.json);
r = await call('PATCH', '/me/mother', { token: doc.access_token, body: { blood_group: 'A+' } });
check('staff cannot use the mother profile endpoint -> 403', r.status === 403, r);
r = await call('PATCH', '/me/mother', { token: mother.access_token, body: { full_name: 'Hacker' } });
check('only profile fields are accepted (unknown field -> 400)', r.status === 400, r);

const isoPlus = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

console.log('Login lockout and changing your password');
const lockPhone = phone(Number(tag) + 301);
await call('POST', '/auth/register/mother', { body: { full_name: 'Lock Test', phone: lockPhone, password: 'rightpass123' } });
let lastStatus = 0;
for (let i = 0; i < 8; i++) lastStatus = (await call('POST', '/auth/login', { body: { identifier: lockPhone, password: `wrong${i}` } })).status;
check('wrong passwords give 401', lastStatus === 401);
r = await call('POST', '/auth/login', { body: { identifier: lockPhone, password: 'rightpass123' } });
check('after 8 failures even the RIGHT password is locked out (429)', r.status === 429 && r.json?.error?.code === 'too_many_attempts', r);

r = await call('POST', '/auth/register/mother', { body: { full_name: 'Change Pw', phone: phone(Number(tag) + 302), password: 'oldpass1234' } });
const cp = r.json;
r = await call('POST', '/auth/change-password', { token: cp.access_token, body: { current_password: 'wrong', new_password: 'newpass1234' } });
check('wrong current password -> 401', r.status === 401, r);
r = await call('POST', '/auth/change-password', { token: cp.access_token, body: { current_password: 'oldpass1234', new_password: 'short' } });
check('too-short new password -> 400', r.status === 400, r);
r = await call('POST', '/auth/change-password', { token: cp.access_token, body: { current_password: 'oldpass1234', new_password: 'newpass1234' } });
check('password changed; fresh tokens returned', r.status === 200 && !!r.json.access_token, r);
r = await call('POST', '/auth/refresh', { body: { refresh_token: cp.refresh_token } });
check('every old session is signed out', r.status === 401, r);
r = await call('POST', '/auth/login', { body: { identifier: phone(Number(tag) + 302), password: 'oldpass1234' } });
check('old password no longer works', r.status === 401, r);
r = await call('POST', '/auth/login', { body: { identifier: phone(Number(tag) + 302), password: 'newpass1234' } });
check('new password works', r.status === 200, r);

console.log('A health worker registers a mother (no app, maybe no phone)');
const gracePhone = phone(Number(tag) + 303);
const base = { facility_id: facilityId, full_name: 'Grace Akinyi', phone: gracePhone, due_date: isoPlus(200), consent: true };
r = await call('POST', '/patients', { token: doc.access_token, body: { ...base, consent: false } });
check('without consent -> 400', r.status === 400, r);
r = await call('POST', '/patients', { token: doc.access_token, body: { ...base, phone: '12345' } });
check('invalid phone -> 400', r.status === 400, r);
r = await call('POST', '/patients', { token: doc.access_token, body: { facility_id: facilityId, full_name: 'No Dates', consent: true } });
check('no dates -> 400 dates_required', r.status === 400 && r.json?.error?.code === 'dates_required', r);
r = await call('POST', '/patients', { token: doc.access_token, body: { ...base, due_date: undefined, lmp_date: isoPlus(30) } });
check('last period in the future -> 400', r.status === 400, r);
r = await call('POST', '/patients', { token: outsider.access_token, body: base });
check("staff cannot register a patient at someone else's facility -> 403", r.status === 403, r);
r = await call('POST', '/patients', { token: mother.access_token, body: base });
check('a mother cannot use health-worker registration -> 403', r.status === 403, r);
r = await call('POST', '/patients', { token: doc.access_token, body: base });
check('health worker registers Grace', r.status === 201 && r.json.mother_id && r.json.pregnancy_id, r);
const grace = r.json;
r = await call('POST', '/patients', { token: doc.access_token, body: base });
check('same phone again -> 409 already_registered', r.status === 409 && r.json?.error?.code === 'already_registered', r);
r = await call('POST', '/auth/login', { body: { identifier: gracePhone, password: 'anything-at-all' } });
check('a registered-but-unclaimed account cannot be signed in to', r.status === 401, r);
r = await call('GET', '/patients', { token: doc.access_token });
let g = r.json?.patients?.find((p) => p.mother_id === grace.mother_id);
check('she is on the board: no app yet, no visits yet', g?.has_login === 0 && g?.visit_count === 0 && g?.next_visit_date === null, g);
r = await call('POST', `/patients/${grace.mother_id}/visits`, { token: doc.access_token, body: { pregnancy_id: grace.pregnancy_id, visit_date: isoPlus(0), gestation_weeks: 21, systolic: 118, diastolic: 76, next_visit_date: isoPlus(28) } });
check('health worker records her first visit', r.status === 201, r);
r = await call('GET', '/patients', { token: doc.access_token });
g = r.json?.patients?.find((p) => p.mother_id === grace.mother_id);
check('board now shows visit_count 1 and the planned next visit', g?.visit_count === 1 && g?.next_visit_date === isoPlus(28), g);
r = await call('POST', `/patients/${grace.mother_id}/pregnancies`, { token: doc.access_token, body: { due_date: isoPlus(100) } });
check('cannot start a second pregnancy while one is active -> 409', r.status === 409, r);

r = await call('POST', '/patients', { token: doc.access_token, body: { facility_id: facilityId, full_name: 'Mary Atieno', lmp_date: isoPlus(-100), consent: true } });
check('a mother with NO phone can be registered (due date derived from last period)', r.status === 201, r);
const mary = r.json;
r = await call('GET', `/patients/${mary.mother_id}`, { token: doc.access_token });
check('due date = last period + 280 days', r.json?.pregnancies?.[0]?.due_date === isoPlus(180), r.json?.pregnancies);
r = await call('GET', '/patients', { token: doc.access_token });
check('phone-less patient shows no phone', r.json?.patients?.find((p) => p.mother_id === mary.mother_id)?.phone === null, r.json?.patients);

console.log('Claiming an account with a code from the clinic');
r = await call('POST', `/patients/${grace.mother_id}/access-code`, { token: outsider.access_token });
check('staff without access cannot issue a code -> 403', r.status === 403, r);
r = await call('POST', `/patients/${grace.mother_id}/access-code`, { token: mother.access_token });
check('a mother cannot issue a code -> 403', r.status === 403, r);
r = await call('POST', `/patients/${grace.mother_id}/access-code`, { token: doc.access_token });
check('health worker issues a CLAIM code', r.status === 200 && r.json.kind === 'claim' && /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(r.json.code), r);
const claimCode = r.json.code;
r = await call('POST', '/auth/claim', { body: { code: 'AAAAA-BBBBB', password: 'gracepass123' } });
check('wrong code -> 400', r.status === 400 && r.json?.error?.code === 'invalid_code', r);
r = await call('POST', '/auth/claim', { body: { code: claimCode, password: 'short' } });
check('weak password -> 400', r.status === 400, r);
r = await call('POST', '/auth/claim', { body: { code: claimCode.toLowerCase().replace('-', ' '), password: 'gracepass123', accept_terms: true } });
check('Grace claims her account (code typed in lower case with a space still works)', r.status === 201 && r.json.user.role === 'mother', r);
const graceTokens = r.json;
r = await call('POST', '/auth/claim', { body: { code: claimCode, password: 'otherpass123' } });
check('a code works only once', r.status === 400, r);
r = await call('POST', '/auth/login', { body: { identifier: gracePhone, password: 'gracepass123' } });
check('she can now sign in with the phone the clinic recorded', r.status === 200, r);
r = await call('GET', '/sync/pull?since=0', { token: graceTokens.access_token });
check('her app receives the visit and pregnancy the health worker recorded', r.json?.visits?.length === 1 && r.json?.pregnancies?.length === 1, r.json);
r = await call('POST', `/patients/${grace.mother_id}/access-code`, { token: doc.access_token });
check('once she has an account the code kind becomes RESET', r.status === 200 && r.json.kind === 'reset', r);

r = await call('POST', `/patients/${mary.mother_id}/access-code`, { token: doc.access_token });
const maryCode = r.json.code;
r = await call('POST', '/auth/claim', { body: { code: maryCode, password: 'marypass1234' } });
check('a phone-less mother must give a phone or email to sign in -> 400', r.status === 400 && r.json?.error?.code === 'contact_required', r);
r = await call('POST', '/auth/claim', { body: { code: maryCode, password: 'marypass1234', phone: phone(Number(tag) + 304) } });
check('...and the code was NOT used up by that mistake', r.status === 201, r);

console.log('Forgot password: reset code from the clinic');
r = await call('POST', `/patients/${grace.mother_id}/access-code`, { token: doc.access_token });
const resetCode = r.json.code;
r = await call('POST', '/auth/reset-password', { body: { identifier: gracePhone, code: 'ZZZZZ-ZZZZZ', new_password: 'gracenewpass1' } });
check('wrong reset code -> 400', r.status === 400, r);
r = await call('POST', '/auth/reset-password', { body: { identifier: phone(Number(tag) + 399), code: resetCode, new_password: 'gracenewpass1' } });
check('unknown account gets the same generic answer (no account enumeration)', r.status === 400 && r.json?.error?.code === 'invalid_code', r);
r = await call('POST', '/auth/reset-password', { body: { identifier: gracePhone, code: resetCode, new_password: 'gracenewpass1' } });
check('Grace resets her password', r.status === 200 && !!r.json.access_token, r);
r = await call('POST', '/auth/refresh', { body: { refresh_token: graceTokens.refresh_token } });
check('her old sessions are signed out', r.status === 401, r);
r = await call('POST', '/auth/login', { body: { identifier: gracePhone, password: 'gracepass123' } });
check('old password rejected', r.status === 401, r);
r = await call('POST', '/auth/login', { body: { identifier: gracePhone, password: 'gracenewpass1' } });
check('new password accepted', r.status === 200, r);
r = await call('POST', '/auth/reset-password', { body: { identifier: gracePhone, code: resetCode, new_password: 'gracethird123' } });
check('a reset code works only once', r.status === 400, r);
r = await call('POST', `/patients/${grace.mother_id}/access-code`, { token: doc.access_token });
const guessCode = r.json.code;
const guessStatuses = [];
for (let i = 0; i < 6; i++) guessStatuses.push((await call('POST', '/auth/reset-password', { body: { identifier: gracePhone, code: `WRONG${i}-XXXXX`, new_password: 'gracefourth12' } })).status);
check('guessing codes never succeeds, and the account locks after a few wrong tries', guessStatuses.every((x) => x === 400 || x === 429) && guessStatuses.includes(429), guessStatuses);
r = await call('POST', '/auth/reset-password', { body: { identifier: gracePhone, code: guessCode, new_password: 'gracefourth12' } });
check('...and after 6 wrong guesses even the right code is locked (429)', r.status === 429, r);

console.log('Facility admin resets a colleague');
r = await call('GET', '/staff/team', { token: doc.access_token });
const mwangi = r.json?.team?.find((t) => t.full_name === 'Dr Mwangi');
check('admin sees their team, not other facilities', !!mwangi && !r.json.team.some((t) => t.full_name === 'Dr Elsewhere'), r.json);
check('their own row is marked is_self', r.json?.team?.find((t) => t.full_name === 'Dr Otieno')?.is_self === true, r.json);
r = await call('GET', '/staff/team', { token: doc2.access_token });
check('a non-admin sees no team', r.json?.team?.length === 0, r.json);
r = await call('POST', `/staff/team/${mwangi.id}/reset-code`, { token: doc2.access_token });
check('a non-admin cannot issue reset codes -> 403', r.status === 403, r);
r = await call('POST', `/staff/team/${mwangi.id}/reset-code`, { token: outsider.access_token });
check("another facility's admin cannot -> 403", r.status === 403, r);
const self = (await call('GET', '/staff/team', { token: doc.access_token })).json.team.find((t) => t.is_self);
r = await call('POST', `/staff/team/${self.id}/reset-code`, { token: doc.access_token });
check('admin cannot issue a code for themselves -> 400', r.status === 400, r);
r = await call('POST', `/staff/team/${mwangi.id}/reset-code`, { token: doc.access_token });
check('admin issues a reset code for Dr Mwangi', r.status === 200 && /-/.test(r.json.code), r);
r = await call('POST', '/auth/reset-password', { body: { identifier: `mwangi${tag}@example.com`, code: r.json.code, new_password: 'newdoctorpass1' } });
check('Dr Mwangi resets his password with his email', r.status === 200, r);
r = await call('POST', '/auth/login', { body: { identifier: `mwangi${tag}@example.com`, password: 'newdoctorpass1' } });
check('he signs in with the new password', r.status === 200, r);

console.log('Symptom alerts reach the clinic');
r = await call('POST', '/alerts', { token: other.access_token, body: { symptoms: ['fever'] } });
check('a mother sharing with no clinic cannot send an alert -> 400', r.status === 400 && r.json?.error?.code === 'no_clinic', r);
r = await call('POST', '/alerts', { token: mother.access_token, body: { symptoms: [] } });
check('empty alert -> 400', r.status === 400, r);
r = await call('POST', '/alerts', { token: mother.access_token, body: { symptoms: ['not_a_symptom'] } });
check('unknown symptom -> 400', r.status === 400, r);
r = await call('POST', '/alerts', { token: doc.access_token, body: { symptoms: ['fever'] } });
check('staff cannot send mother alerts -> 403', r.status === 403, r);
r = await call('POST', '/alerts', { token: mother.access_token, body: { symptoms: ['fever'] } });
check('urgent alert sent; level worked out by the server', r.status === 201 && r.json.level === 'urgent' && r.json.sent_to === 1, r);
r = await call('POST', '/alerts', { token: mother.access_token, body: { symptoms: ['vaginal_bleeding', 'fever'] } });
check('emergency alert sent', r.status === 201 && r.json.level === 'emergency', r);
r = await call('GET', '/alerts', { token: doc.access_token });
check('the clinic sees both, EMERGENCY FIRST', r.json?.alerts?.length === 2 && r.json.alerts[0].level === 'emergency' && r.json.alerts[0].full_name === 'Amina Wanjiru' && r.json.alerts[0].symptoms.includes('vaginal_bleeding'), r.json);
const firstAlert = r.json.alerts[0].id;
r = await call('GET', '/alerts', { token: outsider.access_token });
check("another facility sees none of them", r.json?.alerts?.length === 0, r.json);
r = await call('GET', '/patients', { token: doc.access_token });
check('the board shows open_alerts on the patient', r.json?.patients?.find((p) => p.mother_id === motherId)?.open_alerts === 2, r.json?.patients);
r = await call('GET', `/patients/${motherId}`, { token: doc.access_token });
check('her record lists the alerts', r.json?.alerts?.length === 2, r.json?.alerts);
r = await call('POST', `/alerts/${firstAlert}/handle`, { token: outsider.access_token });
check('staff elsewhere cannot mark it handled -> 403', r.status === 403, r);
r = await call('POST', `/alerts/${firstAlert}/handle`, { token: doc.access_token });
check('the clinic marks it handled', r.status === 200, r);
r = await call('GET', '/alerts', { token: doc.access_token });
check('one open alert left', r.json?.alerts?.length === 1, r.json);
r = await call('GET', '/alerts?status=handled', { token: doc.access_token });
check('one handled alert', r.json?.alerts?.length === 1, r.json);
let limited = false;
for (let i = 0; i < 8 && !limited; i++) limited = (await call('POST', '/alerts', { token: mother.access_token, body: { symptoms: ['fever'] } })).status === 429;
check('alert spam is rate-limited (429)', limited);

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
