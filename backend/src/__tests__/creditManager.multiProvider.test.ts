/**
 * Multi-provider tests for CreditManager
 * Validates: Requirements 1.4, 2.2, 2.3, 4.3, 4.4, 4.5, 5.1, 6.1, 6.2, 7.1, 7.2
 *
 * Properties covered:
 *   Property 2: Account isolation
 *   Property 4: Recharge ledger includes provider_id
 *   Property 5: Recharge parameter validation rejects invalid inputs
 *   Property 9: getStatus returns all configured providers when no filter
 *   Property 10: getStatus filters by provider_id when specified
 */

import * as fc from 'fast-check';
import { CreditManager, RechargeParams } from '../services/creditManager';

// ─── Mock mysql2/promise pool ─────────────────────────────────────────────────

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn(),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const getPoolMocks = () => require('../db/connection').pool as {
  query: jest.Mock;
  getConnection: jest.Mock;
};

const mockQuery = jest.fn();
const mockCommit = jest.fn();
const mockRollback = jest.fn();
const mockRelease = jest.fn();
const mockBeginTransaction = jest.fn();

function setupMockConnection() {
  const pool = getPoolMocks();
  pool.getConnection.mockResolvedValue({
    query: mockQuery,
    beginTransaction: mockBeginTransaction,
    commit: mockCommit,
    rollback: mockRollback,
    release: mockRelease,
  });
  mockQuery.mockResolvedValue([{ id: 1 }]);
  mockBeginTransaction.mockResolvedValue(undefined);
  mockCommit.mockResolvedValue(undefined);
  mockRollback.mockResolvedValue(undefined);
  mockRelease.mockReturnValue(undefined);
}

function validParams(overrides: Partial<RechargeParams> = {}): RechargeParams {
  return {
    wallet_amount: 1000,
    pool_amount: 500,
    total_duration: 10080,
    cycle_duration: 1440,
    ...overrides,
  };
}

// ─── Property 2: Account Isolation ───────────────────────────────────────────

describe('Property 2: Account isolation', () => {
  let manager: CreditManager;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
    setupMockConnection();
  });

  it('recharge on tripo3d uses tripo3d provider_id in all queries', async () => {
    await manager.recharge(1, 'tripo3d', validParams());

    for (const call of mockQuery.mock.calls) {
      const values: unknown[] = call[1] ?? [];
      if (values.includes('tripo3d')) {
        expect(values).not.toContain('hyper3d');
      }
    }
  });

  it('recharge on hyper3d uses hyper3d provider_id in all queries', async () => {
    await manager.recharge(1, 'hyper3d', validParams());

    for (const call of mockQuery.mock.calls) {
      const values: unknown[] = call[1] ?? [];
      if (values.includes('hyper3d')) {
        expect(values).not.toContain('tripo3d');
      }
    }
  });

  it('recharge on tripo3d does not touch hyper3d rows', async () => {
    await manager.recharge(1, 'tripo3d', validParams());

    const allValues = mockQuery.mock.calls.flatMap((c) => c[1] ?? []);
    expect(allValues).toContain('tripo3d');
    expect(allValues).not.toContain('hyper3d');
  });

  it('recharge on hyper3d does not touch tripo3d rows', async () => {
    await manager.recharge(1, 'hyper3d', validParams());

    const allValues = mockQuery.mock.calls.flatMap((c) => c[1] ?? []);
    expect(allValues).toContain('hyper3d');
    expect(allValues).not.toContain('tripo3d');
  });

  it('two separate recharges for different providers use their respective provider_ids', async () => {
    await manager.recharge(1, 'tripo3d', validParams());
    const tripo3dValues = mockQuery.mock.calls.flatMap((c) => c[1] ?? []);

    jest.clearAllMocks();
    setupMockConnection();

    await manager.recharge(1, 'hyper3d', validParams());
    const hyper3dValues = mockQuery.mock.calls.flatMap((c) => c[1] ?? []);

    expect(tripo3dValues).not.toContain('hyper3d');
    expect(hyper3dValues).not.toContain('tripo3d');
  });

  // Feature: multi-provider-credits, Property 2: Account isolation
  it('PBT: recharge on provider A never touches provider B (account isolation)', async () => {
    const providers = ['tripo3d', 'hyper3d'];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...providers),
        fc.constantFrom(...providers),
        fc.integer({ min: 1, max: 9999 }),
        async (providerA, providerB, userId) => {
          fc.pre(providerA !== providerB);

          jest.clearAllMocks();
          setupMockConnection();

          await manager.recharge(userId, providerA, validParams());

          const allValues = mockQuery.mock.calls.flatMap((c) => c[1] ?? []);
          expect(allValues).toContain(providerA);
          expect(allValues).not.toContain(providerB);
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ─── Property 4: Recharge ledger includes provider_id ────────────────────────

describe('Property 4: Recharge ledger includes provider_id', () => {
  let manager: CreditManager;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
    setupMockConnection();
  });

  it('credit_ledger INSERT includes provider_id for tripo3d', async () => {
    await manager.recharge(1, 'tripo3d', validParams());

    const ledgerCall = mockQuery.mock.calls[2];
    expect(ledgerCall[0]).toContain('credit_ledger');
    expect(ledgerCall[0]).toContain('provider_id');
    expect(ledgerCall[1]).toContain('tripo3d');
  });

  it('credit_ledger INSERT includes provider_id for hyper3d', async () => {
    await manager.recharge(1, 'hyper3d', validParams());

    const ledgerCall = mockQuery.mock.calls[2];
    expect(ledgerCall[0]).toContain('credit_ledger');
    expect(ledgerCall[0]).toContain('provider_id');
    expect(ledgerCall[1]).toContain('hyper3d');
  });

  it('credit_ledger INSERT event_type is recharge', async () => {
    await manager.recharge(1, 'tripo3d', validParams());

    const ledgerCall = mockQuery.mock.calls[2];
    expect(ledgerCall[0]).toContain('recharge');
  });

  it('credit_ledger INSERT provider_id matches the recharge provider', async () => {
    await manager.recharge(42, 'hyper3d', validParams({ wallet_amount: 500 }));

    const ledgerCall = mockQuery.mock.calls[2];
    const values: unknown[] = ledgerCall[1];
    // values: [userId, providerId, wallet_amount, pool_amount, note]
    expect(values[1]).toBe('hyper3d');
  });

  // Feature: multi-provider-credits, Property 4: Recharge ledger includes provider_id
  it('PBT: credit_ledger INSERT always contains the provider_id used in recharge', async () => {
    const providers = ['tripo3d', 'hyper3d'];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...providers),
        fc.integer({ min: 1, max: 9999 }),
        async (providerId, userId) => {
          jest.clearAllMocks();
          setupMockConnection();

          await manager.recharge(userId, providerId, validParams());

          const ledgerCall = mockQuery.mock.calls[2];
          expect(ledgerCall[0]).toContain('credit_ledger');
          expect(ledgerCall[0]).toContain('provider_id');
          expect(ledgerCall[1]).toContain(providerId);
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ─── Property 5: Recharge parameter validation ───────────────────────────────

describe('Property 5: Recharge parameter validation rejects invalid inputs', () => {
  let manager: CreditManager;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
    setupMockConnection();
  });

  it('throws INVALID_AMOUNT when wallet_amount is 0', async () => {
    await expect(
      manager.recharge(1, 'tripo3d', validParams({ wallet_amount: 0 }))
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  it('throws INVALID_AMOUNT when wallet_amount is negative', async () => {
    await expect(
      manager.recharge(1, 'tripo3d', validParams({ wallet_amount: -1 }))
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  it('throws INVALID_AMOUNT when pool_amount is negative', async () => {
    await expect(
      manager.recharge(1, 'tripo3d', validParams({ pool_amount: -1 }))
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  it('throws INVALID_PARAMS when cycle_duration < 60', async () => {
    await expect(
      manager.recharge(1, 'tripo3d', validParams({ cycle_duration: 59, total_duration: 59 }))
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('throws INVALID_PARAMS when cycle_duration > 43200', async () => {
    await expect(
      manager.recharge(1, 'tripo3d', validParams({ cycle_duration: 43201, total_duration: 43201 }))
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('throws INVALID_PARAMS when total_duration < cycle_duration', async () => {
    await expect(
      manager.recharge(1, 'tripo3d', validParams({ cycle_duration: 1440, total_duration: 720 }))
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('accepts pool_amount = 0 (valid)', async () => {
    await expect(
      manager.recharge(1, 'tripo3d', validParams({ pool_amount: 0 }))
    ).resolves.toBeUndefined();
  });

  it('accepts cycle_duration = 60 (minimum boundary)', async () => {
    await expect(
      manager.recharge(1, 'tripo3d', validParams({ cycle_duration: 60, total_duration: 60 }))
    ).resolves.toBeUndefined();
  });

  it('accepts cycle_duration = 43200 (maximum boundary)', async () => {
    await expect(
      manager.recharge(1, 'tripo3d', validParams({ cycle_duration: 43200, total_duration: 43200 }))
    ).resolves.toBeUndefined();
  });

  // Feature: multi-provider-credits, Property 5: Recharge parameter validation rejects invalid inputs
  it('PBT: wallet_amount <= 0 always throws INVALID_AMOUNT', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ max: 0 }),
          fc.float({ max: 0, noNaN: true })
        ),
        async (walletAmount) => {
          jest.clearAllMocks();
          setupMockConnection();

          await expect(
            manager.recharge(1, 'tripo3d', validParams({ wallet_amount: walletAmount }))
          ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
        }
      ),
      { numRuns: 100 }
    );
  });

  it('PBT: pool_amount < 0 always throws INVALID_AMOUNT', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ max: -1 }),
          fc.float({ max: Math.fround(-0.001), noNaN: true })
        ),
        async (poolAmount) => {
          jest.clearAllMocks();
          setupMockConnection();

          await expect(
            manager.recharge(1, 'tripo3d', validParams({ pool_amount: poolAmount }))
          ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
        }
      ),
      { numRuns: 100 }
    );
  });

  it('PBT: cycle_duration out of [60, 43200] always throws INVALID_PARAMS', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ min: 1, max: 59 }),
          fc.integer({ min: 43201, max: 100000 })
        ),
        async (cycleDuration) => {
          jest.clearAllMocks();
          setupMockConnection();

          await expect(
            manager.recharge(1, 'tripo3d', validParams({
              cycle_duration: cycleDuration,
              total_duration: Math.max(cycleDuration, 43201),
            }))
          ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        }
      ),
      { numRuns: 100 }
    );
  });

  it('PBT: total_duration < cycle_duration always throws INVALID_PARAMS', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 61, max: 43200 }),
        async (cycleDuration) => {
          const totalDuration = cycleDuration - 1;

          jest.clearAllMocks();
          setupMockConnection();

          await expect(
            manager.recharge(1, 'tripo3d', validParams({
              cycle_duration: cycleDuration,
              total_duration: totalDuration,
            }))
          ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 9: getStatus returns all configured providers ──────────────────

describe('Property 9: getStatus returns all configured providers when no filter', () => {
  let manager: CreditManager;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
  });

  it('returns all providers when multiple accounts exist', async () => {
    getPoolMocks().query.mockResolvedValue([
      [
        {
          provider_id: 'tripo3d',
          wallet_balance: '100.00',
          pool_balance: '200.00',
          pool_baseline: '200.00',
          cycles_remaining: 3,
          cycle_started_at: null,
          next_cycle_at: null,
        },
        {
          provider_id: 'hyper3d',
          wallet_balance: '50.00',
          pool_balance: '100.00',
          pool_baseline: '100.00',
          cycles_remaining: 2,
          cycle_started_at: null,
          next_cycle_at: null,
        },
      ],
    ]);

    const result = await manager.getStatus(1);

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.provider_id)).toContain('tripo3d');
    expect(result.map((r) => r.provider_id)).toContain('hyper3d');
  });

  it('each result entry contains provider_id field', async () => {
    getPoolMocks().query.mockResolvedValue([
      [
        {
          provider_id: 'tripo3d',
          wallet_balance: '100.00',
          pool_balance: '200.00',
          pool_baseline: '200.00',
          cycles_remaining: 3,
          cycle_started_at: null,
          next_cycle_at: null,
        },
        {
          provider_id: 'hyper3d',
          wallet_balance: '50.00',
          pool_balance: '100.00',
          pool_baseline: '100.00',
          cycles_remaining: 2,
          cycle_started_at: null,
          next_cycle_at: null,
        },
      ],
    ]);

    const result = await manager.getStatus(1);

    for (const entry of result) {
      expect(entry).toHaveProperty('provider_id');
      expect(typeof entry.provider_id).toBe('string');
    }
  });

  it('returns empty array when user has no accounts', async () => {
    getPoolMocks().query.mockResolvedValue([[]]);

    const result = await manager.getStatus(999);

    expect(result).toEqual([]);
  });

  it('returns single provider when only one account exists', async () => {
    getPoolMocks().query.mockResolvedValue([
      [
        {
          provider_id: 'tripo3d',
          wallet_balance: '100.00',
          pool_balance: '200.00',
          pool_baseline: '200.00',
          cycles_remaining: 3,
          cycle_started_at: null,
          next_cycle_at: null,
        },
      ],
    ]);

    const result = await manager.getStatus(1);

    expect(result).toHaveLength(1);
    expect(result[0].provider_id).toBe('tripo3d');
  });

  it('numeric fields are converted from strings', async () => {
    getPoolMocks().query.mockResolvedValue([
      [
        {
          provider_id: 'tripo3d',
          wallet_balance: '123.45',
          pool_balance: '678.90',
          pool_baseline: '1000.00',
          cycles_remaining: 7,
          cycle_started_at: null,
          next_cycle_at: null,
        },
      ],
    ]);

    const result = await manager.getStatus(1);

    expect(result[0].wallet_balance).toBe(123.45);
    expect(result[0].pool_balance).toBe(678.9);
    expect(result[0].pool_baseline).toBe(1000);
    expect(result[0].cycles_remaining).toBe(7);
  });

  // Feature: multi-provider-credits, Property 9: getStatus returns all configured providers when no filter
  it('PBT: getStatus without filter returns one entry per provider in DB', async () => {
    const allProviders = ['tripo3d', 'hyper3d'];

    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...allProviders), { minLength: 1, maxLength: 2 }),
        fc.integer({ min: 1, max: 9999 }),
        async (providers, userId) => {
          const uniqueProviders = [...new Set(providers)];

          jest.clearAllMocks();
          getPoolMocks().query.mockResolvedValue([
            uniqueProviders.map((pid) => ({
              provider_id: pid,
              wallet_balance: '100.00',
              pool_balance: '200.00',
              pool_baseline: '200.00',
              cycles_remaining: 3,
              cycle_started_at: null,
              next_cycle_at: null,
            })),
          ]);

          const result = await manager.getStatus(userId);

          expect(result).toHaveLength(uniqueProviders.length);
          for (const pid of uniqueProviders) {
            expect(result.map((r) => r.provider_id)).toContain(pid);
          }
          for (const entry of result) {
            expect(entry).toHaveProperty('provider_id');
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

// ─── Property 10: getStatus filters by provider_id ───────────────────────────

describe('Property 10: getStatus filters by provider_id when specified', () => {
  let manager: CreditManager;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
  });

  it('returns only tripo3d status when provider_id=tripo3d', async () => {
    getPoolMocks().query.mockResolvedValue([
      [
        {
          provider_id: 'tripo3d',
          wallet_balance: '100.00',
          pool_balance: '200.00',
          pool_baseline: '200.00',
          cycles_remaining: 3,
          cycle_started_at: null,
          next_cycle_at: null,
        },
      ],
    ]);

    const result = await manager.getStatus(1, 'tripo3d');

    expect(result).toHaveLength(1);
    expect(result[0].provider_id).toBe('tripo3d');
  });

  it('returns only hyper3d status when provider_id=hyper3d', async () => {
    getPoolMocks().query.mockResolvedValue([
      [
        {
          provider_id: 'hyper3d',
          wallet_balance: '50.00',
          pool_balance: '100.00',
          pool_baseline: '100.00',
          cycles_remaining: 2,
          cycle_started_at: null,
          next_cycle_at: null,
        },
      ],
    ]);

    const result = await manager.getStatus(1, 'hyper3d');

    expect(result).toHaveLength(1);
    expect(result[0].provider_id).toBe('hyper3d');
  });

  it('SQL query includes provider_id in WHERE clause when filtering', async () => {
    getPoolMocks().query.mockResolvedValue([
      [
        {
          provider_id: 'tripo3d',
          wallet_balance: '100.00',
          pool_balance: '200.00',
          pool_baseline: '200.00',
          cycles_remaining: 3,
          cycle_started_at: null,
          next_cycle_at: null,
        },
      ],
    ]);

    await manager.getStatus(1, 'tripo3d');

    const pool = getPoolMocks();
    const sql: string = pool.query.mock.calls[0][0];
    const params: unknown[] = pool.query.mock.calls[0][1];
    expect(sql).toContain('provider_id');
    expect(params).toContain('tripo3d');
  });

  it('returns zero-balance object when provider has no account row', async () => {
    getPoolMocks().query.mockResolvedValue([[]]);

    const result = await manager.getStatus(1, 'hyper3d');

    expect(result).toHaveLength(1);
    expect(result[0].provider_id).toBe('hyper3d');
    expect(result[0].wallet_balance).toBe(0);
    expect(result[0].pool_balance).toBe(0);
    expect(result[0].pool_baseline).toBe(0);
    expect(result[0].cycles_remaining).toBe(0);
    expect(result[0].cycle_started_at).toBeNull();
    expect(result[0].next_cycle_at).toBeNull();
  });

  it('filtered result does not contain other providers', async () => {
    getPoolMocks().query.mockResolvedValue([
      [
        {
          provider_id: 'tripo3d',
          wallet_balance: '100.00',
          pool_balance: '200.00',
          pool_baseline: '200.00',
          cycles_remaining: 3,
          cycle_started_at: null,
          next_cycle_at: null,
        },
      ],
    ]);

    const result = await manager.getStatus(1, 'tripo3d');

    expect(result.map((r) => r.provider_id)).not.toContain('hyper3d');
  });

  // Feature: multi-provider-credits, Property 10: getStatus filters by provider_id when specified
  it('PBT: getStatus with provider_id filter returns only that provider', async () => {
    const allProviders = ['tripo3d', 'hyper3d'];

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...allProviders),
        fc.integer({ min: 1, max: 9999 }),
        async (targetProvider, userId) => {
          jest.clearAllMocks();
          getPoolMocks().query.mockResolvedValue([
            [
              {
                provider_id: targetProvider,
                wallet_balance: '100.00',
                pool_balance: '200.00',
                pool_baseline: '200.00',
                cycles_remaining: 3,
                cycle_started_at: null,
                next_cycle_at: null,
              },
            ],
          ]);

          const result = await manager.getStatus(userId, targetProvider);

          expect(result).toHaveLength(1);
          expect(result[0].provider_id).toBe(targetProvider);

          const otherProviders = allProviders.filter((p) => p !== targetProvider);
          for (const other of otherProviders) {
            expect(result.map((r) => r.provider_id)).not.toContain(other);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
