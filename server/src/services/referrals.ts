import type { PoolClient } from 'pg';
import pool from '../db';
import { WalletService } from './wallet';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_REWARD = 50;

export function createReferralCode(random = Math.random): string {
  let code = '';
  for (let index = 0; index < 8; index += 1) code += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return code;
}

export async function creditReferralReward(client: PoolClient, referredId: string, tradeId: string): Promise<boolean> {
  const configured = Number.parseFloat(process.env['REFERRAL_REWARD_NGN'] ?? String(DEFAULT_REWARD));
  const amount = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REWARD;
  const { rows } = await client.query<{ referrer_id: string }>(
    `UPDATE referrals SET rewarded_at = NOW()
      WHERE referred_id = $1 AND rewarded_at IS NULL RETURNING referrer_id`, [referredId]
  );
  const referrerId = rows[0]?.referrer_id;
  if (!referrerId) return false;
  await new WalletService(client).credit({ userId: referrerId, amount, type: 'referral_reward', tradeId });
  return true;
}

export async function getReferralStats(userId: string) {
  const configured = Number.parseFloat(process.env['REFERRAL_REWARD_NGN'] ?? String(DEFAULT_REWARD));
  const reward = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REWARD;
  const { rows } = await pool.query(`SELECT u.referral_code,
    COUNT(r.referred_id)::text AS total_referrals,
    COUNT(r.referred_id) FILTER (WHERE r.rewarded_at IS NOT NULL)::text AS verified_referrals,
    COALESCE(SUM(CASE WHEN r.rewarded_at IS NOT NULL THEN $2 ELSE 0 END), 0)::text AS total_rewards_credited
    FROM users u LEFT JOIN referrals r ON r.referrer_id = u.id WHERE u.id = $1 GROUP BY u.id, u.referral_code`, [userId, reward]);
  return rows[0] ?? { referral_code: null, total_referrals: '0', verified_referrals: '0', total_rewards_credited: '0' };
}
