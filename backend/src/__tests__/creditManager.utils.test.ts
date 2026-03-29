import { computeThrottleDelay, sleep } from '../services/creditManager';

describe('computeThrottleDelay', () => {
  const maxDelay = 30000;

  // Requirement 4.2: Pool >= Baseline → no delay
  it('returns 0 when poolCurrent >= poolBaseline', () => {
    expect(computeThrottleDelay(500, 500, maxDelay)).toBe(0);
    expect(computeThrottleDelay(600, 500, maxDelay)).toBe(0);
  });

  // Requirement 4.3: Pool = 0 → reject (-1)
  it('returns -1 when poolCurrent is 0 (POOL_EXHAUSTED)', () => {
    expect(computeThrottleDelay(0, 500, maxDelay)).toBe(-1);
  });

  it('returns -1 when poolCurrent is negative', () => {
    expect(computeThrottleDelay(-10, 500, maxDelay)).toBe(-1);
  });

  // Requirement 4.1: 0 < Pool < Baseline → proportional delay
  it('returns proportional delay when 0 < poolCurrent < poolBaseline', () => {
    // ratio = (500 - 250) / 500 = 0.5 → 30000 * 0.5 = 15000
    expect(computeThrottleDelay(250, 500, maxDelay)).toBe(15000);
  });

  it('returns near-max delay when pool is nearly exhausted', () => {
    // ratio = (500 - 1) / 500 = 0.998 → round(30000 * 0.998) = 29940
    expect(computeThrottleDelay(1, 500, maxDelay)).toBe(29940);
  });

  it('returns 0 when poolBaseline is 0 (no baseline set)', () => {
    expect(computeThrottleDelay(100, 0, maxDelay)).toBe(0);
  });

  it('rounds the result to nearest integer', () => {
    // ratio = (3 - 1) / 3 ≈ 0.6667 → round(100 * 0.6667) = 67
    const result = computeThrottleDelay(1, 3, 100);
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBe(67);
  });
});

describe('sleep', () => {
  it('resolves after approximately the given milliseconds', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('resolves immediately for 0ms', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});
