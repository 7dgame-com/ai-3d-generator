/**
 * Unit tests for CreditManager.getStatus
 * Validates: Requirements 7.1, 7.2
 */

import { CreditManager, CreditStatus } from '../services/creditManager';

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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let mockPoolQuery: jest.Mock;

  beforeEach(() => {
    manager = new CreditManager();
    jest.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mockPoolQuery = require('../db/connection').pool.query;
  });

  // Requirement 7.1: returns all required fields
  it('returns correct status fields when user account exists', async () => {
    const now = new Date('2024-01-15T08:00:00Z');
    const next = new Date('2024-01-16T08:00:00Z');

    mockPoolQuery.mockResolvedValue([
      [
        {
          wallet_balance: '150.50',
          pool_balance: '300.00',
          pool_baseline: '500.00',
          cycles_remaining: 5,
          cycle_started_at: now,
          next_cycle_at: next,
        },
      ],
    ]);

    const status = await manager.getStatus(1);

    expect(status.wallet_balance).toBe(150.5);
    expect(status.pool_balance).toBe(300);
    expect(status.pool_baseline).toBe(500);
    expect(status.cycles_remaining).toBe(5);
    expect(status.cycle_started_at).toBe(now);
    expect(status.next_cycle_at).toBe(next);
  });

  // Requirement 7.1: DECIMAL fields are converted to numbers
  it('converts DECIMAL string values to numbers', async () => {
    mockPoolQuery.mockResolvedValue([
      [
        {
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

    expect(typeof status.wallet_balance).toBe('number');
    expect(typeof status.pool_balance).toBe('number');
    expect(typeof status.pool_baseline).toBe('number');
    expect(typeof status.cycles_remaining).toBe('number');
    expect(status.wallet_balance).toBe(0.01);
    expect(status.pool_balance).toBe(9999.99);
  });

  // Requirement 7.1: returns default zeros when user has no account row
  it('returns all-zero default status when user account does not exist', async () => {
    mockPoolQuery.mockResolvedValue([[]]);

    const status = await manager.getStatus(999);

    const expected: CreditStatus = {
      wallet_balance: 0,
      pool_balance: 0,
      pool_baseline: 0,
      cycles_remaining: 0,
      cycle_started_at: null,
      next_cycle_at: null,
    };
    expect(status).toEqual(expected);
  });

  // Requirement 7.1: null dates are preserved
  it('returns null for cycle dates when they are null in DB', async () => {
    mockPoolQuery.mockResolvedValue([
      [
        {
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

    expect(status.cycle_started_at).toBeNull();
    expect(status.next_cycle_at).toBeNull();
  });

  // Requirement 7.2: read-only query (no FOR UPDATE)
  it('does not use FOR UPDATE lock in the query', async () => {
    mockPoolQuery.mockResolvedValue([[
      {
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
