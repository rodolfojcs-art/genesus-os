import { assertWithinBudget, registerSpend, remainingUsd, type BudgetState } from '@genesus/core';
import { env } from './env.js';
import { supabase } from './supabase.js';

export interface BudgetGateway {
  /** Presupuesto restante del día (USD). */
  remaining(): Promise<number>;
  /** Intenta consumir; si no cabe, allowed=false y NO registra (corte duro). */
  consume(costUsd: number): Promise<{ allowed: boolean; remaining: number }>;
}

/** Implementación Supabase: RPC consume_budget (atómica, FOR UPDATE). */
class SupabaseBudget implements BudgetGateway {
  async remaining(): Promise<number> {
    const { data, error } = await supabase()!.rpc('consume_budget', {
      p_cost: 0,
      p_default_limit: env.BUDGET_DAILY_USD,
    });
    if (error) throw new Error(`consume_budget falló: ${error.message}`);
    return Number(data?.[0]?.remaining ?? 0);
  }

  async consume(costUsd: number): Promise<{ allowed: boolean; remaining: number }> {
    const { data, error } = await supabase()!.rpc('consume_budget', {
      p_cost: costUsd,
      p_default_limit: env.BUDGET_DAILY_USD,
    });
    if (error) throw new Error(`consume_budget falló: ${error.message}`);
    const row = data?.[0];
    return { allowed: Boolean(row?.allowed), remaining: Number(row?.remaining ?? 0) };
  }
}

/** Fallback en memoria para desarrollo sin Supabase. Misma semántica de corte. */
class MemoryBudget implements BudgetGateway {
  private states = new Map<string, BudgetState>();

  private today(): BudgetState {
    const day = new Date().toISOString().slice(0, 10);
    let s = this.states.get(day);
    if (!s) {
      s = { day, limitUsd: env.BUDGET_DAILY_USD, spentUsd: 0 };
      this.states.set(day, s);
    }
    return s;
  }

  async remaining(): Promise<number> {
    return remainingUsd(this.today());
  }

  async consume(costUsd: number): Promise<{ allowed: boolean; remaining: number }> {
    const s = this.today();
    try {
      assertWithinBudget(s, costUsd);
    } catch {
      return { allowed: false, remaining: remainingUsd(s) };
    }
    const next = registerSpend(s, costUsd);
    this.states.set(s.day, next);
    return { allowed: true, remaining: remainingUsd(next) };
  }
}

export function createBudgetGateway(): BudgetGateway {
  return supabase() ? new SupabaseBudget() : new MemoryBudget();
}
