import type { ModelTier } from './types.js';

/**
 * Routing de tres modelos — regla permanente (sección 1.3):
 *  - opus   → GENESUS raíz: descomposición de misiones, síntesis final.
 *  - sonnet → agentes departamentales: producción de entregables.
 *  - haiku  → subagentes: QA, validación, formateo, tareas atómicas.
 * Nunca Opus para lo que Sonnet resuelve; nunca Sonnet para lo que Haiku resuelve.
 */
export const DEFAULT_MODEL_BY_TIER: Record<ModelTier, string> = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};

export type ModelOverrides = Partial<Record<ModelTier, string>>;

export function resolveModel(tier: ModelTier, overrides?: ModelOverrides): string {
  return overrides?.[tier] ?? DEFAULT_MODEL_BY_TIER[tier];
}

export type AgentRole = 'root' | 'department' | 'subagent';

/** Slots de subagente (1-10). Los slots 2 (ejecución) y 4 (entregable) usan Sonnet. */
export const SONNET_SUBAGENT_SLOTS = new Set([2, 4]);

export function tierForRole(role: AgentRole, subagentSlot?: number): ModelTier {
  switch (role) {
    case 'root':
      return 'opus';
    case 'department':
      return 'sonnet';
    case 'subagent':
      return subagentSlot !== undefined && SONNET_SUBAGENT_SLOTS.has(subagentSlot)
        ? 'sonnet'
        : 'haiku';
  }
}

const ALLOWED_TIERS: Record<AgentRole, ModelTier[]> = {
  root: ['opus'],
  department: ['sonnet', 'haiku'],
  subagent: ['sonnet', 'haiku'],
};

export class RoutingViolationError extends Error {
  constructor(role: AgentRole, tier: ModelTier) {
    super(`Routing inválido: el rol "${role}" no puede usar el tier "${tier}"`);
    this.name = 'RoutingViolationError';
  }
}

/** Lanza si la combinación rol/tier viola la regla permanente de routing. */
export function assertTierAllowed(role: AgentRole, tier: ModelTier): void {
  if (!ALLOWED_TIERS[role].includes(tier)) {
    throw new RoutingViolationError(role, tier);
  }
}
