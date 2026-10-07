import { Router, type Request, type Response } from "express";

const router = Router();

// Default exchange rate: 1 USDC = 1600 NGN
const DEFAULT_NGN_PER_USDC = 1600;

/**
 * GET /api/v1/rates
 * Returns conversion rate for fiat (NGN) to stablecoin (USDC).
 */
router.get("/", (_req: Request, res: Response) => {
  const rate = parseFloat(process.env["NGN_PER_USDC_RATE"] ?? "") || DEFAULT_NGN_PER_USDC;
  res.status(200).json({
    rate,
    base: "NGN",
    target: "USDC",
    data: {
      rate,
      base: "NGN",
      target: "USDC",
    },
  });
});

export default router;
