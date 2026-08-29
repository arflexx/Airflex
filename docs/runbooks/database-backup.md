# Runbook: Database Backup & Restore

**Service:** AirFlex PostgreSQL (Railway)
**Backup storage:** S3-compatible bucket (configured via `BACKUP_S3_BUCKET` secret)
**Encryption:** AES-256-CBC via `openssl enc`
**Retention:** 30 days (enforced by bucket lifecycle policy — see setup below)
**On-call channel:** `#ops` (Slack notifications on every backup success/failure)

---

## Table of Contents

1. [Architecture overview](#1-architecture-overview)
2. [Required secrets](#2-required-secrets)
3. [S3 bucket lifecycle policy (30-day retention)](#3-s3-bucket-lifecycle-policy)
4. [Trigger a manual backup](#4-trigger-a-manual-backup)
5. [List available backups](#5-list-available-backups)
6. [Restore from a specific backup](#6-restore-from-a-specific-backup)
7. [Monthly restore test procedure](#7-monthly-restore-test-procedure)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Architecture overview

```
GitHub Actions (02:00 UTC daily)
        │
        ▼
  pg_dump (production DB)
        │
        ▼
  gzip compression
        │
        ▼
  openssl AES-256-CBC encryption
        │
        ▼
  aws s3 cp → s3://<bucket>/backups/YYYY/MM/DD/<filename>.sql.gz.enc
        │
        ▼
  Slack notification (#ops)
```

Backup files are named:
```
airflex-backup-<YYYYMMDDTHHMMSSZ>.sql.gz.enc
```

---

## 2. Required secrets

These must be set in **GitHub → Repository → Settings → Secrets → Actions**:

| Secret | Description |
|--------|-------------|
| `DATABASE_URL` | Production PostgreSQL connection string |
| `BACKUP_S3_BUCKET` | S3 bucket name, e.g. `airflex-backups` |
| `BACKUP_S3_ENDPOINT` | S3 endpoint URL, e.g. `https://s3.amazonaws.com` |
| `BACKUP_S3_REGION` | AWS region, e.g. `us-east-1` |
| `AWS_ACCESS_KEY_ID` | IAM key with `s3:PutObject` and `s3:GetObject` on the bucket |
| `AWS_SECRET_ACCESS_KEY` | Corresponding IAM secret |
| `BACKUP_ENCRYPTION_KEY` | AES-256 passphrase (minimum 32 characters, store in a password manager) |
| `SLACK_BACKUP_WEBHOOK_URL` | Slack incoming webhook URL for `#ops` |

---

## 3. S3 bucket lifecycle policy (30-day retention)

Apply this lifecycle rule to automatically delete backups older than 30 days.

**AWS Console:** S3 → Your bucket → Management → Lifecycle rules → Create rule

**Or via AWS CLI:**

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket <YOUR_BUCKET_NAME> \
  --lifecycle-configuration '{
    "Rules": [
      {
        "ID": "airflex-backup-30day-retention",
        "Status": "Enabled",
        "Filter": { "Prefix": "backups/" },
        "Expiration": { "Days": 30 },
        "NoncurrentVersionExpiration": { "NoncurrentDays": 7 }
      }
    ]
  }'
```

Verify the rule was applied:

```bash
aws s3api get-bucket-lifecycle-configuration --bucket <YOUR_BUCKET_NAME>
```

---

## 4. Trigger a manual backup

### Via GitHub Actions UI

1. Go to **Actions → Database Backup**.
2. Click **Run workflow** (top-right).
3. Enter an optional reason (recorded in the job summary and Slack notification).
4. Click **Run workflow**.
5. Monitor progress in the workflow run log.
6. Check `#ops` for the success/failure Slack notification.

### Via GitHub CLI

```bash
gh workflow run db-backup.yml \
  --field reason="Pre-migration manual backup"
```

---

## 5. List available backups

### All backups

```bash
aws s3 ls \
  s3://<BACKUP_S3_BUCKET>/backups/ \
  --recursive \
  --endpoint-url <BACKUP_S3_ENDPOINT> \
  --human-readable \
  | sort
```

### Backups for a specific date

```bash
DATE="2026/08/27"   # YYYY/MM/DD

aws s3 ls \
  "s3://<BACKUP_S3_BUCKET>/backups/${DATE}/" \
  --endpoint-url <BACKUP_S3_ENDPOINT> \
  --human-readable
```

---

## 6. Restore from a specific backup

> **Warning:** Restoring to a running production database will overwrite existing data.
> Always restore to a **new, empty database** first and validate before switching traffic.

### Step 1 — Download the encrypted backup

```bash
# Replace with the actual S3 key from step 5
S3_KEY="backups/2026/08/27/airflex-backup-20260827T020012Z.sql.gz.enc"
ENCRYPTED_FILE="$(basename ${S3_KEY})"

aws s3 cp \
  "s3://<BACKUP_S3_BUCKET>/${S3_KEY}" \
  "${ENCRYPTED_FILE}" \
  --endpoint-url <BACKUP_S3_ENDPOINT>
```

### Step 2 — Decrypt

```bash
COMPRESSED_FILE="${ENCRYPTED_FILE%.enc}"

openssl enc -d -aes-256-cbc \
  -pbkdf2 \
  -iter 600000 \
  -in  "${ENCRYPTED_FILE}" \
  -out "${COMPRESSED_FILE}" \
  -pass "pass:<BACKUP_ENCRYPTION_KEY>"
```

### Step 3 — Decompress

```bash
SQL_FILE="${COMPRESSED_FILE%.gz}"
gunzip -c "${COMPRESSED_FILE}" > "${SQL_FILE}"
```

### Step 4 — Create a new target database

```bash
# Example using psql connected to your PostgreSQL server
psql "$ADMIN_DATABASE_URL" -c "CREATE DATABASE airflex_restore;"
```

### Step 5 — Restore

```bash
TARGET_URL="postgresql://user:password@host:5432/airflex_restore"

psql "$TARGET_URL" < "${SQL_FILE}"
```

### Step 6 — Smoke-test the restored database

```bash
psql "$TARGET_URL" <<SQL
-- Verify row counts look reasonable
SELECT 'users'        AS tbl, COUNT(*) FROM users
UNION ALL
SELECT 'wallets',              COUNT(*) FROM wallets
UNION ALL
SELECT 'trade_offers',         COUNT(*) FROM trade_offers
UNION ALL
SELECT 'transactions',         COUNT(*) FROM transactions;

-- Spot-check a recent trade
SELECT id, status, created_at
FROM trade_offers
ORDER BY created_at DESC
LIMIT 5;
SQL
```

### Step 7 — Clean up

```bash
# Remove local files once restore is validated
rm -f "${ENCRYPTED_FILE}" "${COMPRESSED_FILE}" "${SQL_FILE}"
```

### Step 8 — Switch production traffic (if this is a real recovery)

1. Update `DATABASE_URL` in Railway to point to the restored database.
2. Redeploy the server.
3. Verify `/ready` returns `{"status":"ready","db":"ok"}`.
4. Drop the old broken database once confident the restore is stable.

---

## 7. Monthly restore test procedure

A restore test must be performed on or before the **first Monday of each month**.
The goal is to confirm that backups are valid and the restore procedure works end-to-end.

**Performing the test:**

1. Follow steps 1–6 in [section 6](#6-restore-from-a-specific-backup) using the most recent backup.
2. Record the results in the table below.
3. Drop the temporary database:
   ```bash
   psql "$ADMIN_DATABASE_URL" -c "DROP DATABASE airflex_restore;"
   ```

**Log of completed restore tests:**

| Date | Backup used | Rows (users) | Rows (trades) | Tester | Notes |
|------|-------------|-------------|---------------|--------|-------|
| <!-- YYYY-MM-DD --> | <!-- backup key --> | <!-- count --> | <!-- count --> | <!-- @handle --> | First test |

> Copy the last row and fill in the details for each monthly test.

---

## 8. Troubleshooting

### Backup job fails at `pg_dump` step

**Symptom:** `pg_dump: error: connection to server … failed`

**Check:**
- Is `DATABASE_URL` secret set and correct in GitHub Actions?
- Is the production database accepting connections from GitHub Actions runner IPs?
  Railway by default allows all inbound connections; if you've added IP allowlisting, add the GitHub Actions IP ranges.
- Run a manual backup and inspect the full workflow log.

---

### Backup job fails at `Upload to S3` step

**Symptom:** `An error occurred (AccessDenied) when calling the PutObject operation`

**Check:**
- Verify `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets are set.
- Verify the IAM policy attached to the key includes `s3:PutObject` for the bucket ARN.
- Verify `BACKUP_S3_BUCKET` and `BACKUP_S3_ENDPOINT` are correct.

---

### Decrypt fails with `bad decrypt`

**Symptom:** `openssl: bad decrypt` during restore step 2.

**Cause:** The `BACKUP_ENCRYPTION_KEY` used to decrypt does not match the key used when the backup was created.

**Action:**
- Retrieve the key from your password manager.
- Do **not** rotate `BACKUP_ENCRYPTION_KEY` without first re-encrypting all existing backups, or noting the cutover date.

---

### Restore produces an empty or partial database

**Symptom:** Row counts in the smoke test are 0 or significantly lower than expected.

**Check:**
- Was the `pg_dump` run against the correct `DATABASE_URL` (production, not staging)?
- Inspect the SQL file for errors before restoring: `head -100 "${SQL_FILE}"`.
- Check the GitHub Actions log for warnings during the dump step.
