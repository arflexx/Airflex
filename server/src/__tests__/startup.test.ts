import { execFileSync } from 'child_process';
import path from 'path';

const ENTRY_POINT = path.join(__dirname, '../index.ts');

function runServer(env: Record<string, string | undefined>) {
  try {
    execFileSync('ts-node', [ENTRY_POINT], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 3000,
    });
    return { code: 0, output: '' };
  } catch (err: any) {
    return { code: err.status, output: err.stderr || err.stdout || '' };
  }
}

describe('server startup env validation', () => {
  it('exits non-zero and logs the missing variable when DATABASE_URL is unset', () => {
    const env = { ...process.env, JWT_SECRET: 'test-secret' };
    delete env.DATABASE_URL;

    const result = runServer(env);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('[startup] Missing required environment variables');
    expect(result.output).toContain('DATABASE_URL');
  });

  it('exits non-zero and logs the missing variable when JWT_SECRET is unset', () => {
    const env = { ...process.env, DATABASE_URL: 'postgres://localhost/test' };
    delete env.JWT_SECRET;

    const result = runServer(env);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('JWT_SECRET');
  });

  it('logs a warning but does not exit when only optional Stellar vars are missing', () => {
    const env = {
      ...process.env,
      DATABASE_URL: 'postgres://localhost/test',
      JWT_SECRET: 'test-secret',
    };
    delete env.STELLAR_NETWORK;
    delete env.HORIZON_URL;
    delete env.SOROBAN_RPC_URL;

    const result = runServer(env);

    expect(result.output).toContain('Missing optional environment variables');
  });
});