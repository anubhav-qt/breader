-- Key libraries take files up to 100 MB, like accounts (was 25 MB). New libraries get it from
-- LIMITS.key; this brings the ones made before up to it. The change feed carries it to the laptop.
UPDATE "libraries" SET "file_bytes" = 104857600 WHERE "owner_account_id" IS NULL AND "file_bytes" < 104857600;
