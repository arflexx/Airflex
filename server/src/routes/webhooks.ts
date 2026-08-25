import { Router, Request, Response } from 'express';

const router: Router = Router();

// Stub webhook endpoints - to be implemented
router.post('/stellar', (req: Request, res: Response) => {
  res.status(501).json({ error: 'Not Implemented' });
});

router.post('/payment', (req: Request, res: Response) => {
  res.status(501).json({ error: 'Not Implemented' });
});

export default router;
