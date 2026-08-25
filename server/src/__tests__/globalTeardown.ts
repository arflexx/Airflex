import { Client } from "pg";

/**
 * globalTeardown.ts — runs once after the entire suite has finished.
 * Drops the test database provisioned in globalSetup.ts.
 */

const TEST_DB_NAME = "airflex_test";

function adminUrl(): string {
  if (process.env["TEST_ADMIN_DATABASE_URL"]) {
    return process.env["TEST_ADMIN_DATABASE_URL"];
  }
  const source = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"]
    ?? `postgresql://postgres:postgres@localhost:5432/${TEST_DB_NAME}`;
  const url = new URL(source);
  url.pathname = "/postgres";
  return url.toString();
}

export default async function globalTeardown(): Promise<void> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
    // eslint-disable-next-line no-console
    console.log(`[test:globalTeardown] Database "${TEST_DB_NAME}" dropped.`);
  } finally {
    await admin.end();
  }
}
