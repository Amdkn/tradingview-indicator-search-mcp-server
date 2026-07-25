import { describe, it, expect } from 'vitest';
import { Throttle, CircuitOpenError, BudgetExceededError } from '../src/throttle.js';

/** Virtual clock so pacing behaviour is asserted without real waiting. */
function harness(overrides = {}, deps = {}) {
  let now = 0;
  const slept = [];
  const config = {
    minDelayMs: 1000,
    maxDelayMs: 3000,
    breakEvery: 3,
    breakMinMs: 20000,
    breakMaxMs: 30000,
    dailyBudget: 100,
    breakerThreshold: 3,
    breakerCooldownMs: 900000,
    ...overrides,
  };
  const throttle = new Throttle(config, {
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    random: () => 0.5,
    ...deps,
  });
  return { throttle, slept, config, advance: (ms) => (now += ms), nowRef: () => now };
}

describe('Throttle pacing', () => {
  it('runs the first request immediately', async () => {
    const { throttle, slept } = harness();
    await throttle.run(async () => 'ok');
    expect(slept).toEqual([]);
  });

  it('waits a jittered gap between consecutive requests', async () => {
    const { throttle, slept } = harness();
    await throttle.run(async () => 1);
    await throttle.run(async () => 2);
    // random()=0.5 puts the gap midway between min and max
    expect(slept).toEqual([2000]);
  });

  it('does not wait if enough time already passed', async () => {
    const { throttle, slept, advance } = harness();
    await throttle.run(async () => 1);
    advance(10_000);
    await throttle.run(async () => 2);
    expect(slept).toEqual([]);
  });

  it('takes a long break every N requests', async () => {
    const { throttle, slept } = harness({ breakEvery: 3 });
    for (let i = 0; i < 4; i += 1) await throttle.run(async () => i);
    // 3 inter-request gaps, then one long break before the 4th
    expect(slept.filter((ms) => ms >= 20000)).toHaveLength(1);
  });

  it('serialises concurrent callers instead of running them in parallel', async () => {
    const { throttle } = harness();
    const order = [];
    let active = 0;
    let maxActive = 0;
    const task = (id) =>
      throttle.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(id);
        active -= 1;
      });
    await Promise.all([task('a'), task('b'), task('c')]);
    expect(maxActive).toBe(1);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('keeps the queue alive after a failure', async () => {
    const { throttle } = harness();
    await expect(throttle.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    );
    await expect(throttle.run(async () => 'still works')).resolves.toBe('still works');
  });
});

describe('Throttle circuit breaker', () => {
  it('trips after the configured number of consecutive blocks', async () => {
    const { throttle } = harness({ breakerThreshold: 3 });
    expect(throttle.noteBlocked()).toBe(false);
    expect(throttle.noteBlocked()).toBe(false);
    expect(throttle.noteBlocked()).toBe(true);
    expect(throttle.isOpen).toBe(true);
    await expect(throttle.run(async () => 'nope')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('a success resets the streak so isolated blocks do not trip it', () => {
    const { throttle } = harness({ breakerThreshold: 3 });
    throttle.noteBlocked();
    throttle.noteBlocked();
    throttle.noteOk();
    expect(throttle.noteBlocked()).toBe(false);
    expect(throttle.isOpen).toBe(false);
  });

  it('reopens after the cooldown elapses', async () => {
    const { throttle, advance } = harness({ breakerThreshold: 1, breakerCooldownMs: 1000 });
    throttle.noteBlocked();
    expect(throttle.isOpen).toBe(true);
    advance(1001);
    expect(throttle.isOpen).toBe(false);
    await expect(throttle.run(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('Throttle daily budget', () => {
  it('refuses once the budget is spent', async () => {
    const { throttle } = harness({ dailyBudget: 5 }, { countToday: () => 5 });
    await expect(throttle.run(async () => 'x')).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('allows requests below the budget', async () => {
    const { throttle } = harness({ dailyBudget: 5 }, { countToday: () => 4 });
    await expect(throttle.run(async () => 'x')).resolves.toBe('x');
  });
});
