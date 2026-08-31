import fs from "fs";
import path from "path";
import os from "os";
import { runMigrations, rollbackLastMigration, ensureMigrationTable } from "./migrate";

describe("Database Migrations CLI (migrate.ts)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "airflex-migrate-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it("creates schema_migrations table if not exists", async () => {
    const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
    const mockClient = {
      query: mockQuery,
      release: jest.fn(),
    };
    await ensureMigrationTable(mockClient as any);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS schema_migrations")
    );
  });

  it("executes and records a new migration file when not previously applied", async () => {
    const migrationFile = "001_test_migration.sql";
    const migrationSql = "CREATE TABLE test_table (id INT);";
    fs.writeFileSync(path.join(tempDir, migrationFile), migrationSql);

    const queryLog: Array<{ text: string; params?: unknown[] }> = [];
    const mockClient = {
      query: jest.fn().mockImplementation(async (text: string, params?: unknown[]) => {
        queryLog.push({ text, params });
        if (text.includes("SELECT filename FROM schema_migrations")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    const mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
    };

    const result = await runMigrations({
      pool: mockPool as any,
      migrationsDir: tempDir,
    });

    expect(result.applied).toEqual([migrationFile]);
    expect(result.skipped).toEqual([]);

    // Verify transaction and insertion
    expect(mockClient.query).toHaveBeenCalledWith("BEGIN");
    expect(mockClient.query).toHaveBeenCalledWith(migrationSql);
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO schema_migrations"),
      [migrationFile]
    );
    expect(mockClient.query).toHaveBeenCalledWith("COMMIT");
    expect(mockClient.release).toHaveBeenCalled();
  });

  it("skips previously applied migration file and reports no pending migrations", async () => {
    const migrationFile = "001_test_migration.sql";
    fs.writeFileSync(path.join(tempDir, migrationFile), "SELECT 1;");

    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    const mockClient = {
      query: jest.fn().mockImplementation(async (text: string) => {
        if (text.includes("SELECT filename FROM schema_migrations")) {
          return { rows: [{ filename: migrationFile }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    const mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
    };

    const result = await runMigrations({
      pool: mockPool as any,
      migrationsDir: tempDir,
    });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([migrationFile]);
    expect(consoleSpy).toHaveBeenCalledWith("No pending migrations");
    expect(mockClient.query).not.toHaveBeenCalledWith("BEGIN");
  });

  it("rolls back the last migration by removing it from schema_migrations", async () => {
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    const mockClient = {
      query: jest.fn().mockImplementation(async (text: string) => {
        if (text.includes("SELECT id, filename FROM schema_migrations")) {
          return { rows: [{ id: 42, filename: "002_kyc.sql" }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };

    const mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
    };

    const rolledBackFile = await rollbackLastMigration({
      pool: mockPool as any,
    });

    expect(rolledBackFile).toBe("002_kyc.sql");
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM schema_migrations WHERE id = $1"),
      [42]
    );
    expect(consoleSpy).toHaveBeenCalledWith("Rolled back migration record: 002_kyc.sql");
    expect(consoleSpy).toHaveBeenCalledWith("Migration to reverse: 002_kyc.sql");
  });
});
