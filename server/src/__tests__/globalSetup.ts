import { Client } from "pg";
import { readFileSync } from "fs";
import path from "path";

/**
 * globalSetup.ts — runs ONCE before the whole Jest suite (before any worker).
 *
 * Responsibilities:
 *   1. Provision a dedicated test database (`airflex_test`), dropping any
 *      leftover copy first so every run starts from a clean slate.
 *   2. Migrate it by applying src/__tests__/fixtures/schema.sql.
 *
 * Teardown (dropping the database) happens in globalTeardown.ts.
 */

export const TEST_DB_NAME = "airflex_test";

/** Admin connection string used only to create/drop the test database. */
function adminUrl(): string {
  if (process.env["TEST_ADMIN_DATABASE_URL"]) {
    return process.env["TEST_ADMIN_DATABASE_URL"];
  }
  // Derive from TEST_DATABASE_URL / DATABASE_URL by pointing at the
  // maintenance database ("postgres") with the same credentials + host.
  const source = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"]
    ?? `postgresql://postgres:postgres@localhost:5432/${TEST_DB_NAME}`;
  const url = new URL(source);
  url.pathname = "/postgres";
  return url.toString();
}

export default async function globalSetup(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();

  try {
    // Drop leftovers from an aborted previous run. FORCE terminates any
    // lingering connections (PG13+).
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);

    const schemaPath = path.join(__dirname, "fixtures", "schema.sql");
    const schema = readFileSync(schemaPath, "utf8");

    const target = new Client({
      connectionString: process.env["TEST_DATABASE_URL"] ??
        adminUrl().replace(/\/postgres$/, `/${TEST_DB_NAME}`),
    });

    await target.connect();
    try {
      await target.query(schema);
    } finally {
      await target.end();
    }

    // eslint-disable-next-line no-console
    console.log(`[test:globalSetup] Database "${TEST_DB_NAME}" provisioned and migrated.`);
  } finally {
    await admin.end();
  }
}
