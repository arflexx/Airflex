import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock the database pool before importing the processor
const mockClient = {
  query: jest.fn(),
  release: jest.fn(),
};

const mockPool = {
  query: jest.fn(),
  connect: jest.fn(),
};

jest.mock('../../db', () => ({
  pool: mockPool,
}));

// Mock WalletService
const mockDebitWallet = jest.fn();
jest.mock('../../services/wallet.service', () => ({
  WalletService: jest.fn().mockImplementation(() => ({
    debit: mockDebitWallet,
  })),
}));

// Mock NotificationService
const mockNotify = jest.fn();
jest.mock('../../services/notification.service', () => ({
  NotificationService: jest.fn().mockImplementation(() => ({
    notify: mockNotify,
  })),
}));

// Mock logger
jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { processWithdrawal } from './process-withdrawal';
import { logger } from '../../utils/logger';

describe('processWithdrawal', () => {
  const withdrawalId = 'wd_123';
  const userId = 'user_1';
  const amount = 5000;
  const currency = 'NGN';

  const baseWithdrawal = {
    id: withdrawalId,
    user_id: userId,
    amount,
    currency,
    status: 'pending',
    fiat_balance: 10000,
    recipient_code: 'RCP_abc123',
    transfer_code: null,
    idempotency_key: 'idem_123',
    retry_count: 0,
    max_retries: 3,
  };

  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockReset();
    mockClient.release.mockReset();
    mockPool.query.mockReset();
    mockPool.connect.mockReset();
    mockDebitWallet.mockReset();
    mockNotify.mockReset();

    mockPool.connect.mockResolvedValue(mockClient as any);
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 } as any);
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 } as any);
    mockDebitWallet.mockResolvedValue(undefined);
    mockNotify.mockResolvedValue(undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('successful withdrawal', () => {
    it('moves status to processing, debits ledger, and persists transfer_code', async () => {
      // First query: load withdrawal
      mockPool.query.mockResolvedValueOnce({
        rows: [baseWithdrawal],
        rowCount: 1,
      } as any);

      // Paystack transfer succeeds
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: true,
          message: 'Transfer queued',
          data: {
            transfer_code: 'TRF_xyz789',
            status: 'pending',
          },
        }),
      } as any) as any;

      // Update status to processing
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
      // Persist transfer_code
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
      // Commit
      mockClient.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await processWithdrawal({ data: { withdrawalId } } as any);

      // Ledger debit called with correct amount
      expect(mockDebitWallet).toHaveBeenCalledTimes(1);
      expect(mockDebitWallet).toHaveBeenCalledWith(
        expect.objectContaining({ userId, amount, currency })
      );

      // Paystack transfer endpoint was called
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      expect(String(fetchCall[0])).toContain('transfer');

      // Status updated to processing
      const updateCalls = mockClient.query.mock.calls.filter((c: any[]) =>
        String(c[0]).toLowerCase().includes('update')
      );
      expect(updateCalls.length).toBeGreaterThan(0);
      const processingUpdate = updateCalls.find((c: any[]) =>
        JSON.stringify(c[1] ?? []).includes('processing') ||
        String(c[0]).includes('processing')
      );
      expect(processingUpdate).toBeDefined();

      // transfer_code persisted
      const persistedTransferCode = updateCalls.some((c: any[]) =>
        JSON.stringify(c[1] ?? []).includes('TRF_xyz789')
      );
      expect(persistedTransferCode).toBe(true);

      // Notification sent
      expect(mockNotify).toHaveBeenCalled();
    });
  });

  describe('Paystack API failure', () => {
    it('throws when fetch rejects so BullMQ retries the job', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [baseWithdrawal],
        rowCount: 1,
      } as any);

      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('Network error')) as any;

      // Rollback
      mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 } as any);

      await expect(
        processWithdrawal({ data: { withdrawalId } } as any)
      ).rejects.toThrow();

      expect(logger.error).toHaveBeenCalled();
    });

    it('throws when Paystack returns status:false so BullMQ retries the job', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [baseWithdrawal],
        rowCount: 1,
      } as any);

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: false,
          message: 'Insufficient balance',
          data: null,
        }),
      } as any) as any;

      mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 } as any);

      await expect(
        processWithdrawal({ data: { withdrawalId } } as any)
      ).rejects.toThrow();

      expect(logger.error).toHaveBeenCalled();
    });

    it('throws when Paystack returns a non-2xx HTTP status', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [baseWithdrawal],
        rowCount: 1,
      } as any);

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ status: false, message: 'Server error' }),
      } as any) as any;

      mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 } as any);

      await expect(
        processWithdrawal({ data: { withdrawalId } } as any)
      ).rejects.toThrow();
    });
  });

  describe('idempotency key collision', () => {
    it('returns without calling Paystack when withdrawal is already past pending', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...baseWithdrawal, status: 'processing' }],
        rowCount: 1,
      } as any);

      global.fetch = jest.fn() as any;

      await processWithdrawal({ data: { withdrawalId } } as any);

      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockDebitWallet).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalled();
    });

    it('returns without calling Paystack when withdrawal is already completed', async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ ...baseWithdrawal, status: 'completed' }],
        rowCount: 1,
      } as any);

      global.fetch = jest.fn() as any;

      await processWithdrawal({ data: { withdrawalId } } as any);

      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockDebitWallet).not.toHaveBeenCalled();
    });
  });

  describe('exhausted retries', () => {
    it('marks withdrawal as failed and restores fiat_balance when retries are exhausted', async () => {
      const exhaustedWithdrawal = {
        ...baseWithdrawal,
        retry_count: 3,
        max_retries: 3,
      };

      mockPool.query.mockResolvedValueOnce({
        rows: [exhaustedWithdrawal],
        rowCount: 1,
      } as any);

      // Update to failed + restore balance
      mockClient.query.mockResolvedValue({ rows: [], rowCount: 1 } as any);

      await processWithdrawal({ data: { withdrawalId } } as any);

      // Paystack should not be called when retries exhausted
      expect(global.fetch).not.toHaveBeenCalled();

      const updateCalls = mockClient.query.mock.calls.filter((c: any[]) =>
        String(c[0]).toLowerCase().includes('update')
      );
      expect(updateCalls.length).toBeGreaterThan(0);

      // Status set to failed
      const failedUpdate = updateCalls.some((c: any[]) =>
        JSON.stringify(c[1] ?? []).includes('failed') ||
        String(c[0]).includes('failed')
      );
      expect(failedUpdate).toBe(true);

      // fiat_balance restored (amount added back)
      const balanceRestore = updateCalls.some((c: any[]) => {
        const sql = String(c[0]).toLowerCase();
        return (
          sql.includes('fiat_balance') &&
          (sql.includes('+') || JSON.stringify(c[1] ?? []).includes(String(amount)))
        );
      });
      expect(balanceRestore).toBe(true);

      // Notification sent about failure
      expect(mockNotify).toHaveBeenCalled();
    });

    it('marks withdrawal as failed when Paystack fails on the final retry', async () => {
      const finalRetryWithdrawal = {
        ...baseWithdrawal,
        retry_count: 2,
        max_retries: 3,
      };

      mockPool.query.mockResolvedValueOnce({
        rows: [finalRetryWithdrawal],
        rowCount: 1,
      } as any);

      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('Paystack down')) as any;

      mockClient.query.mockResolvedValue({ rows: [], rowCount: 1 } as any);

      await expect(
        processWithdrawal({ data: { withdrawalId } } as any)
      ).rejects.toThrow();

      const updateCalls = mockClient.query.mock.calls.filter((c: any[]) =>
        String(c[0]).toLowerCase().includes('update')
      );
      const failedUpdate = updateCalls.some((c: any[]) =>
        JSON.stringify(c[1] ?? []).includes('failed') ||
        String(c[0]).includes('failed')
      );
      expect(failedUpdate).toBe(true);
    });
  });

  describe('missing withdrawal record', () => {
    it('throws when the withdrawal record does not exist', async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      global.fetch = jest.fn() as any;

      await expect(
        processWithdrawal({ data: { withdrawalId } } as any)
      ).rejects.toThrow();

      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockDebitWallet).not.toHaveBeenCalled();
    });
  });
});