/**
 * Guardarraíl de presupuesto diario. La lógica es pura; el server la conecta a
 * la tabla cost_budgets de Supabase. Corte duro: al agotar el límite, las
 * misiones pasan a `pausada_por_presupuesto` — nunca fallan en silencio.
 */
export interface BudgetState {
  day: string;
  limitUsd: number;
  spentUsd: number;
}

export class BudgetExceededError extends Error {
  readonly remainingUsd: number;
  constructor(state: BudgetState, attemptedUsd: number) {
    const remaining = Math.max(0, state.limitUsd - state.spentUsd);
    super(
      `Presupuesto diario agotado (${state.day}): gastado $${state.spentUsd.toFixed(4)} de $${state.limitUsd.toFixed(2)}, ` +
        `intento de gasto adicional $${attemptedUsd.toFixed(4)} (restante $${remaining.toFixed(4)})`,
    );
    this.name = 'BudgetExceededError';
    this.remainingUsd = remaining;
  }
}

export function remainingUsd(state: BudgetState): number {
  return Math.max(0, state.limitUsd - state.spentUsd);
}

/** Lanza BudgetExceededError si el gasto estimado no cabe en el presupuesto. */
export function assertWithinBudget(state: BudgetState, estimatedUsd: number): void {
  if (state.spentUsd + estimatedUsd > state.limitUsd) {
    throw new BudgetExceededError(state, estimatedUsd);
  }
}

export function registerSpend(state: BudgetState, costUsd: number): BudgetState {
  return { ...state, spentUsd: Math.round((state.spentUsd + costUsd) * 1_000_000) / 1_000_000 };
}
