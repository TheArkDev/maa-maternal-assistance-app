-- Platform admin: a user flagged by the project owner who approves new facilities.
ALTER TABLE users ADD COLUMN is_platform_admin INTEGER NOT NULL DEFAULT 0;

-- Facilities get an explicit status so rejected ones are distinguishable from pending ones.
ALTER TABLE facilities ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
UPDATE facilities SET status = CASE WHEN verified = 1 THEN 'verified' ELSE 'pending' END;
