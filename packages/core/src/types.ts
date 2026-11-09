import { z } from 'zod';

/** Niveles de modelo según la regla permanente de routing (sección 1.3 del master prompt). */
export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export type DivisionCode =
  | 'ENRG'
  | 'ELEC'
  | 'SCI'
  | 'COMP'
  | 'DSGN'
  | 'MFG'
  | 'SUPL'
  | 'COMM'
  | 'FIN'
  | 'CORP';

export const DIVISION_CODES: DivisionCode[] = [
  'ENRG',
  'ELEC',
  'SCI',
  'COMP',
  'DSGN',
  'MFG',
  'SUPL',
  'COMM',
  'FIN',
  'CORP',
];

export type AgentStatus = 'activo' | 'inactivo';

export interface DivisionDefinition {
  code: DivisionCode;
  name: string;
  color: string;
  director: string;
  description: string;
}

export interface AgentDefinition {
  /** Código canónico: ENRG-001 … CORP-100 */
  code: string;
  divisionCode: DivisionCode;
  name: string;
  specialty: string;
  description: string;
  capabilities: string[];
  deliverables: string[];
  systemPrompt: string;
  modelTier: ModelTier;
  status: AgentStatus;
}

export interface SubagentDefinition {
  /** Código canónico: ENRG-001.1 … ENRG-001.10 */
  code: string;
  agentCode: string;
  role: string;
  modelTier: ModelTier;
  systemPrompt: string;
}

export type MissionStatus =
  | 'borrador'
  | 'planificada'
  | 'aprobada'
  | 'en_ejecucion'
  | 'completada'
  | 'fallida'
  | 'pausada_por_presupuesto';

export interface Mission {
  id: string;
  userId: string;
  title: string;
  brief: string;
  status: MissionStatus;
  plan: MissionPlan | null;
  budgetUsd: number;
  costUsd: number;
  createdAt: string;
  completedAt: string | null;
}

export type TaskStatus = 'pendiente' | 'en_ejecucion' | 'completada' | 'fallida' | 'omitida';
export type QaStatus = 'pendiente' | 'aprobado' | 'rechazado';

export interface TaskRecord {
  id: string;
  missionId: string;
  agentCode: string;
  dependsOn: string[];
  status: TaskStatus;
  input: unknown;
  output: unknown;
  qaStatus: QaStatus;
  retries: number;
  costUsd: number;
}

/** Log de CADA llamada LLM — obligatorio (guardarraíl de costos). */
export interface Run {
  id: string;
  taskId: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  createdAt: string;
}

export type ArtifactKind = 'markdown' | 'json' | 'svg' | 'csv';

export interface Artifact {
  id: string;
  missionId: string;
  taskId: string | null;
  kind: ArtifactKind;
  title: string;
  storagePath: string;
  meta: Record<string, unknown>;
}

export interface CostEntry {
  day: string;
  limitUsd: number;
  spentUsd: number;
}

// ---------------------------------------------------------------------------
// MissionPlan — JSON producido por GENESUS (Opus) y validado con Zod antes de
// mostrarse al usuario para aprobación. Nada se ejecuta sin plan válido.
// ---------------------------------------------------------------------------

export const TaskSpecSchema = z.object({
  id: z.string().min(1),
  department_id: z
    .string()
    .regex(/^(ENRG|ELEC|SCI|COMP|DSGN|MFG|SUPL|COMM|FIN|CORP)-\d{3}$/, {
      message: 'department_id debe ser un código canónico, ej. ENRG-001',
    }),
  title: z.string().min(1),
  objective: z.string().min(1),
  deliverable: z.string().min(1),
  depends_on: z.array(z.string()).default([]),
  model_tier: z.enum(['sonnet', 'haiku']).default('sonnet'),
  est_cost_usd: z.number().nonnegative().default(0.1),
});

export const MissionPlanSchema = z.object({
  mission_title: z.string().min(1),
  summary: z.string().min(1),
  tasks: z.array(TaskSpecSchema).min(1).max(40),
  est_total_cost_usd: z.number().nonnegative(),
});

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type MissionPlan = z.infer<typeof MissionPlanSchema>;
