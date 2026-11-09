import type { ModelTier } from '@genesus/core';
import { tierForRole } from '@genesus/core';

/**
 * Plantilla fija de los 10 subagentes por departamento (master prompt §4.3).
 * Slots 2 (ejecución) y 4 (entregable) usan Sonnet; el resto Haiku.
 */
export interface SubagentRole {
  slot: number;
  role: string;
  mission: string;
  modelTier: ModelTier;
}

const ROLE_DEFS: Array<[slot: number, role: string, mission: string]> = [
  [1, 'Investigación y contexto', 'recopilar contexto, datos de referencia y antecedentes para la tarea'],
  [2, 'Ejecución principal', 'producir el cuerpo principal del trabajo solicitado al departamento'],
  [3, 'Cálculo y verificación técnica', 'verificar números, unidades, supuestos y consistencia técnica'],
  [4, 'Diseño y redacción de entregable', 'dar forma final al entregable con estructura y claridad profesional'],
  [5, 'Control de calidad', 'evaluar el entregable contra los criterios del plan y aprobar o rechazar'],
  [6, 'Riesgos y cumplimiento', 'identificar riesgos, restricciones normativas y puntos de cumplimiento'],
  [7, 'Costos y recursos', 'estimar costos, recursos y tiempos asociados al entregable'],
  [8, 'Documentación', 'documentar supuestos, fuentes y decisiones tomadas'],
  [9, 'Integración con otros departamentos', 'detectar dependencias e interfaces con otros departamentos'],
  [10, 'Reporte y métricas', 'resumir resultados y métricas clave para GENESUS'],
];

export const SUBAGENT_ROLES: SubagentRole[] = ROLE_DEFS.map(([slot, role, mission]) => ({
  slot,
  role,
  mission,
  modelTier: tierForRole('subagent', slot),
}));
