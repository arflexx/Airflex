import { Express, Request, Response } from 'express';
import { query, getPoolStats, type PoolStats } from '../db/pool';
import { cache } from '../services/cache';
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
import usersRouter from './users';
import ratesRouter from './rates';

export function registerRoutes(app: Express): void {
  // CORS preflight (issue #539). The global CORS middleware (config/cors.ts)
  // has already attached Access-Control-* headers for allowlisted origins and
  // passes OPTIONS through (preflightContinue). Terminate every preflight
  // here, before any router runs, so `authenticate` never sees a
  // credential-less OPTIONS request and answers it with 401. Unlisted origins
  // still get a 204, but without the CORS headers the browser blocks the
  // follow-up request.
  app.options('*', (_req: Request, res: Response) => {
    res.status(204).end();
  });

  // API v1 routes
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/trades', tradesRouter);
  app.use('/api/v1/wallet', walletRouter);
  app.use('/api/v1/profile', profileRouter);
  app.use('/api/v1/webhooks', webhooksRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/v1/events', eventsRouter);
  app.use('/api/v1/referrals', referralsRouter);
  app.use('/api/v1/rates', ratesRouter);

  // KYC submission (issue #114)
  app.use('/api/kyc', kycRouter);

  // Admin analytics (issue #110) — mounted under the versioned admin router
  // and exposed at the unversioned /api/admin/analytics path referenced in the
  // issue for dashboard tooling.
  app.use('/api/v1/admin', analyticsRouter);
  app.use('/api/admin', analyticsRouter);

  // Legacy alias paths
  app.use('/api/trades', tradesRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/v1/users', usersRouter);
  app.use('/api/rates', ratesRouter);
  app.use('/api/events', eventsRouter);

  // OpenAPI 3.1 spec + Swagger UI
  // GET /api/docs.json  — always available
  // GET /api/docs       — Swagger UI (disabled in production unless ENABLE_API_DOCS=true)
  app.use('/api', docsRouter);

  // Health check endpoint (issue #626) — no authentication required
  app.get('/health', async (_req: Request, res: Response) => {
    let dbStatus: 'ok' | 'error' = 'ok';
    let redisStatus: 'ok' | 'error' = 'ok';

    try {
      await query('SELECT 1');
    } catch {
      dbStatus = 'error';
    }

    try {
      const redisOk = await cache.ping();
      if (!redisOk) redisStatus = 'error';
    } catch {
      redisStatus = 'error';
    }

    // Connection pool utilisation (issue #680): max/total/active/idle/waiting.
    // Informational only — a busy pool does not fail the probe.
    let poolStats: PoolStats | null = null;
    try {
      poolStats = getPoolStats();
    } catch {
      poolStats = null;
    }

    const healthy = dbStatus === 'ok' && redisStatus === 'ok';
    const statusCode = healthy ? 200 : 503;

    res.status(statusCode).json({
      status: healthy ? 'ok' : 'error',
      db: dbStatus,
      redis: redisStatus,
      pool: poolStats,
      uptime: process.uptime(),
      version: process.env['npm_package_version'] ?? '1.0.0',
      timestamp: new Date().toISOString(),
    });
  });
}
