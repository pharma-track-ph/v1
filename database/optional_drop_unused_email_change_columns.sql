-- OPTIONAL CLEAN-UP: drop 5 unused columns from `users` email_change_otp_hash

-- Step 1: look.
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
