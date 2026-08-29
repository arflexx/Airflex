import fs from "fs";
import path from "path";
import { Pool, PoolClient } from "pg";
import dotenv from "dotenv";

dotenv.config();

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface MigrateOptions {
  pool?: Pool;
  migrationsDir?: string;
  databaseUrl?: string;
}

export function getMigrationsDir(customDir?: string): string {
  if (customDir) return customDir;
  const primary = path.resolve(__dirname, "migrations");
  if (fs.existsSync(primary)) {
    return primary;
  }
  const fallback = path.resolve(__dirname, "../../migrations");
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  return primary;
}

export async function ensureMigrationTable(client: PoolClient | Pool): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function getAppliedMigrations(client: PoolClient | Pool): Promise<string[]> {
  const res = await client.query<{ filename: string }>(
    `SELECT filename FROM schema_migrations ORDER BY id ASC;`
  );
  return res.rows.map((row) => row.filename);
}

export async function runMigrations(options?: MigrateOptions): Promise<MigrationResult> {
  const migrationsDir = getMigrationsDir(options?.migrationsDir);
  const databaseUrl = options?.databaseUrl || process.env["DATABASE_URL"];

  let pool = options?.pool;
  let closePoolOnComplete = false;

  if (!pool) {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL environment variable is required to run migrations");
    }
    pool = new Pool({ connectionString: databaseUrl });
    closePoolOnComplete = true;
  }

  const client = await pool.connect();
  try {
    await ensureMigrationTable(client);

    const appliedList = await getAppliedMigrations(client);
    const appliedSet = new Set(appliedList);

    if (!fs.existsSync(migrationsDir)) {
      console.log("No pending migrations");
      return { applied: [], skipped: [] };
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    const pending = files.filter((file) => !appliedSet.has(file));
    const skipped = files.filter((file) => appliedSet.has(file));

    if (pending.length === 0) {
      console.log("No pending migrations");
      return { applied: [], skipped };
    }

    const applied: string[] = [];

    for (const file of pending) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, "utf-8");

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, NOW());",
          [file]
        );
        await client.query("COMMIT");
        applied.push(file);
        console.log(`Applied migration: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`Failed to apply migration ${file}:`, err);
        throw err;
      }
    }

    return { applied, skipped };
  } finally {
    client.release();
    if (closePoolOnComplete && pool) {
      await pool.end();
    }
  }
}

export async function rollbackLastMigration(options?: MigrateOptions): Promise<string | null> {
  const databaseUrl = options?.databaseUrl || process.env["DATABASE_URL"];

  let pool = options?.pool;
  let closePoolOnComplete = false;

  if (!pool) {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL environment variable is required to rollback migrations");
    }
    pool = new Pool({ connectionString: databaseUrl });
    closePoolOnComplete = true;
  }

  const client = await pool.connect();
  try {
    await ensureMigrationTable(client);

    const res = await client.query<{ id: number; filename: string }>(
      `SELECT id, filename FROM schema_migrations ORDER BY id DESC LIMIT 1;`
    );

    if (res.rows.length === 0) {
      console.log("No migrations to rollback");
      return null;
    }

    const lastMigration = res.rows[0];
    await client.query(`DELETE FROM schema_migrations WHERE id = $1;`, [lastMigration.id]);

    console.log(`Rolled back migration record: ${lastMigration.filename}`);
    console.log(`Migration to reverse: ${lastMigration.filename}`);

    return lastMigration.filename;
  } finally {
    client.release();
    if (closePoolOnComplete && pool) {
      await pool.end();
    }
  }
}

// Standalone CLI execution
if (require.main === module) {
  const isRollback = process.argv.includes("rollback") || process.argv.includes("--rollback");

  const action = isRollback ? rollbackLastMigration() : runMigrations();

  action
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
