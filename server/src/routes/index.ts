import express, { Express } from "express";
import authRouter from './auth';
import tradesRouter from './trades';
import walletRouter from './wallet';
import profileRouter from './profile';
import webhooksRouter from './webhooks';
import adminRouter from './admin';
import eventsRouter from './events';
import docsRouter from './docs';

export function registerRoutes(app: Express): void {
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/trades', tradesRouter);
  app.use('/api/v1/wallet', walletRouter);
  app.use('/api/v1/profile', profileRouter);
  app.use('/api/v1/webhooks', webhooksRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/api/v1/events', eventsRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api', docsRouter);
  app.use('/api/v1', docsRouter);
}

const app = express();
app.use(express.json());
registerRoutes(app);

export default app;
