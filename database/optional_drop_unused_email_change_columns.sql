-- ============================================================
-- OPTIONAL CLEAN-UP: drop 5 unused columns from `users`
-- ============================================================
-- email_change_otp_hash, email_change_expires_at, email_change_attempts,
-- email_change_target_id, email_change_new_email
--
-- They belonged to an old design of the email-change code. The pending code is
-- kept in server memory now, and NOTHING in the application reads or writes
-- these columns any more. They are harmless, but dead columns are clutter, and
-- one of them (email_change_new_email) could hold an old pending address.
--
-- NOT required. The application works the same whether they exist or not.
--
-- ORDER: deploy the new code to Render FIRST, then run this. (The OLD code
-- re-adds the columns every time it starts, so dropping them before the new
-- code is live just gets undone at the next restart -- harmless, only pointless.)
--
-- BEFORE YOU RUN IT: take a backup (Backup & Restore page), and run step 1.

-- Step 1: look. Both numbers should be 0 (nothing is stored in them).
SELECT
    SUM(email_change_otp_hash  IS NOT NULL) AS rows_with_old_otp_hash,
    SUM(email_change_new_email IS NOT NULL) AS rows_with_old_pending_email
FROM users;

-- Step 2: drop them (run once; it errors harmlessly if a column is already gone).
ALTER TABLE users
    DROP COLUMN email_change_otp_hash,
    DROP COLUMN email_change_expires_at,
    DROP COLUMN email_change_attempts,
    DROP COLUMN email_change_target_id,
    DROP COLUMN email_change_new_email;
