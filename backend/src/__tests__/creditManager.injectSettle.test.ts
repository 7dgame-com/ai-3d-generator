/**
 * Unit tests for CreditManager.injectWallet and CreditManager.settleWallet
 * Validates: Requirements 2.1, 2.2, 2.3, 2.5, 5.1, 5.2, 5.3, 5.4, 8.2
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

// ─── Tests: injectWallet ──────────────────────────────────────────────────────

describe('CreditManager.injectWallet', () => {
  let manager: CreditManager;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
    mockBeginTransaction.mockResolvedValue(undefined);
    mockCommit.mockResolvedValue(undefined);
    mockRollback.mockResolvedValue(undefined);
    mockRelease.mockReturnValue(undefined);
  });

  // Requirement 2.1: cycles_remaining > 0 → inject and decrement
  it('injects wallet_injection_per_cycle and decrements cycles_remaining when cycles_remaining > 0', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])                                                                   // SELECT idempotency check → not found
      .mockResolvedValueOnce([[{ wallet_injection_per_cycle: '100.00', cycles_remaining: 3 }]])     // SELECT FOR UPDATE
      .mockResolvedValueOnce([{ affectedRows: 1 }])                                                 // UPDATE
      .mockResolvedValueOnce([{ insertId: 1 }]);                                                    // INSERT ledger

    await manager.injectWallet(1, 'cycle:1:2024-01-01');

    // UPDATE should add injection amount and decrement cycles_remaining
    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[0]).toContain('wallet_balance = wallet_balance +');
    expect(updateCall[0]).toContain('cycles_remaining = cycles_remaining - 1');
    expect(updateCall[1]).toContain(100);

    // Ledger INSERT should record inject event with correct delta
    const ledgerCall = mockQuery.mock.calls[3];
    expect(ledgerCall[0]).toContain("'inject'");
    expect(ledgerCall[1]).toContain(100);
    expect(ledgerCall[1]).toContain('cycle:1:2024-01-01');

    expect(mockCommit).toHaveBeenCalled();
  });

  // Requirement 2.2: cycles_remaining = 0 → skip injection
  it('skips injection when cycles_remaining is 0', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])                                                                   // SELECT idempotency check → not found
      .mockResolvedValueOnce([[{ wallet_injection_per_cycle: '100.00', cycles_remaining: 0 }]]);    // SELECT FOR UPDATE

    await manager.injectWallet(1, 'cycle:1:2024-01-01');

    // Only the idempotency check and SELECT FOR UPDATE should have been called
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockRollback).toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });

  // Requirement 2.2: no user_accounts row → skip injection
  it('skips injection when user has no account row', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])   // SELECT idempotency check → not found
      .mockResolvedValueOnce([[]]); // SELECT FOR UPDATE → empty

    await manager.injectWallet(99, 'cycle:99:2024-01-01');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockRollback).toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });

  // Requirement 8.2: idempotency — duplicate cycleKey is silently ignored (checked upfront)
  it('silently ignores duplicate idempotency_key by checking upfront', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 1 }]]); // SELECT idempotency check → found

    await expect(manager.injectWallet(1, 'cycle:1:2024-01-01')).resolves.toBeUndefined();
    expect(mockCommit).toHaveBeenCalled();
    expect(mockRollback).not.toHaveBeenCalled();
    // Should NOT have called UPDATE (no double injection)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // Non-duplicate DB errors should propagate and rollback
  it('rolls back and rethrows on unexpected DB error', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])                                                                   // SELECT idempotency check
      .mockResolvedValueOnce([[{ wallet_injection_per_cycle: '50.00', cycles_remaining: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(manager.injectWallet(1, 'cycle:1:2024-01-01')).rejects.toThrow('DB connection lost');
    expect(mockRollback).toHaveBeenCalled();
  });

  // Requirement 2.3: ledger entry includes idempotency_key
  it('writes idempotency_key to credit_ledger', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])                                                                   // SELECT idempotency check
      .mockResolvedValueOnce([[{ wallet_injection_per_cycle: '75.00', cycles_remaining: 5 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 1 }]);

    await manager.injectWallet(2, 'cycle:2:2024-02-01');

    const ledgerCall = mockQuery.mock.calls[3];
    expect(ledgerCall[1]).toContain('cycle:2:2024-02-01');
  });
});

// ─── Tests: settleWallet ──────────────────────────────────────────────────────

describe('CreditManager.settleWallet', () => {
  let manager: CreditManager;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
    mockBeginTransaction.mockResolvedValue(undefined);
    mockCommit.mockResolvedValue(undefined);
    mockRollback.mockResolvedValue(undefined);
    mockRelease.mockReturnValue(undefined);
  });

  // Requirement 5.1 & 5.2: wallet balance moved to pool, wallet zeroed
  it('transfers wallet_balance to pool_balance and zeros wallet', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])                                // SELECT idempotency check → not found
      .mockResolvedValueOnce([[{ wallet_balance: '200.00' }]])   // SELECT FOR UPDATE
      .mockResolvedValueOnce([{ affectedRows: 1 }])              // UPDATE
      .mockResolvedValueOnce([{ insertId: 1 }]);                 // INSERT ledger

    await manager.settleWallet(1, 'settle:1:2024-01-01');

    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[0]).toContain('pool_balance = pool_balance + wallet_balance');
    expect(updateCall[0]).toContain('wallet_balance = 0');

    expect(mockCommit).toHaveBeenCalled();
  });

  // Requirement 5.3: ledger entry written with correct deltas
  it('writes settle event to credit_ledger with correct wallet_delta and pool_delta', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])                                // SELECT idempotency check
      .mockResolvedValueOnce([[{ wallet_balance: '150.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 1 }]);

    await manager.settleWallet(1, 'settle:1:2024-01-01');

    const ledgerCall = mockQuery.mock.calls[3];
    expect(ledgerCall[0]).toContain("'settle'");
    // wallet_delta = -150, pool_delta = +150
    expect(ledgerCall[1]).toContain(-150);
    expect(ledgerCall[1]).toContain(150);
    expect(ledgerCall[1]).toContain('settle:1:2024-01-01');
  });

  // wallet_balance = 0 → still proceeds (settle 0 is a no-op but writes ledger)
  it('proceeds with settle even when wallet_balance is 0', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])                                // SELECT idempotency check
      .mockResolvedValueOnce([[{ wallet_balance: '0.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 1 }]);

    await expect(manager.settleWallet(1, 'settle:1:2024-01-01')).resolves.toBeUndefined();
    expect(mockCommit).toHaveBeenCalled();
  });

  // No user_accounts row → skip
  it('skips settle when user has no account row', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])   // SELECT idempotency check
      .mockResolvedValueOnce([[]]); // SELECT FOR UPDATE → empty

    await manager.settleWallet(99, 'settle:99:2024-01-01');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockRollback).toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });

  // Requirement 8.2: idempotency — duplicate cycleKey is silently ignored (checked upfront)
  it('silently ignores duplicate idempotency_key by checking upfront', async () => {
    mockQuery
      .mockResolvedValueOnce([[{ id: 1 }]]); // SELECT idempotency check → found

    await expect(manager.settleWallet(1, 'settle:1:2024-01-01')).resolves.toBeUndefined();
    expect(mockCommit).toHaveBeenCalled();
    expect(mockRollback).not.toHaveBeenCalled();
    // Should NOT have called UPDATE (no double settle)
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  // Requirement 5.4: atomicity — rollback on unexpected error
  it('rolls back and rethrows on unexpected DB error', async () => {
    mockQuery
      .mockResolvedValueOnce([[]])                                // SELECT idempotency check
      .mockResolvedValueOnce([[{ wallet_balance: '100.00' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockRejectedValueOnce(new Error('DB timeout'));

    await expect(manager.settleWallet(1, 'settle:1:2024-01-01')).rejects.toThrow('DB timeout');
    expect(mockRollback).toHaveBeenCalled();
  });
});
