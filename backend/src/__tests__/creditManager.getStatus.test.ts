/**
 * Unit tests for CreditManager.getStatus
 * Validates: Requirements 7.1, 7.2
 */

import { CreditManager, ProviderCreditStatus } from '../services/creditManager';

// ─── Mock mysql2/promise pool ─────────────────────────────────────────────────

jest.mock('../db/connection', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn(),
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CreditManager.getStatus', () => {
  let manager: CreditManager;
  let mockPoolQuery: jest.Mock;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
    mockPoolQuery = require('../db/connection').pool.query;
  });

  // ── No providerId: returns all providers ──────────────────────────────────

  // Requirement 7.1: returns all providers when no filter given
  it('returns all providers when no providerId is specified', async () => {
    const now = new Date('2024-01-15T08:00:00Z');
    const next = new Date('2024-01-16T08:00:00Z');

    mockPoolQuery.mockResolvedValue([
      [
        {
          provider_id: 'tripo3d',
          wallet_balance: '150.50',
          pool_balance: '300.00',
          pool_baseline: '500.00',
          cycles_remaining: 5,
          cycle_started_at: now,
          next_cycle_at: next,
        },
        {
          provider_id: 'hyper3d',
          wallet_balance: '80.00',
          pool_balance: '200.00',
          pool_baseline: '400.00',
          cycles_remaining: 3,
          cycle_started_at: now,
          next_cycle_at: next,
        },
      ],
    ]);

    const status = await manager.getStatus(1);

    expect(Array.isArray(status)).toBe(true);
    expect(status).toHaveLength(2);
  });

  // Requirement 7.1: each entry has provider_id field
  it('each entry in the returned array has a provider_id field', async () => {
    mockPoolQuery.mockResolvedValue([
      [
        {
          provider_id: 'tripo3d',
          wallet_balance: '100.00',
          pool_balance: '200.00',
          pool_baseline: '200.00',
          cycles_remaining: 2,
          cycle_started_at: null,
          next_cycle_at: null,
        },
        {
          provider_id: 'hyper3d',
          wallet_balance: '50.00',
          pool_balance: '100.00',
          pool_baseline: '100.00',
          cycles_remaining: 1,
          cycle_started_at: null,
          next_cycle_at: null,
        },
      ],
    ]);

    const status = await manager.getStatus(1);

    expect(status[0].provider_id).toBe('tripo3d');
    expect(status[1].provider_id).toBe('hyper3d');
  });

  // Requirement 7.1: returns correct numeric fields for each provider
  it('converts DECIMAL string values to numbers for all providers', async () => {
    mockPoolQuery.mockResolvedValue([
      [
        {
          provider_id: 'tripo3d',
          wallet_balance: '0.01',
          pool_balance: '9999.99',
          pool_baseline: '1000.00',
          cycles_remaining: 1,
          cycle_started_at: null,
          next_cycle_at: null,
        },
      ],
    ]);

    const status = await manager.getStatus(42);

    expect(typeof status[0].wallet_balance).toBe('number');
    expect(typeof status[0].pool_balance).toBe('number');
    expect(typeof status[0].pool_baseline).toBe('number');
    expect(typeof status[0].cycles_remaining).toBe('number');
    expect(status[0].wallet_balance).toBe(0.01);
    expect(status[0].pool_balance).toBe(9999.99);
  });

  // Requirement 7.1: returns empty array when user has no accounts
  it('returns empty array when user has no accounts', async () => {
    mockPoolQuery.mockResolvedValue([[]]);

    const status = await manager.getStatus(999);

    expect(Array.isArray(status)).toBe(true);
    expect(status).toHaveLength(0);
  });

  // Requirement 7.1: null dates are preserved
  it('returns null for cycle dates when they are null in DB', async () => {
    mockPoolQuery.mockResolvedValue([
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

    const status = await manager.getStatus(1);

    expect(status[0].cycle_started_at).toBeNull();
    expect(status[0].next_cycle_at).toBeNull();
  });

  // ── With providerId: filter by provider ───────────────────────────────────

  // Requirement 7.2: filter by provider_id returns only that provider
  it('returns only the specified provider when providerId is given', async () => {
    const now = new Date('2024-01-15T08:00:00Z');
    const next = new Date('2024-01-16T08:00:00Z');

    mockPoolQuery.mockResolvedValue([
      [
        {
          provider_id: 'tripo3d',
          wallet_balance: '150.50',
          pool_balance: '300.00',
          pool_baseline: '500.00',
          cycles_remaining: 5,
          cycle_started_at: now,
          next_cycle_at: next,
        },
      ],
    ]);

    const status = await manager.getStatus(1, 'tripo3d');

    expect(Array.isArray(status)).toBe(true);
    expect(status).toHaveLength(1);
    expect(status[0].provider_id).toBe('tripo3d');
    expect(status[0].wallet_balance).toBe(150.5);
    expect(status[0].pool_balance).toBe(300);
  });

  // Requirement 7.3: zero-balance object returned when provider not found
  it('returns zero-balance object when provider account does not exist', async () => {
    mockPoolQuery.mockResolvedValue([[]]);

    const status = await manager.getStatus(999, 'hyper3d');

    expect(Array.isArray(status)).toBe(true);
    expect(status).toHaveLength(1);

    const entry: ProviderCreditStatus = status[0];
    expect(entry.provider_id).toBe('hyper3d');
    expect(entry.wallet_balance).toBe(0);
    expect(entry.pool_balance).toBe(0);
    expect(entry.pool_baseline).toBe(0);
    expect(entry.cycles_remaining).toBe(0);
    expect(entry.cycle_started_at).toBeNull();
    expect(entry.next_cycle_at).toBeNull();
  });

  // ── Read-only behaviour ───────────────────────────────────────────────────

  // Requirement 7.2: read-only query (no FOR UPDATE)
  it('does not use FOR UPDATE lock in the query', async () => {
    mockPoolQuery.mockResolvedValue([[
      {
        provider_id: 'tripo3d',
        wallet_balance: '0.00',
        pool_balance: '0.00',
        pool_baseline: '0.00',
        cycles_remaining: 0,
        cycle_started_at: null,
        next_cycle_at: null,
      },
    ]]);

    await manager.getStatus(1);

    const sql: string = mockPoolQuery.mock.calls[0][0];
    expect(sql.toUpperCase()).not.toContain('FOR UPDATE');
  });

  // Requirement 7.2: uses pool.query directly (no transaction/connection)
  it('uses pool.query directly without acquiring a connection', async () => {
    mockPoolQuery.mockResolvedValue([[
      {
        provider_id: 'tripo3d',
        wallet_balance: '0.00',
        pool_balance: '0.00',
        pool_baseline: '0.00',
        cycles_remaining: 0,
        cycle_started_at: null,
        next_cycle_at: null,
      },
    ]]);

    const { pool } = require('../db/connection');
    await manager.getStatus(1);

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.getConnection).not.toHaveBeenCalled();
  });
});
