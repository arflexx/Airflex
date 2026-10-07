import { Router } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { getReferralStats } from '../services/referrals';

const router = Router();

/**
 * GET /api/v1/referrals — a user's own referral status and earnings.
 *
 * The endpoint clients actually call at the router's mount path was missing;
 * only the nested /stats path existed, leaving no way to hit
 * GET /api/v1/referrals directly. Both paths return the same payload —
 * /stats is kept for backwards compatibility with any existing callers.
 */
router.get('/', authenticate, async (req, res) => {
  const { sub: userId } = (req as AuthenticatedRequest).user;
  const stats = await getReferralStats(userId);
  res.status(200).json({
    referralCode: stats.referral_code,
    totalReferrals: Number(stats.total_referrals),
    verifiedReferrals: Number(stats.verified_referrals),
    totalRewardsCredited: Number(stats.total_rewards_credited),
  });
});

router.get('/stats', authenticate, async (req, res) => {
  const { sub: userId } = (req as AuthenticatedRequest).user;
  const stats = await getReferralStats(userId);
  res.status(200).json({
    referralCode: stats.referral_code,
    totalReferrals: Number(stats.total_referrals),
    verifiedReferrals: Number(stats.verified_referrals),
    totalRewardsCredited: Number(stats.total_rewards_credited),
  });
});
export default router;
