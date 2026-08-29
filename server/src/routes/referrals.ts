import { Router } from 'express';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { getReferralStats } from '../services/referrals';

const router = Router();
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
