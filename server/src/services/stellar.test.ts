import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mock the Stellar SDK before importing the service under test.
// ---------------------------------------------------------------------------
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk') as any;

  // A minimal Account-like object matching what Horizon.Server#loadAccount returns.
  const makeAccount = (publicKey: string) => ({
    accountId: () => publicKey,
    sequenceNumber: () => '1234567890',
    incrementSequenceNumber: jest.fn(),
    sequenceNumber: () => '1234567890',
  });

  const loadAccount = jest.fn(async (publicKey: string) => makeAccount(publicKey));

  const submitTransaction = jest.fn(async () => ({
    status: 'PENDING',
    hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    ledger: 0,
    createdAt: '2024-01-01T00:00:00Z',
    sourceAccount: 'GSOURCE',
    envelope_xdr: 'AAAA',
    result_xdr: 'AAAA',
    result_meta_xdr: 'AAAA',
  }));

  const prepareTransaction = jest.fn(async (tx: any) => tx);

  const sendTransaction = jest.fn(async () => ({
    status: 'PENDING',
    hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    latestLedger: 100,
    latestLedgerCloseTime: '2024-01-01T00:00:00Z',
  }));

  const getTransaction = jest.fn(async () => ({
    status: 'SUCCESS',
    hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    ledger: 101,
    createdAt: '2024-01-01T00:00:00Z',
    envelopeXdr: 'AAAA',
    resultXdr: 'AAAA',
    resultMetaXdr: 'AAAA',
  }));

  const simulateTransaction = jest.fn(async () => ({
    _parsed: true,
    id: '1',
    latestLedger: 100,
    events: [],
    result: { retval: { switch: () => 0, value: () => Buffer.from('') } },
  }));

  const HorizonServer = jest.fn().mockImplementation(() => ({
    loadAccount,
    submitTransaction,
  }));

  const SorobanRpcServer = jest.fn().mockImplementation(() => ({
    prepareTransaction,
    sendTransaction,
    getTransaction,
    simulateTransaction,
  }));

  const Contract = jest.fn().mockImplementation((contractId: string) => ({
    contractId,
    call: jest.fn((method: string, ...args: any[]) => ({
      method,
      args,
      address: () => ({ switch: () => 0, value: () => Buffer.from(contractId) }),
    })),
  }));

  const TransactionBuilder = jest.fn().mockImplementation((source: any, opts: any) => {
    const builder: any = {
      _source: source,
      _opts: opts,
      _operations: [] as any[],
      addOperation: jest.fn((op: any) => {
        builder._operations.push(op);
        return builder;
      }),
      setTimeout: jest.fn(() => builder),
      setNetworkPassphrase: jest.fn(() => builder),
      setFee: jest.fn(() => builder),
      build: jest.fn(() => ({
        toXDR: () => 'AAAA',
        sign: jest.fn(),
        hash: () => Buffer.from('deadbeef', 'hex'),
        source: source.accountId ? source.accountId() : 'GSOURCE',
        operations: builder._operations,
      })),
    };
    return builder;
  });

  const nativeToScVal = jest.fn((value: any, opts?: any) => ({
    switch: () => 0,
    value: () => value,
    _value: value,
    _opts: opts,
  }));

  const scValToNative = jest.fn((scVal: any) => {
    if (scVal && typeof scVal.value === 'function') {
      return scVal.value();
    }
    return scVal;
  });

  const Keypair = {
    fromSecret: jest.fn((secret: string) => ({
      publicKey: () => 'GSOURCEPUBLICKEY',
      secret: () => secret,
      sign: jest.fn(),
    })),
    random: jest.fn(() => ({
      publicKey: () => 'GRANDOMPUBLICKEY',
      secret: () => 'SRANDOMSECRET',
      sign: jest.fn(),
    })),
  };

  const Networks = {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
    FUTURENET: 'Test SDF Future Network ; October 2022',
  };

  const Asset = {
    native: jest.fn(() => ({ isNative: () => true })),
  };

  const Operation = {
    payment: jest.fn((opts: any) => ({ type: 'payment', ...opts })),
    invokeHostFunction: jest.fn((opts: any) => ({ type: 'invokeHostFunction', ...opts })),
  };

  const BASE_FEE = '100';

  return {
    ...actual,
    Horizon: { Server: HorizonServer },
    SorobanRpc: { Server: SorobanRpcServer },
    Contract,
    TransactionBuilder,
    nativeToScVal,
    scValToNative,
    Keypair,
    Networks,
    Asset,
    Operation,
    BASE_FEE,
    __mocks: {
      loadAccount,
      submitTransaction,
      prepareTransaction,
      sendTransaction,
      getTransaction,
      simulateTransaction,
      HorizonServer,
      SorobanRpcServer,
      Contract,
      TransactionBuilder,
      nativeToScVal,
      scValToNative,
    },
  };
});

// ---------------------------------------------------------------------------
// Import the service under test (after the mock is registered).
// ---------------------------------------------------------------------------
import * as StellarSDK from '@stellar/stellar-sdk';
import * as stellarService from './stellar';

const sdkMocks = (StellarSDK as any).__mocks;

const TX_HASH = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

describe('stellar service', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      STELLAR_NETWORK: 'testnet',
      STELLAR_SECRET_KEY: 'STESTSECRETKEY',
      ESCROW_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
  });

  describe('releasePayment', () => {
    it('successfully releases payment and returns the transaction hash', async () => {
      const result = await stellarService.releasePayment({
        tradeId: 'trade-1',
        recipient: 'GRECIPIENTPUBLICKEY',
        amount: '100',
      });

      expect(result).toBe(TX_HASH);
      expect(sdkMocks.loadAccount).toHaveBeenCalled();
      expect(sdkMocks.prepareTransaction).toHaveBeenCalled();
      expect(sdkMocks.sendTransaction).toHaveBeenCalled();
    });

    it('retries on transient failure and succeeds', async () => {
      jest.useFakeTimers();

      // First attempt throws a transient error, second succeeds.
      sdkMocks.sendTransaction
        .mockImplementationOnce(async () => {
          throw new Error('transient network error');
        })
        .mockImplementationOnce(async () => ({
          status: 'PENDING',
          hash: TX_HASH,
          latestLedger: 100,
          latestLedgerCloseTime: '2024-01-01T00:00:00Z',
        }));

      const promise = stellarService.releasePayment({
        tradeId: 'trade-2',
        recipient: 'GRECIPIENTPUBLICKEY',
        amount: '100',
      });

      // Advance timers to allow retry backoff to elapse.
      await jest.runAllTimersAsync();

      const result = await promise;

      expect(result).toBe(TX_HASH);
      expect(sdkMocks.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it('escalates when max retries are exceeded', async () => {
      jest.useFakeTimers();

      sdkMocks.sendTransaction.mockImplementation(async () => {
        throw new Error('persistent network error');
      });

      const promise = stellarService.releasePayment({
        tradeId: 'trade-3',
        recipient: 'GRECIPIENTPUBLICKEY',
        amount: '100',
      });

      // Attach the rejection handler before advancing timers to avoid unhandled rejection.
      const assertion = expect(promise).rejects.toThrow(/persistent network error|max retries/i);

      await jest.runAllTimersAsync();

      await assertion;
      expect(sdkMocks.sendTransaction.mock.calls.length).toBeGreaterThan(1);
    });
  });

  describe('resolveDispute', () => {
    it('handles REFUND resolution', async () => {
      const result = await stellarService.resolveDispute({
        tradeId: 'trade-4',
        resolution: 'REFUND',
        buyer: 'GBUYERPUBLICKEY',
        seller: 'GSELLERPUBLICKEY',
        amount: '100',
      });

      expect(result).toBe(TX_HASH);
      expect(sdkMocks.sendTransaction).toHaveBeenCalled();
    });

    it('handles RELEASE resolution', async () => {
      const result = await stellarService.resolveDispute({
        tradeId: 'trade-5',
        resolution: 'RELEASE',
        buyer: 'GBUYERPUBLICKEY',
        seller: 'GSELLERPUBLICKEY',
        amount: '100',
      });

      expect(result).toBe(TX_HASH);
      expect(sdkMocks.sendTransaction).toHaveBeenCalled();
    });
  });

  describe('configuration', () => {
    it('throws when ESCROW_CONTRACT_ID is missing', async () => {
      delete process.env.ESCROW_CONTRACT_ID;

      await expect(
        stellarService.releasePayment({
          tradeId: 'trade-6',
          recipient: 'GRECIPIENTPUBLICKEY',
          amount: '100',
        }),
      ).rejects.toThrow(/ESCROW_CONTRACT_ID/);
    });
  });
});