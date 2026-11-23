import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock the Stellar service before importing the processor
jest.mock('../../services/stellar', () => ({
  resolveDispute: jest.fn(),
}));

// Mock the logger to keep test output clean
jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { resolveDispute } from '../../services/stellar';
import { logger } from '../../utils/logger';
import { processRefundCancelledTrade } from './refund-cancelled-trade';

const mockedResolveDispute = resolveDispute as jest.MockedFunction<typeof resolveDispute>;

// Minimal in-memory DB mock. The processor is expected to update the trade
// status to 'Failed' when a job exhausts its retries.
interface TradeRecord {
  id: string;
  contractTradeId: string;
  status: string;
}

const createDbMock = (trades: TradeRecord[]) => {
  const updateTradeStatus = jest.fn(async (tradeId: string, status: string) => {
    const trade = trades.find((t) => t.id === tradeId);
    if (trade) {
      trade.status = status;
    }
    return trade;
  });

  const findTradeById = jest.fn(async (tradeId: string) => {
    return trades.find((t) => t.id === tradeId) ?? null;
  });

  return { updateTradeStatus, findTradeById, trades };
};

describe('processRefundCancelledTrade', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('successful refund', () => {
    it('calls resolveDispute with resolution REFUND and the correct contractTradeId', async () => {
      const db = createDbMock([
        { id: 'trade-1', contractTradeId: 'contract-abc', status: 'Cancelled' },
      ]);
      mockedResolveDispute.mockResolvedValue({ success: true } as any);

      const job = {
        id: 'job-1',
        data: { tradeId: 'trade-1', contractTradeId: 'contract-abc' },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any;

      await expect(processRefundCancelledTrade(job, db as any)).resolves.not.toThrow();

      expect(mockedResolveDispute).toHaveBeenCalledTimes(1);
      expect(mockedResolveDispute).toHaveBeenCalledWith(
        expect.objectContaining({
          contractTradeId: 'contract-abc',
          resolution: 'REFUND',
        }),
      );
      // On success the trade status should not be marked Failed
      expect(db.updateTradeStatus).not.toHaveBeenCalledWith('trade-1', 'Failed');
    });

    it('resolves without throwing when the refund succeeds', async () => {
      const db = createDbMock([
        { id: 'trade-2', contractTradeId: 'contract-xyz', status: 'Cancelled' },
      ]);
      mockedResolveDispute.mockResolvedValue({ success: true } as any);

      const job = {
        id: 'job-2',
        data: { tradeId: 'trade-2', contractTradeId: 'contract-xyz' },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any;

      await expect(processRefundCancelledTrade(job, db as any)).resolves.toBeUndefined();
      expect(logger.info).toHaveBeenCalled();
    });
  });

  describe('escrow contract refund failure', () => {
    it('throws when resolveDispute rejects so BullMQ retries the job', async () => {
      const db = createDbMock([
        { id: 'trade-3', contractTradeId: 'contract-fail', status: 'Cancelled' },
      ]);
      const error = new Error('Stellar escrow refund failed');
      mockedResolveDispute.mockRejectedValue(error);

      const job = {
        id: 'job-3',
        data: { tradeId: 'trade-3', contractTradeId: 'contract-fail' },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any;

      await expect(processRefundCancelledTrade(job, db as any)).rejects.toThrow(
        'Stellar escrow refund failed',
      );

      expect(mockedResolveDispute).toHaveBeenCalledTimes(1);
      // While retries remain, the trade should not yet be marked Failed
      expect(db.updateTradeStatus).not.toHaveBeenCalledWith('trade-3', 'Failed');
    });

    it('updates the trade status to Failed when retries are exhausted', async () => {
      const db = createDbMock([
        { id: 'trade-4', contractTradeId: 'contract-exhausted', status: 'Cancelled' },
      ]);
      mockedResolveDispute.mockRejectedValue(new Error('escrow refund failed'));

      const job = {
        id: 'job-4',
        data: { tradeId: 'trade-4', contractTradeId: 'contract-exhausted' },
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as any;

      await expect(processRefundCancelledTrade(job, db as any)).rejects.toThrow();

      expect(db.updateTradeStatus).toHaveBeenCalledWith('trade-4', 'Failed');
      expect(db.trades.find((t) => t.id === 'trade-4')?.status).toBe('Failed');
    });
  });

  describe('missing trade record', () => {
    it('throws when job data is missing tradeId', async () => {
      const db = createDbMock([]);

      const job = {
        id: 'job-5',
        data: { contractTradeId: 'contract-missing' },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any;

      await expect(processRefundCancelledTrade(job, db as any)).rejects.toThrow();
      expect(mockedResolveDispute).not.toHaveBeenCalled();
    });

    it('throws when job data is missing contractTradeId', async () => {
      const db = createDbMock([]);

      const job = {
        id: 'job-6',
        data: { tradeId: 'trade-6' },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any;

      await expect(processRefundCancelledTrade(job, db as any)).rejects.toThrow();
      expect(mockedResolveDispute).not.toHaveBeenCalled();
    });

    it('throws when resolveDispute reports the trade was not found', async () => {
      const db = createDbMock([
        { id: 'trade-7', contractTradeId: 'contract-notfound', status: 'Cancelled' },
      ]);
      const notFoundError = new Error('Trade not found on escrow contract');
      (notFoundError as any).code = 'TRADE_NOT_FOUND';
      mockedResolveDispute.mockRejectedValue(notFoundError);

      const job = {
        id: 'job-7',
        data: { tradeId: 'trade-7', contractTradeId: 'contract-notfound' },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as any;

      await expect(processRefundCancelledTrade(job, db as any)).rejects.toThrow(
        'Trade not found on escrow contract',
      );
    });

    it('updates the trade status to Failed when a not-found error exhausts retries', async () => {
      const db = createDbMock([
        { id: 'trade-8', contractTradeId: 'contract-notfound-2', status: 'Cancelled' },
      ]);
      const notFoundError = new Error('Trade not found on escrow contract');
      (notFoundError as any).code = 'TRADE_NOT_FOUND';
      mockedResolveDispute.mockRejectedValue(notFoundError);

      const job = {
        id: 'job-8',
        data: { tradeId: 'trade-8', contractTradeId: 'contract-notfound-2' },
        attemptsMade: 3,
        opts: { attempts: 3 },
      } as any;

      await expect(processRefundCancelledTrade(job, db as any)).rejects.toThrow();

      expect(db.updateTradeStatus).toHaveBeenCalledWith('trade-8', 'Failed');
      expect(db.trades.find((t) => t.id === 'trade-8')?.status).toBe('Failed');
    });
  });
});