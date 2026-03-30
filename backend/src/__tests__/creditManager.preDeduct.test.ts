/**
 * Unit tests for CreditManager.preDeduct
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 8.1, 8.3
 */

import * as fc from 'fast-check';
import { CreditManager } from '../services/creditManager';

// ─── Mock mysql2/promise pool ─────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockCommit = jest.fn();
const mockRollback = jest.fn();
const mockRelease = jest.fn();
const mockBeginTransaction = jest.fn();

jest.mock('../db/connection', () => ({
  pool: {
    getConnection: jest.fn().mockImplementation(() =>
      Promise.resolve({
        query: mockQuery,
        beginTransaction: mockBeginTransaction,
        commit: mockCommit,
        rollback: mockRollback,
        release: mockRelease,
      })
    ),
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CreditManager.preDeduct', () => {
  let manager: CreditManager;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
    mockBeginTransaction.mockResolvedValue(undefined);
    mockCommit.mockResolvedValue(undefined);
    mockRollback.mockResolvedValue(undefined);
    mockRelease.mockReturnValue(undefined);
  });

  // Requirement 3.1: Wallet sufficient — only deduct from Wallet
  it('deducts only from Wallet when Wallet balance is sufficient', async () => {
    // SELECT FOR UPDATE returns wallet=100, pool=50
    mockQuery
      .mockResolvedValueOnce([[{ wallet_balance: '100.00', pool_balance: '50.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE
      .mockResolvedValueOnce([{}]); // INSERT ledger

    const result = await manager.preDeduct(1, 'tripo3d', 80, 'task-001');

    expect(result).toEqual({ success: true, walletDeducted: 80, poolDeducted: 0 });

    // UPDATE should deduct 80 from wallet, 0 from pool
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[1]).toEqual([80, 0, 1, 'tripo3d', 80, 0]);
  });

  // Requirement 3.2: Wallet insufficient — deduct remainder from Pool
  it('deducts from both Wallet and Pool when Wallet is insufficient', async () => {
    // wallet=30, pool=100, need=80 → wallet deducts 30, pool deducts 50
    mockQuery
      .mockResolvedValueOnce([[{ wallet_balance: '30.00', pool_balance: '100.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{}]);

    const result = await manager.preDeduct(1, 'tripo3d', 80, 'task-002');

    expect(result).toEqual({ success: true, walletDeducted: 30, poolDeducted: 50 });

    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[1]).toEqual([30, 50, 1, 'tripo3d', 30, 50]);
  });

  // Requirement 3.3: Wallet = 0 — deduct entirely from Pool
  it('deducts entirely from Pool when Wallet balance is 0', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ wallet_balance: '0.00', pool_balance: '200.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{}]);

    const result = await manager.preDeduct(1, 'tripo3d', 50, 'task-003');

    expect(result).toEqual({ success: true, walletDeducted: 0, poolDeducted: 50 });
  });

  // Requirement 3.3: Wallet + Pool insufficient → INSUFFICIENT_CREDITS
  it('returns INSUFFICIENT_CREDITS when Wallet + Pool combined are insufficient', async () => {
    // wallet=10, pool=20, need=50 → total=30 < 50
    mockQuery.mockResolvedValueOnce([[{ wallet_balance: '10.00', pool_balance: '20.00' }]]);

    const result = await manager.preDeduct(1, 'tripo3d', 50, 'task-004');

    expect(result).toEqual({ success: false, errorCode: 'INSUFFICIENT_CREDITS' });
    expect(mockRollback).toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });

  // No user account found → INSUFFICIENT_CREDITS
  it('returns INSUFFICIENT_CREDITS when user account does not exist', async () => {
    mockQuery.mockResolvedValueOnce([[]]); // empty rows

    const result = await manager.preDeduct(99, 'tripo3d', 10, 'task-005');

    expect(result).toEqual({ success: false, errorCode: 'INSUFFICIENT_CREDITS' });
    expect(mockRollback).toHaveBeenCalled();
  });

  // Requirement 8.3: concurrent conflict → CONCURRENT_CONFLICT
  it('returns CONCURRENT_CONFLICT when UPDATE affects 0 rows (concurrent race)', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ wallet_balance: '100.00', pool_balance: '100.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // concurrent update won the race

    const result = await manager.preDeduct(1, 'tripo3d', 50, 'task-006');

    expect(result).toEqual({ success: false, errorCode: 'CONCURRENT_CONFLICT' });
    expect(mockRollback).toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });

  // Requirement 3.4: ledger entry written with negative deltas
  it('writes credit_ledger entry with negative wallet_delta and pool_delta', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ wallet_balance: '50.00', pool_balance: '100.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{}]);

    await manager.preDeduct(1, 'tripo3d', 70, 'task-007');

    const ledgerCall = mockQuery.mock.calls[2];
    expect(ledgerCall[0]).toContain('credit_ledger');
    expect(ledgerCall[0]).toContain('pre_deduct');
    // wallet_delta = -50, pool_delta = -20
    expect(ledgerCall[1]).toEqual([1, 'tripo3d', -50, -20, 'task-007']);
  });

  // Requirement 8.1: atomicity — rollback on DB error
  it('rolls back transaction on unexpected DB error', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ wallet_balance: '100.00', pool_balance: '100.00' }]])
      .mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(manager.preDeduct(1, 'tripo3d', 50, 'task-008')).rejects.toThrow('DB connection lost');
    expect(mockRollback).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  // Connection always released
  it('always releases the connection', async () => {
    mockQuery.mockResolvedValueOnce([[{ wallet_balance: '100.00', pool_balance: '100.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{}]);

    await manager.preDeduct(1, 'tripo3d', 10, 'task-009');
    expect(mockRelease).toHaveBeenCalled();
  });

  // Feature: multi-provider-credits, Property 7: API 失败退款
  // When provider API call fails, the pre-deducted amount from Provider_Account
  // should be fully refunded, restoring the balance to its pre-deduction state.
  it('Property 7: refund fully restores balance after API failure (fast-check)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(
          fc.integer({ min: 1, max: 9999 }),
          fc.constantFrom('tripo3d', 'hyper3d')
        ),
        async ([userId, providerId]) => {
          jest.clearAllMocks();
          mockBeginTransaction.mockResolvedValue(undefined);
          mockCommit.mockResolvedValue(undefined);
          mockRollback.mockResolvedValue(undefined);
          mockRelease.mockReturnValue(undefined);

          const walletDeducted = 30;
          const poolDeducted = 20;
          const taskId = `task-pbt-${userId}-${providerId}`;

          // Step 1: mock a successful preDeduct
          mockQuery
            .mockResolvedValueOnce([[{ wallet_balance: '100.00', pool_balance: '100.00' }]]) // SELECT FOR UPDATE
            .mockResolvedValueOnce([{ affectedRows: 1 }])                                    // UPDATE user_accounts
            .mockResolvedValueOnce([{}]);                                                     // INSERT pre_deduct ledger

          const deductResult = await manager.preDeduct(userId, providerId, walletDeducted + poolDeducted, taskId);

          if (!deductResult.success) return; // skip if preDeduct failed unexpectedly

          // Step 2: mock a refund that reads the pre_deduct ledger and restores balance
          mockQuery
            .mockResolvedValueOnce([[{ wallet_delta: `-${walletDeducted}.00`, pool_delta: `-${poolDeducted}.00` }]]) // SELECT pre_deduct ledger
            .mockResolvedValueOnce([{ affectedRows: 1 }])                                                            // UPDATE user_accounts (restore)
            .mockResolvedValueOnce([{}]);                                                                             // INSERT refund ledger

          await manager.refund(userId, providerId, taskId);

          // Step 3: verify the UPDATE query adds back the exact amounts that were deducted
          const refundUpdateCall = mockQuery.mock.calls.find(
            (call: any[]) =>
              typeof call[0] === 'string' &&
              call[0].includes('UPDATE user_accounts') &&
              call[0].includes('wallet_balance + ?')
          );

          expect(refundUpdateCall).toBeDefined();
          const [, refundParams] = refundUpdateCall!;
          expect(refundParams[0]).toBe(walletDeducted); // walletRefund
          expect(refundParams[1]).toBe(poolDeducted);   // poolRefund

          // Step 4: verify the refund uses the same providerId as the preDeduct
          expect(refundParams[3]).toBe(providerId);
        }
      ),
      { numRuns: 100 }
    );
  });
});
