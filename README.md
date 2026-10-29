# MAA: Maternal Assistance App

Flutter app for Kenyan expectant mothers and the clinicians who care for them, backed by a
Cloudflare Worker + D1 database. See the design doc for the data model.

```
maa/
  backend/   Cloudflare Worker (Hono, TypeScript) + D1 schema + end-to-end smoke test
  app/       Flutter app (Riverpod, go_router, Dio, sqflite)
```

## Verification status (be clear-eyed about this)

| Part | Status |
|---|---|
| Backend: typechecks (`tsc --noEmit`) | verified |
| Backend: end-to-end tests against a real local D1 (`scripts/smoke.mjs`, `scripts/smoke-admin.mjs`) | verified: 50/50 and 23/23 passing |
| Flutter: danger-sign triage, pregnancy maths, phone normalisation, EN/SW string parity | verified: 38 tests run and passing under Dart 3.13 |
| Flutter: UI, router, Dio client, sqflite storage, sync engine | **written but never compiled or run**. The build environment could not download the Flutter SDK. Static analysis found no syntax errors, but expect a first round of small compile fixes. |

Nothing here has been reviewed by a clinician. See "Before real patients" below.

## Backend

### Option A: deploy straight to your online Cloudflare account (no local server)

You need Node.js 20+ on your computer. Wrangler logs in to your Cloudflare account in the browser.

```bash
cd backend
npm install
npx wrangler login                          # opens a browser: approve access to your account
npx wrangler d1 create maa-db               # prints a database_id
```

1. Paste that `database_id` into `backend/wrangler.toml` (replace the zeros).
2. Create the tables in your online database:

```bash
npx wrangler d1 migrations apply maa-db --remote
```

3. Set the two secrets (Wrangler prompts you to paste each value; make them long and random,
   e.g. `openssl rand -base64 32`):

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_API_KEY
```

4. Deploy:

```bash
npx wrangler deploy
```

It prints your URL, like `https://maa-api.<your-subdomain>.workers.dev`. Check it:
`curl https://maa-api.<your-subdomain>.workers.dev/health` should return `{"ok":true}`.

5. Point the Flutter app at it: `flutter run --dart-define=API_BASE_URL=https://maa-api.<your-subdomain>.workers.dev`

6. Optional end-to-end test against the online Worker (creates fake test accounts in that database,
   so prefer a throwaway database):
   `BASE=https://maa-api.<your-subdomain>.workers.dev ADMIN_KEY=<your ADMIN_API_KEY> node scripts/smoke.mjs`

No Node on your computer? In the Cloudflare dashboard you can instead connect a GitHub repo under
Workers & Pages (root directory `backend`, deploy command `npx wrangler deploy`), and run
`migrations/0001_init.sql` in the D1 database's Console tab. Bindings and secrets are then set in the dashboard.

### Option B: run locally for development

```bash
cd backend
npm install
cp .dev.vars.example .dev.vars            # local secrets
npx wrangler d1 migrations apply maa-db --local
npx wrangler dev                          # http://localhost:8787
# in another terminal, with a FRESH local db:
node scripts/smoke.mjs

# deploy
npx wrangler d1 create maa-db             # paste the database_id into wrangler.toml
npx wrangler d1 migrations apply maa-db --remote
npx wrangler secret put JWT_SECRET        # 32+ random characters
npx wrangler secret put ADMIN_API_KEY     # used only to verify facilities
npx wrangler deploy
```

Verify a newly registered facility (and its founding administrator):

```bash
curl -X POST https://<worker>/admin/facilities/<facility_id>/verify -H "x-admin-key: <ADMIN_API_KEY>"
```

Key design points: staff can read a mother's data only through a verified membership at a facility
that holds an active, mother-granted care link (`requireMotherAccess` in `middleware.ts`, used by every
staff data route). Every staff view or write is audit-logged. Offline sync is last-write-wins on
`updated_at`, with a server-side pull cursor.

### Platform admin (approves new facilities)

Approval has two levels: the **platform admin** (you) approves each new *facility*; that facility's own
**admin** (its founder) then approves the doctors and nurses who join it.

1. Apply the second migration to your database (deploys do not touch the database). In the Cloudflare
   dashboard open D1 -> `maa-db` -> Console and run the contents of `backend/migrations/0002_platform_admin.sql`
   (or `npx wrangler d1 migrations apply maa-db --remote`).
2. Register a normal account in the app for yourself (the "expectant mother" sign-up is the quickest), with a
   phone number or email only you control. Use a dedicated account, not one used for care.
3. In the D1 Console flag that account (use your own phone in +254 form, or `email = '...'`):

```sql
UPDATE users SET is_platform_admin = 1 WHERE phone = '+254712345678';
```

4. Sign out and back in. You land on **Facility approvals**: each pending facility with its founder's name and
   professional registration number. Approve or reject. Check the registration number first; this is the
   only identity check in the system.

There is no self-service way to become an admin: the flag can only be set in the database. It is re-checked on
every request, so clearing it (`SET is_platform_admin = 0`) removes access immediately.

## Flutter app

Install Flutter, then:

```bash
cd app
flutter create . --platforms=android,ios --project-name maa_app --org ke.maa
# if it generated test/widget_test.dart, delete it (it is the default counter test)
flutter pub get
flutter test
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8787     # Android emulator -> local Worker
```

Android notes:
- Release builds need `<uses-permission android:name="android.permission.INTERNET"/>` in
  `android/app/src/main/AndroidManifest.xml` (flutter create only adds it to debug/profile).
- For local `http://` development add `android:usesCleartextTraffic="true"` to the **debug** manifest only.
- For the call-emergency button on Android 11+, add to the manifest:
  `<queries><intent><action android:name="android.intent.action.DIAL"/><data android:scheme="tel"/></intent></queries>`
- If the build complains, raise `minSdk` to 23.

## What is in milestone 1

Mother: sign-up/login (phone or email), pregnancy setup (LMP or due date), week/trimester/due-date home,
offline danger-sign checker, BP/weight/temperature log with instant risk warning, kick counter, clinic
sharing code and revocation, visits and appointments from her clinic, offline-first sync, English/Swahili.

Clinician: sign-up with facility search or new facility, facility-admin approvals of staff, platform-admin approval of facilities, patient list sorted by
risk, patient record, record a visit, link a patient by code.

Public: danger-sign checker works with no account and no connection.

## Known limitations / next milestones

- Local reminders (medications, appointments) and the medications screen: tables and sync exist, UI does not.
- Push notifications (FCM), SMS (design leaves a seam for it).
- Clinician side is online-only (no offline cache).
- A push the server permanently rejects will be retried forever; add a dead-letter state.
- The local SQLite database is not encrypted at rest; consider SQLCipher.
- No rate limiting on login or join-code redemption: add Cloudflare rate-limiting rules before launch.
- Mother profile fields (date of birth, blood group, emergency contact) have no edit screen yet.

## Before real patients

1. A clinician must review `backend/src/safety.ts` and `app/lib/core/safety/danger_signs.dart`
   (thresholds, symptoms, wording) against current Kenya MoH / WHO guidance. Keep the two files in sync.
2. Native Swahili review of `app/lib/core/l10n/strings.dart`.
3. Confirm emergency numbers in `app/lib/core/config.dart`.
4. Kenya Data Protection Act 2019: health data is sensitive personal data. Register with the ODPC,
   write a privacy notice, implement account/data deletion, and take legal advice.
5. Penetration test, backups of D1, and a monitored production Worker.
