/**
 * Unit tests for CreditManager.recharge
 * Validates: Requirements 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 6.5
 */

import { CreditManager, RechargeParams } from '../services/creditManager';

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validParams(overrides: Partial<RechargeParams> = {}): RechargeParams {
  return {
    wallet_amount: 1000,
    pool_amount: 500,
    total_duration: 10080, // 7 days in minutes
    cycle_duration: 1440,  // 1 day in minutes
    ...overrides,
  };
}

const PROVIDER_ID = 'tripo3d';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CreditManager.recharge', () => {
  let manager: CreditManager;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([{ id: 1 }]);
    mockBeginTransaction.mockResolvedValue(undefined);
    mockCommit.mockResolvedValue(undefined);
    mockRollback.mockResolvedValue(undefined);
    mockRelease.mockReturnValue(undefined);
  });

  // Requirement 1.5: wallet_amount <= 0 → INVALID_AMOUNT
  it('throws INVALID_AMOUNT when wallet_amount is 0', async () => {
    await expect(manager.recharge(1, PROVIDER_ID, validParams({ wallet_amount: 0 }))).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
  });

  it('throws INVALID_AMOUNT when wallet_amount is negative', async () => {
    await expect(manager.recharge(1, PROVIDER_ID, validParams({ wallet_amount: -100 }))).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
  });

  // Requirement 1.6: pool_amount < 0 → INVALID_AMOUNT
  it('throws INVALID_AMOUNT when pool_amount is negative', async () => {
    await expect(manager.recharge(1, PROVIDER_ID, validParams({ pool_amount: -1 }))).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
  });

  // Requirement 1.7: wallet_amount and pool_amount both 0 → INVALID_AMOUNT
  it('throws INVALID_AMOUNT when both wallet_amount and pool_amount are 0', async () => {
    await expect(
      manager.recharge(1, PROVIDER_ID, validParams({ wallet_amount: 0, pool_amount: 0 }))
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  // Requirement 6.4: cycle_duration out of range → INVALID_PARAMS
  it('throws INVALID_PARAMS when cycle_duration < 60', async () => {
    await expect(manager.recharge(1, PROVIDER_ID, validParams({ cycle_duration: 59, total_duration: 59 }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('throws INVALID_PARAMS when cycle_duration > 43200', async () => {
    await expect(
      manager.recharge(1, PROVIDER_ID, validParams({ cycle_duration: 43201, total_duration: 43201 }))
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('throws INVALID_PARAMS when total_duration < cycle_duration', async () => {
    await expect(
      manager.recharge(1, PROVIDER_ID, validParams({ cycle_duration: 1440, total_duration: 720 }))
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  // Requirement 1.2: wallet_injection_per_cycle = wallet_amount × cycle_duration / total_duration
  // Requirement 1.3: cycles_remaining = floor(total_duration / cycle_duration)
  it('writes correct wallet_injection_per_cycle and cycles_remaining to DB', async () => {
    const params = validParams({
      wallet_amount: 1000,
      pool_amount: 500,
      cycle_duration: 1440,
      total_duration: 10080, // 7 cycles
    });

    await manager.recharge(1, PROVIDER_ID, params);

    // wallet_injection_per_cycle = 1000 * 1440 / 10080 ≈ 142.857...
    const expectedInjection = 1000 * 1440 / 10080;
    const expectedCycles = Math.floor(10080 / 1440); // 7

    // Find the UPSERT call (second query call, after the SELECT FOR UPDATE)
    const upsertCall = mockQuery.mock.calls[1];
    expect(upsertCall[1]).toContain(expectedInjection);
    expect(upsertCall[1]).toContain(expectedCycles);
  });

  // Requirement 1.1: pool_amount written as pool_balance and pool_baseline
  it('writes pool_amount as both pool_balance and pool_baseline', async () => {
    const params = validParams({ pool_amount: 500 });
    await manager.recharge(1, PROVIDER_ID, params);

    const upsertCall = mockQuery.mock.calls[1];
    // pool_amount appears twice in the INSERT values (pool_balance and pool_baseline)
    const values = upsertCall[1] as unknown[];
    const poolAmountOccurrences = values.filter((v) => v === 500).length;
    expect(poolAmountOccurrences).toBeGreaterThanOrEqual(2);
  });

  // Requirement 1.4: credit_ledger entry written with correct wallet_delta and note
  it('writes a recharge entry to credit_ledger with wallet_amount as wallet_delta', async () => {
    const params = validParams({
      wallet_amount: 1000,
      pool_amount: 500,
      cycle_duration: 1440,
      total_duration: 10080,
    });
    await manager.recharge(1, PROVIDER_ID, params);

    const ledgerCall = mockQuery.mock.calls[2];
    expect(ledgerCall[0]).toContain('credit_ledger');
    expect(ledgerCall[0]).toContain('recharge');

    // wallet_delta should be wallet_amount (1000), not wallet_injection_per_cycle
    // ledger values: [userId, providerId, wallet_amount, pool_amount, note]
    const ledgerValues = ledgerCall[1] as unknown[];
    expect(ledgerValues[2]).toBe(1000); // wallet_delta = wallet_amount (index 2 after userId, providerId)

    // note should include wallet_injection_per_cycle
    const note = ledgerValues[4] as string;
    expect(note).toContain('wallet_amount=1000');
    expect(note).toContain('wallet_injection_per_cycle=');
    expect(note).toContain('cycles_remaining=');
  });

  // Requirement 1.8: atomicity — rollback on error
  it('rolls back transaction on DB error', async () => {
    mockQuery
      .mockResolvedValueOnce([]) // SELECT FOR UPDATE
      .mockRejectedValueOnce(new Error('DB error')); // UPSERT fails

    await expect(manager.recharge(1, PROVIDER_ID, validParams())).rejects.toThrow('DB error');
    expect(mockRollback).toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalled();
  });

  // Happy path: pool_amount = 0 is valid
  it('accepts pool_amount = 0', async () => {
    await expect(manager.recharge(1, PROVIDER_ID, validParams({ pool_amount: 0 }))).resolves.toBeUndefined();
  });

  // Happy path: cycle_duration at boundary values
  it('accepts cycle_duration = 60 (minimum)', async () => {
    await expect(
      manager.recharge(1, PROVIDER_ID, validParams({ cycle_duration: 60, total_duration: 60 }))
    ).resolves.toBeUndefined();
  });

  it('accepts cycle_duration = 43200 (maximum)', async () => {
    await expect(
      manager.recharge(1, PROVIDER_ID, validParams({ cycle_duration: 43200, total_duration: 43200 }))
    ).resolves.toBeUndefined();
  });

  // provider_id is included in SQL queries
  it('includes provider_id in user_accounts query', async () => {
    await manager.recharge(1, PROVIDER_ID, validParams());

    const selectCall = mockQuery.mock.calls[0];
    expect(selectCall[0]).toContain('provider_id');
    expect(selectCall[1]).toContain(PROVIDER_ID);
  });

  // provider_id is included in credit_ledger INSERT
  it('includes provider_id in credit_ledger INSERT', async () => {
    await manager.recharge(1, PROVIDER_ID, validParams());

    const ledgerCall = mockQuery.mock.calls[2];
    expect(ledgerCall[0]).toContain('provider_id');
    expect(ledgerCall[1]).toContain(PROVIDER_ID);
  });
});
