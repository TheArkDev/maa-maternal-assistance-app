-- MAA schema v1 (Cloudflare D1 / SQLite)
-- Timestamps are INTEGER unix milliseconds. IDs are UUIDs (client-generated for synced tables).

CREATE TABLE facilities (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  mfl_code     TEXT UNIQUE,              -- Kenya Master Health Facility List code
  county       TEXT,
  phone        TEXT,
  latitude     REAL,
  longitude    REAL,
  verified     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_facilities_county ON facilities(county);

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  role           TEXT NOT NULL CHECK (role IN ('mother','staff')),
  email          TEXT UNIQUE,
  phone          TEXT UNIQUE,            -- normalised +2547XXXXXXXX
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE refresh_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE staff_memberships (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  facility_id          TEXT NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  staff_role           TEXT NOT NULL CHECK (staff_role IN ('doctor','nurse','chw','facility_admin')),
  registration_number  TEXT,             -- e.g. KMPDC / nursing council number
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected','removed')),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE (user_id, facility_id)
);
CREATE INDEX idx_membership_facility ON staff_memberships(facility_id, status);

CREATE TABLE mothers (
  id                       TEXT PRIMARY KEY,
  user_id                  TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  date_of_birth            TEXT,         -- ISO date
  blood_group              TEXT,
  emergency_contact_name   TEXT,
  emergency_contact_phone  TEXT,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL
);

-- Mother grants a facility access. Verified staff of that facility can read her record while revoked_at IS NULL.
CREATE TABLE care_links (
  id                     TEXT PRIMARY KEY,
  mother_id              TEXT NOT NULL REFERENCES mothers(id) ON DELETE CASCADE,
  facility_id            TEXT NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  assigned_staff_user_id TEXT REFERENCES users(id),
  granted_at             INTEGER NOT NULL,
  revoked_at             INTEGER
);
CREATE INDEX idx_carelinks_mother ON care_links(mother_id, revoked_at);
CREATE INDEX idx_carelinks_facility ON care_links(facility_id, revoked_at);
CREATE UNIQUE INDEX idx_carelinks_active ON care_links(mother_id, facility_id) WHERE revoked_at IS NULL;

-- Short-lived single-use codes a mother shows (or as QR) to a clinician to start a link.
CREATE TABLE join_codes (
  code        TEXT PRIMARY KEY,
  mother_id   TEXT NOT NULL REFERENCES mothers(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

-- ---- Synced, mother-owned tables ------------------------------------------
-- updated_at        : client logical clock, used for last-write-wins
-- server_updated_at : set by server on every write, used as the pull cursor
-- deleted_at        : soft delete tombstone

CREATE TABLE pregnancies (
  id                 TEXT PRIMARY KEY,
  mother_id          TEXT NOT NULL REFERENCES mothers(id) ON DELETE CASCADE,
  lmp_date           TEXT,
  due_date           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','delivered','lost')),
  gravida            INTEGER,
  parity             INTEGER,
  updated_at         INTEGER NOT NULL,
  server_updated_at  INTEGER NOT NULL,
  deleted_at         INTEGER
);
CREATE INDEX idx_preg_mother ON pregnancies(mother_id);
CREATE INDEX idx_preg_sync ON pregnancies(mother_id, server_updated_at);

CREATE TABLE vitals (
  id                 TEXT PRIMARY KEY,
  pregnancy_id       TEXT NOT NULL REFERENCES pregnancies(id) ON DELETE CASCADE,
  source             TEXT NOT NULL DEFAULT 'self' CHECK (source IN ('self','clinic')),
  measured_at        INTEGER NOT NULL,
  systolic           INTEGER,
  diastolic          INTEGER,
  weight_kg          REAL,
  temperature_c      REAL,
  risk_flag          TEXT CHECK (risk_flag IN ('routine','urgent','emergency')),
  updated_at         INTEGER NOT NULL,
  server_updated_at  INTEGER NOT NULL,
  deleted_at         INTEGER
);
CREATE INDEX idx_vitals_preg ON vitals(pregnancy_id, measured_at);
CREATE INDEX idx_vitals_sync ON vitals(server_updated_at);

CREATE TABLE kick_counts (
  id                 TEXT PRIMARY KEY,
  pregnancy_id       TEXT NOT NULL REFERENCES pregnancies(id) ON DELETE CASCADE,
  counted_at         INTEGER NOT NULL,
  kicks              INTEGER NOT NULL,
  minutes            INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  server_updated_at  INTEGER NOT NULL,
  deleted_at         INTEGER
);
CREATE INDEX idx_kicks_preg ON kick_counts(pregnancy_id, counted_at);
CREATE INDEX idx_kicks_sync ON kick_counts(server_updated_at);

CREATE TABLE medications (
  id                 TEXT PRIMARY KEY,
  pregnancy_id       TEXT NOT NULL REFERENCES pregnancies(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  dose               TEXT,
  times_per_day      INTEGER,
  start_date         TEXT,
  end_date           TEXT,
  notes              TEXT,
  updated_at         INTEGER NOT NULL,
  server_updated_at  INTEGER NOT NULL,
  deleted_at         INTEGER
);
CREATE INDEX idx_meds_preg ON medications(pregnancy_id);
CREATE INDEX idx_meds_sync ON medications(server_updated_at);

CREATE TABLE appointments (
  id                 TEXT PRIMARY KEY,
  pregnancy_id       TEXT NOT NULL REFERENCES pregnancies(id) ON DELETE CASCADE,
  facility_id        TEXT REFERENCES facilities(id),
  scheduled_at       INTEGER NOT NULL,
  purpose            TEXT,
  status             TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','attended','missed','cancelled')),
  updated_at         INTEGER NOT NULL,
  server_updated_at  INTEGER NOT NULL,
  deleted_at         INTEGER
);
CREATE INDEX idx_appt_preg ON appointments(pregnancy_id, scheduled_at);
CREATE INDEX idx_appt_sync ON appointments(server_updated_at);

-- ---- Staff-written (read-only for the mother) -----------------------------
CREATE TABLE visits (
  id                 TEXT PRIMARY KEY,
  pregnancy_id       TEXT NOT NULL REFERENCES pregnancies(id) ON DELETE CASCADE,
  facility_id        TEXT NOT NULL REFERENCES facilities(id),
  recorded_by        TEXT NOT NULL REFERENCES users(id),
  visit_date         TEXT NOT NULL,
  gestation_weeks    INTEGER,
  weight_kg          REAL,
  systolic           INTEGER,
  diastolic          INTEGER,
  fundal_height_cm   REAL,
  fetal_heart_rate   INTEGER,
  notes              TEXT,
  next_visit_date    TEXT,
  risk_flag          TEXT CHECK (risk_flag IN ('routine','urgent','emergency')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  server_updated_at  INTEGER NOT NULL,
  deleted_at         INTEGER
);
CREATE INDEX idx_visits_preg ON visits(pregnancy_id, visit_date);
CREATE INDEX idx_visits_sync ON visits(server_updated_at);

-- Who looked at / changed whose record.
CREATE TABLE audit_log (
  id             TEXT PRIMARY KEY,
  actor_user_id  TEXT NOT NULL,
  facility_id    TEXT,
  mother_id      TEXT,
  action         TEXT NOT NULL,
  entity         TEXT,
  entity_id      TEXT,
  at             INTEGER NOT NULL
);
CREATE INDEX idx_audit_mother ON audit_log(mother_id, at);
