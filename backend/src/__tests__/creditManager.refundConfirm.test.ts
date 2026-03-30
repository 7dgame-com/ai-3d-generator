/**
 * Unit tests for CreditManager.refund and CreditManager.confirmDeduct
 * Validates: Requirements 3.4, 8.1
 */

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

describe('CreditManager.refund', () => {
  let manager: CreditManager;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
    mockBeginTransaction.mockResolvedValue(undefined);
    mockCommit.mockResolvedValue(undefined);
    mockRollback.mockResolvedValue(undefined);
    mockRelease.mockReturnValue(undefined);
  });

  // Requirement 3.4: refund restores wallet and pool from pre_deduct ledger record
  it('restores wallet and pool balances based on pre_deduct ledger record', async () => {
    // pre_deduct record: wallet_delta=-30, pool_delta=-50
    mockQuery
      .mockResolvedValueOnce([[{ wallet_delta: '-30.00', pool_delta: '-50.00' }]]) // SELECT ledger
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE user_accounts
      .mockResolvedValueOnce([{}]); // INSERT refund ledger

    await manager.refund(1, 'tripo3d', 'task-001');

    // UPDATE should add walletRefund=30 to wallet, poolRefund=50 to pool
    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[1]).toEqual([30, 50, 1, 'tripo3d']);

    // INSERT refund ledger with positive deltas
    const ledgerCall = mockQuery.mock.calls[2];
    expect(ledgerCall[0]).toContain('credit_ledger');
    expect(ledgerCall[0]).toContain('refund');
    expect(ledgerCall[1]).toEqual([1, 'tripo3d', 30, 50, 'task-001']);

    expect(mockCommit).toHaveBeenCalled();
  });

  // Requirement 3.4: refund when only wallet was deducted
  it('restores only wallet when pool_delta was 0', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ wallet_delta: '-80.00', pool_delta: '0.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{}]);

    await manager.refund(1, 'tripo3d', 'task-002');

    const updateCall = mockQuery.mock.calls[1];
    expect(updateCall[1]).toEqual([80, 0, 1, 'tripo3d']);

    const ledgerCall = mockQuery.mock.calls[2];
    expect(ledgerCall[1]).toEqual([1, 'tripo3d', 80, 0, 'task-002']);
  });

  // No pre_deduct record found — should rollback and return without error
  it('rolls back and returns silently when no pre_deduct record found', async () => {
    mockQuery.mockResolvedValueOnce([[]]); // empty ledger rows

    await manager.refund(1, 'tripo3d', 'task-nonexistent');

    expect(mockRollback).toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });

  // Requirement 8.1: atomicity — rollback on DB error
  it('rolls back transaction on unexpected DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    await expect(manager.refund(1, 'tripo3d', 'task-003')).rejects.toThrow('DB error');
    expect(mockRollback).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  // Connection always released
  it('always releases the connection', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ wallet_delta: '-20.00', pool_delta: '-30.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{}]);

    await manager.refund(1, 'tripo3d', 'task-004');
    expect(mockRelease).toHaveBeenCalled();
  });
});

describe('CreditManager.confirmDeduct', () => {
  let manager: CreditManager;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
    mockBeginTransaction.mockResolvedValue(undefined);
    mockCommit.mockResolvedValue(undefined);
    mockRollback.mockResolvedValue(undefined);
    mockRelease.mockReturnValue(undefined);
  });

  // Requirement 3.1: queries pre_deduct records to compute preDeducted total
  it('queries pre_deduct ledger records for the given taskId', async () => {
    // pre_deduct: wallet=-30, pool=-20 => preDeducted=50, actual=50 => diff=0
    mockQuery
      .mockResolvedValueOnce([[{ wallet_delta: '-30.00', pool_delta: '-20.00' }]]) // SELECT pre_deduct
      .mockResolvedValueOnce([{}]) // INSERT confirm_deduct ledger
      .mockResolvedValueOnce([{}]); // INSERT credit_usage

    await manager.confirmDeduct(1, 'task-001', 50);

    const selectCall = mockQuery.mock.calls[0];
    expect(selectCall[0]).toContain('pre_deduct');
    expect(selectCall[1]).toEqual([1, 'task-001']);

    // Verify ledger records wallet_delta and pool_delta proportionally
    const ledgerCall = mockQuery.mock.calls[1];
    expect(ledgerCall[1]).toEqual([1, -30, -20, 'task-001', 'actual=50']);

    expect(mockCommit).toHaveBeenCalled();
  });

  // Requirement 3.2: actual < preDeducted — refund diff to Pool (priority) then Wallet
  it('refunds diff to pool (priority) then wallet when actual < preDeducted', async () => {
    // pre_deduct: wallet=-20, pool=-30 => preDeducted=50, actual=40 => diff=-10 => refund=10
    mockQuery
      .mockResolvedValueOnce([[{ wallet_delta: '-20.00', pool_delta: '-30.00' }]]) // SELECT pre_deduct
      .mockResolvedValueOnce([[{ pool_balance: '100.00' }]])                        // SELECT FOR UPDATE
      .mockResolvedValueOnce([{ affectedRows: 1 }])                                // UPDATE user_accounts
      .mockResolvedValueOnce([{}])                                                  // INSERT confirm_deduct ledger
      .mockResolvedValueOnce([{}]);                                                 // INSERT credit_usage

    await manager.confirmDeduct(1, 'task-002', 40);

    // UPDATE should add poolRefund=10 to pool, walletRefund=0 to wallet
    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[0]).toContain('UPDATE user_accounts');
    expect(updateCall[1]).toEqual([10, 0, 1]); // poolRefund=10, walletRefund=0

    expect(mockCommit).toHaveBeenCalled();
  });

  // Requirement 3.2: refund spills to wallet when diff > preDeductedPool
  it('refunds to wallet when refund amount exceeds preDeductedPool', async () => {
    // pre_deduct: wallet=-40, pool=-5 => preDeducted=45, actual=30 => diff=-15 => refund=15
    // poolRefund = min(15, 5) = 5, walletRefund = 10
    mockQuery
      .mockResolvedValueOnce([[{ wallet_delta: '-40.00', pool_delta: '-5.00' }]])
      .mockResolvedValueOnce([[{ pool_balance: '100.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    await manager.confirmDeduct(1, 'task-003', 30);

    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[1]).toEqual([5, 10, 1]); // poolRefund=5, walletRefund=10
    expect(mockCommit).toHaveBeenCalled();
  });

  // Requirement 3.3: actual > preDeducted — extra deduct from Pool then Wallet
  it('extra deducts from pool (priority) then wallet when actual > preDeducted', async () => {
    // pre_deduct: wallet=-20, pool=-20 => preDeducted=40, actual=50 => diff=10
    // pool=100, wallet=50 => poolExtra=10, walletExtra=0
    mockQuery
      .mockResolvedValueOnce([[{ wallet_delta: '-20.00', pool_delta: '-20.00' }]])
      .mockResolvedValueOnce([[{ wallet_balance: '50.00', pool_balance: '100.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    await manager.confirmDeduct(1, 'task-004', 50);

    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[0]).toContain('UPDATE user_accounts');
    expect(updateCall[1]).toEqual([10, 0, 1]); // poolExtra=10, walletExtra=0
    expect(mockCommit).toHaveBeenCalled();
  });

  // Requirement 3.3: extra deduct spills to wallet when pool insufficient
  it('extra deducts from wallet when pool is insufficient', async () => {
    // pre_deduct: wallet=-20, pool=-20 => preDeducted=40, actual=50 => diff=10
    // pool=5, wallet=50 => poolExtra=5, walletExtra=5
    mockQuery
      .mockResolvedValueOnce([[{ wallet_delta: '-20.00', pool_delta: '-20.00' }]])
      .mockResolvedValueOnce([[{ wallet_balance: '50.00', pool_balance: '5.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    await manager.confirmDeduct(1, 'task-005', 50);

    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[1]).toEqual([5, 5, 1]); // poolExtra=5, walletExtra=5
    expect(mockCommit).toHaveBeenCalled();
  });

  // Requirement 3.3: logs warning when balance insufficient for extra deduct, does not throw
  it('logs warning and does not throw when balance insufficient for extra deduct', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // pre_deduct: wallet=-10, pool=-10 => preDeducted=20, actual=50 => diff=30
    // pool=5, wallet=5 => totalExtra=10 < 30
    mockQuery
      .mockResolvedValueOnce([[{ wallet_delta: '-10.00', pool_delta: '-10.00' }]])
      .mockResolvedValueOnce([[{ wallet_balance: '5.00', pool_balance: '5.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    await expect(manager.confirmDeduct(1, 'task-006', 50)).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('余额不足'));
    expect(mockCommit).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // Fix 6: credit_usage is inserted within the same transaction
  it('inserts credit_usage within the same transaction as ledger', async () => {
    // diff=0 case: wallet=-30, pool=-20 => preDeducted=50, actual=50
    mockQuery
      .mockResolvedValueOnce([[{ wallet_delta: '-30.00', pool_delta: '-20.00' }]])
      .mockResolvedValueOnce([{}]) // INSERT confirm_deduct ledger
      .mockResolvedValueOnce([{}]); // INSERT credit_usage

    await manager.confirmDeduct(1, 'task-007', 50);

    // Verify credit_usage insert happened before commit
    const creditUsageCall = mockQuery.mock.calls.find(
      (c: any[]) => c[0] && c[0].includes('credit_usage')
    );
    expect(creditUsageCall).toBeDefined();
    expect(creditUsageCall![1]).toEqual([1, 'task-007', 50]);
    expect(mockCommit).toHaveBeenCalled();
  });

  // Requirement 3.4: atomicity — rollback on DB error
  it('rolls back transaction on unexpected DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB write error'));

    await expect(manager.confirmDeduct(1, 'task-008', 20)).rejects.toThrow('DB write error');
    expect(mockRollback).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  // Connection always released
  it('always releases the connection', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ wallet_delta: '-10.00', pool_delta: '-10.00' }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);

    await manager.confirmDeduct(1, 'task-009', 20);
    expect(mockRelease).toHaveBeenCalled();
  });
});
