import { Express } from 'express';
import authRouter from './auth';
import tradesRouter from './trades';
import walletRouter from './wallet';
import profileRouter from './profile';
import webhooksRouter from './webhooks';
import adminRouter from './admin';
import eventsRouter from './events';
import docsRouter from './docs';
import referralsRouter from './referrals';
import kycRouter from './kyc';
import analyticsRouter from './analytics';

export function registerRoutes(app: Express): void {
  // API v1 routes
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/trades', tradesRouter);
  app.use('/api/v1/wallet', walletRouter);
  app.use('/api/v1/profile', profileRouter);
  app.use('/api/v1/webhooks', webhooksRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/events', eventsRouter);
  app.use('/api/v1/referrals', referralsRouter);

  // KYC submission (issue #114)
  app.use('/api/kyc', kycRouter);

  // Admin analytics (issue #110) — mounted under the versioned admin router
  // and exposed at the unversioned /api/admin/analytics path referenced in the
  // issue for dashboard tooling.
  app.use('/api/v1/admin', analyticsRouter);
  app.use('/api/admin', analyticsRouter);

  // Legacy alias paths
  app.use('/api/trades', tradesRouter);
  app.use('/api/events', eventsRouter);

  // OpenAPI 3.1 spec + Swagger UI
  // GET /api/docs.json  — always available
  // GET /api/docs       — Swagger UI (disabled in production unless ENABLE_API_DOCS=true)
  app.use('/api', docsRouter);
}
