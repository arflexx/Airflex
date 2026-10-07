import { execFileSync } from 'child_process';
import path from 'path';

const ENTRY_POINT = path.join(__dirname, '../index.ts');

function runServer(env: Record<string, string | undefined>) {
  const customEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
  };
  delete customEnv.JEST_WORKER_ID;

  try {
    const output = execFileSync(
      process.execPath,
      ['-r', 'ts-node/register', ENTRY_POINT],
      {
        env: customEnv,
        encoding: 'utf8',
        timeout: 8000,
        cwd: path.join(__dirname, '../..'),
      }
    );
    return { code: 0, output };
  } catch (err: any) {
    const combinedOutput = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;
    return { code: err.status ?? 1, output: combinedOutput };
  }
}

describe('server startup env validation', () => {
  const baseValidEnv: Record<string, string | undefined> = {
    NODE_ENV: 'development',
    JWT_SECRET: 'test-secret-at-least-32-chars-long-here',
    DATABASE_URL: 'postgres://localhost/test',
    ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    STELLAR_SERVER_SECRET: 'S000000000000000000000000000000000000000000000000000000',
    PLATFORM_TREASURY_USER_ID: '00000000-0000-0000-0000-000000000000',
    PAYSTACK_SECRET_KEY: 'sk_test_123456',
    TERMII_API_KEY: 'TL12345678901234567890',
  };

  it('exits non-zero with clear validation message when run with an empty environment', () => {
    // Override all required env vars to empty
    const emptyEnv = {
      NODE_ENV: 'development',
      JWT_SECRET: '',
      DATABASE_URL: '',
      ENCRYPTION_KEY: '',
      STELLAR_SERVER_SECRET: '',
      PLATFORM_TREASURY_USER_ID: '',
      PAYSTACK_SECRET_KEY: '',
      TERMII_API_KEY: '',
    };

    const result = runServer(emptyEnv);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('[startup] Missing required environment variables:');
    expect(result.output).toContain('JWT_SECRET');
    expect(result.output).toContain('DATABASE_URL');
    expect(result.output).toContain('ENCRYPTION_KEY');
    expect(result.output).toContain('STELLAR_SERVER_SECRET');
    expect(result.output).toContain('Copy server/.env.example to server/.env');
  });

  it('exits non-zero and logs the missing variable when DATABASE_URL is unset', () => {
    const env = { ...baseValidEnv, DATABASE_URL: '' };

    const result = runServer(env);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('[startup] Missing required environment variables');
    expect(result.output).toContain('DATABASE_URL');
  });

  it('exits non-zero and logs the missing variable when JWT_SECRET is unset', () => {
    const env = { ...baseValidEnv, JWT_SECRET: '' };

    const result = runServer(env);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('JWT_SECRET');
  });

  it('logs a warning when optional Stellar vars are missing', () => {
    const env = {
      ...baseValidEnv,
      STELLAR_NETWORK: '',
      HORIZON_URL: '',
      SOROBAN_RPC_URL: '',
    };

    const result = runServer(env);

    expect(result.output).toContain('Missing optional environment variables');
  });
});