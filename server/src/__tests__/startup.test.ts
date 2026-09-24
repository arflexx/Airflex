import { execFileSync } from 'child_process';
import path from 'path';

const ENTRY_POINT = path.join(__dirname, '../index.ts');

function runServer(env: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    Path: process.env["Path"],
    PATHEXT: process.env["PATHEXT"],
    SystemRoot: process.env["SystemRoot"],
    WINDIR: process.env["WINDIR"],
    HOME: process.env["HOME"],
    TEMP: process.env["TEMP"],
    TMP: process.env["TMP"],
    ...env,
  };
  for (const key of Object.keys(childEnv)) {
    if (childEnv[key] === undefined) {
      delete childEnv[key];
    }
  }

  try {
    execFileSync(process.execPath, ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', ENTRY_POINT], {
      env: childEnv,
      encoding: 'utf8',
      timeout: 20000,
    });
    return { code: 0, output: '' };
  } catch (err: any) {
    return { code: err.status, output: err.stderr || err.stdout || '' };
  }
}

function validStartupEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    JEST_WORKER_ID: undefined,
    NODE_OPTIONS: undefined,
    DOTENV_CONFIG_PATH: path.join(__dirname, 'missing.env'),
    DATABASE_URL: 'postgres://localhost/test',
    JWT_SECRET: 'test-secret',
    ENCRYPTION_KEY: 'a'.repeat(64),
    STELLAR_SERVER_SECRET: 'test-stellar-secret',
    PLATFORM_TREASURY_USER_ID: 'treasury-user',
    PAYSTACK_SECRET_KEY: 'paystack-secret',
    TERMII_API_KEY: 'termii-secret',
    ESCROW_CONTRACT_ID: 'escrow-contract',
    MARKETPLACE_CONTRACT_ID: 'marketplace-contract',
    PORT: '3001',
  };
}

describe('server startup env validation', () => {
  it('exits non-zero and logs the missing variable when DATABASE_URL is unset', () => {
    const env = validStartupEnv();
    env.DATABASE_URL = undefined;

    const result = runServer(env);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('DATABASE_URL environment variable is required');
    expect(result.output).toContain('DATABASE_URL');
  });

  it('exits non-zero and logs the missing variable when JWT_SECRET is unset', () => {
    const env = validStartupEnv();
    env.JWT_SECRET = undefined;

    const result = runServer(env);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('JWT_SECRET');
  });

  it('does not report optional Stellar vars as required at startup', () => {
    const env = validStartupEnv();
    env.STELLAR_NETWORK = undefined;
    env.HORIZON_URL = undefined;
    env.SOROBAN_RPC_URL = undefined;

    const result = runServer(env);

    expect(result.output).not.toContain('[startup] Missing required environment variables');
    expect(result.output).not.toContain('STELLAR_NETWORK');
    expect(result.output).not.toContain('HORIZON_URL');
    expect(result.output).not.toContain('SOROBAN_RPC_URL');
  });
});
