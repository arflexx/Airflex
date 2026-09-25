/**
 * stellar-keypair.test.ts
 *
 * Fail-fast coverage for issue #313: the server signing key is validated
 * once at module load, so a missing/invalid STELLAR_SERVER_SECRET refuses
 * to boot instead of failing queued release jobs at runtime.
 */

describe('server keypair module load (#313)', () => {
  const ENV_KEY = 'STELLAR_SERVER_SECRET';
  const VALID_THROWAY_SECRET =
    'SAIXYZSSAQUEJO3Z3LUQ4PM3VVDK3DIO55V76ORFO6HH2VULC43AFHZX';
  const VALID_THROWAY_PUBLIC =
    'GC22X7O3A4GTASUA732CHL6DICNFSO46L5VLYBMRHRUKT5DCBOXHWURF';
  let saved: string | undefined;

  beforeEach(() => {
    jest.resetModules();
    saved = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = saved;
    jest.resetModules();
  });

  it('exposes a keypair matching the configured secret', () => {
    process.env[ENV_KEY] = VALID_THROWAY_SECRET;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./stellar') as {
      getServerKeypair: () => { publicKey: () => string };
    };
    expect(mod.getServerKeypair().publicKey()).toBe(VALID_THROWAY_PUBLIC);
  });

  it('refuses to load when the secret is missing', () => {
    delete process.env[ENV_KEY];
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./stellar');
    }).toThrow('STELLAR_SERVER_SECRET environment variable is not set');
  });

  it('refuses to load when the secret is invalid', () => {
    process.env[ENV_KEY] =
      'SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('./stellar');
    }).toThrow('STELLAR_SERVER_SECRET is invalid');
  });
});
