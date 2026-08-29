process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://test:test@localhost:5432/test';
import { createReferralCode } from './referrals';

describe('referral code generation', () => {
  it('creates an eight-character code from the supported alphabet', () => {
    const code = createReferralCode(() => 0);
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[A-Z2-9]+$/);
  });

  it('uses each random position independently', () => {
    let next = 0;
    const code = createReferralCode(() => (next++ % 32) / 32);
    expect(code).toHaveLength(8);
    expect(new Set(code).size).toBeGreaterThan(1);
  });
});
