import { describe, expect, it } from 'vitest';
import {
  BudgetExceededError,
  assertWithinBudget,
  registerSpend,
  remainingUsd,
} from '../budget.js';

const state = { day: '2026-06-11', limitUsd: 25, spentUsd: 24.5 };

describe('guardarraíl de presupuesto diario', () => {
  it('permite gasto dentro del límite', () => {
    expect(() => assertWithinBudget(state, 0.4)).not.toThrow();
  });

  it('corta en seco al exceder el límite', () => {
    expect(() => assertWithinBudget(state, 0.6)).toThrow(BudgetExceededError);
  });

  it('es imposible gastar por encima del presupuesto', () => {
    let s = { day: '2026-06-11', limitUsd: 1, spentUsd: 0 };
    for (let i = 0; i < 9; i++) {
      assertWithinBudget(s, 0.1);
      s = registerSpend(s, 0.1);
    }
    expect(remainingUsd(s)).toBeCloseTo(0.1, 6);
    expect(() => assertWithinBudget(s, 0.2)).toThrow(BudgetExceededError);
  });
});
