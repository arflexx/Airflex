import { Router, Request, Response } from 'express';

const router: Router = Router();

// Stub admin endpoints - to be implemented
router.get('/users', (req: Request, res: Response) => {
  res.status(501).json({ error: 'Not Implemented' });
});

router.get('/trades', (req: Request, res: Response) => {
  res.status(501).json({ error: 'Not Implemented' });
});

router.patch('/users/:id', (req: Request, res: Response) => {
  res.status(501).json({ error: 'Not Implemented' });
});

export default router;
