import {
  MissionPlanSchema,
  type MissionPlan,
  type ModelTier,
  type TaskSpec,
} from './types.js';
import { runDag, type DagTaskResult } from './dag.js';

// ---------------------------------------------------------------------------
// Abstracción LLM: el core no conoce HTTP ni la API de Anthropic. apps/server
// inyecta un LlmCaller que pasa por el proxy con logging y presupuesto.
// ---------------------------------------------------------------------------

export interface LlmRequest {
  tier: ModelTier;
  system: string;
  prompt: string;
  maxTokens?: number;
  taskId?: string | null;
}

export interface LlmResponse {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
}

export interface LlmCaller {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export interface AgentInfo {
  code: string;
  specialty: string;
  systemPrompt: string;
  qaSubagentPrompt?: string;
}

export type MissionEvent =
  | { type: 'plan_creado'; plan: MissionPlan }
  | { type: 'tarea_inicio'; taskId: string; agentCode: string }
  | { type: 'tarea_completada'; taskId: string; costUsd: number; qaStatus: 'aprobado' | 'rechazado' }
  | { type: 'tarea_fallida'; taskId: string; error: string }
  | { type: 'qa_reintento'; taskId: string; intento: number; feedback: string }
  | { type: 'sintesis_completada'; costUsd: number };

export interface TaskExecutionResult {
  task: TaskSpec;
  status: 'completada' | 'fallida' | 'omitida';
  output: string;
  qaStatus: 'aprobado' | 'rechazado' | 'pendiente';
  qaFeedback: string;
  retries: number;
  costUsd: number;
  error?: string;
}

export interface MissionResult {
  plan: MissionPlan;
  tasks: TaskExecutionResult[];
  synthesis: string;
  totalCostUsd: number;
}

export interface MissionEngineOptions {
  llm: LlmCaller;
  getAgent: (code: string) => AgentInfo | undefined;
  maxConcurrent?: number;
  /** Máximo de reintentos tras rechazo de QA (default 2, según master prompt §5.5). */
  maxQaRetries?: number;
  onEvent?: (event: MissionEvent) => void;
}

/** Extrae el primer objeto JSON balanceado de un texto (tolera fences ```json). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('La respuesta del modelo no contiene JSON');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(candidate.slice(start, i + 1));
      }
    }
  }
  throw new Error('JSON incompleto en la respuesta del modelo');
}

const PLANNING_SYSTEM_BASE = `Eres GENESUS, Chief Executive Agent de Genesus Technology LLC.
Diriges una red corporativa de 1.000 agentes departamentales organizados en 10 divisiones:
ENRG (Energía), ELEC (Ingeniería Eléctrica y Física Aplicada), SCI (Ciencias Fundamentales),
COMP (Computación e IA), DSGN (Diseño y Producto), MFG (Manufactura), SUPL (Cadena de Suministro),
COMM (Comercial), FIN (Finanzas) y CORP (Corporativo, Legal y Talento).

Tu trabajo en esta fase es PLANIFICAR: descompón la misión del usuario en un DAG de tareas.
Responde ÚNICAMENTE con un objeto JSON válido con esta forma exacta:
{
  "mission_title": "string",
  "summary": "string (2-3 frases en español)",
  "tasks": [
    {
      "id": "t1",
      "department_id": "XXXX-NNN (código canónico de agente, ej. ENRG-001)",
      "title": "string",
      "objective": "string — qué debe lograr la tarea",
      "deliverable": "string — entregable concreto esperado",
      "depends_on": ["ids de tareas previas"],
      "model_tier": "sonnet" | "haiku",
      "est_cost_usd": number
    }
  ],
  "est_total_cost_usd": number
}
Reglas: entre 3 y 12 tareas; usa haiku solo para validaciones/formateo; las dependencias
deben formar un DAG sin ciclos; los department_id deben existir en el directorio provisto.`;

export class MissionEngine {
  private readonly llm: LlmCaller;
  private readonly getAgent: (code: string) => AgentInfo | undefined;
  private readonly maxConcurrent: number;
  private readonly maxQaRetries: number;
  private readonly onEvent: (event: MissionEvent) => void;

  constructor(options: MissionEngineOptions) {
    this.llm = options.llm;
    this.getAgent = options.getAgent;
    this.maxConcurrent = options.maxConcurrent ?? 8;
    this.maxQaRetries = options.maxQaRetries ?? 2;
    this.onEvent = options.onEvent ?? (() => {});
  }

  /** Fase de planning: GENESUS (Opus) produce un MissionPlan validado con Zod. */
  async plan(brief: string, agentDirectory: string): Promise<MissionPlan> {
    const res = await this.llm.complete({
      tier: 'opus',
      system: `${PLANNING_SYSTEM_BASE}\n\nDIRECTORIO DE AGENTES RELEVANTES:\n${agentDirectory}`,
      prompt: `MISIÓN DEL USUARIO:\n${brief}`,
      maxTokens: 4000,
    });
    const plan = MissionPlanSchema.parse(extractJson(res.text));
    this.onEvent({ type: 'plan_creado', plan });
    return plan;
  }

  /** Fase de ejecución: corre el DAG con QA por tarea y reintentos con feedback. */
  async execute(plan: MissionPlan): Promise<TaskExecutionResult[]> {
    const nodes = plan.tasks.map((t) => ({ id: t.id, dependsOn: t.depends_on }));
    const byId = new Map(plan.tasks.map((t) => [t.id, t]));
    const outputs = new Map<string, string>();

    const dagResults = await runDag<TaskExecutionResult>(
      nodes,
      async (node) => {
        const task = byId.get(node.id)!;
        return this.executeTask(task, outputs);
      },
      { maxConcurrent: this.maxConcurrent },
    );

    return plan.tasks.map((task) => {
      const r: DagTaskResult<TaskExecutionResult> | undefined = dagResults.get(task.id);
      if (!r) {
        return emptyResult(task, 'omitida', 'sin resultado');
      }
      if (r.status === 'completada') return r.value;
      if (r.status === 'fallida') {
        this.onEvent({ type: 'tarea_fallida', taskId: task.id, error: r.error.message });
        return emptyResult(task, 'fallida', r.error.message);
      }
      return emptyResult(task, 'omitida', r.reason);
    });
  }

  private async executeTask(
    task: TaskSpec,
    outputs: Map<string, string>,
  ): Promise<TaskExecutionResult> {
    const agent = this.getAgent(task.department_id);
    if (!agent) {
      throw new Error(`Agente ${task.department_id} no encontrado en el registro`);
    }
    this.onEvent({ type: 'tarea_inicio', taskId: task.id, agentCode: agent.code });

    const context = task.depends_on
      .map((dep) => {
        const out = outputs.get(dep);
        return out ? `--- Salida de la tarea ${dep} ---\n${out}` : '';
      })
      .filter(Boolean)
      .join('\n\n');

    let costUsd = 0;
    let retries = 0;
    let feedback = '';
    let output = '';
    let qaStatus: 'aprobado' | 'rechazado' = 'rechazado';

    while (retries <= this.maxQaRetries) {
      const prompt = [
        `OBJETIVO: ${task.objective}`,
        `ENTREGABLE ESPERADO: ${task.deliverable}`,
        context ? `CONTEXTO DE TAREAS PREVIAS:\n${context}` : '',
        feedback ? `FEEDBACK DE QA (corrige estos puntos):\n${feedback}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      const res = await this.llm.complete({
        tier: task.model_tier,
        system: agent.systemPrompt,
        prompt,
        maxTokens: 4000,
        taskId: task.id,
      });
      costUsd += res.costUsd;
      output = res.text;

      const qa = await this.qaCheck(task, output, agent);
      costUsd += qa.costUsd;
      if (qa.approved) {
        qaStatus = 'aprobado';
        break;
      }
      feedback = qa.feedback;
      retries++;
      if (retries <= this.maxQaRetries) {
        this.onEvent({ type: 'qa_reintento', taskId: task.id, intento: retries, feedback });
      }
    }

    outputs.set(task.id, output);
    this.onEvent({ type: 'tarea_completada', taskId: task.id, costUsd, qaStatus });
    return {
      task,
      status: 'completada',
      output,
      qaStatus,
      qaFeedback: feedback,
      retries,
      costUsd,
    };
  }

  private async qaCheck(
    task: TaskSpec,
    output: string,
    agent: AgentInfo,
  ): Promise<{ approved: boolean; feedback: string; costUsd: number }> {
    const res = await this.llm.complete({
      tier: 'haiku',
      system:
        agent.qaSubagentPrompt ??
        `Eres el subagente de control de calidad del departamento ${agent.code}. ` +
          `Evalúa si el entregable cumple los criterios. Responde en la primera línea ` +
          `exactamente "APROBADO" o "RECHAZADO", y si rechazas, lista los problemas concretos.`,
      prompt:
        `CRITERIOS:\n- Objetivo: ${task.objective}\n- Entregable esperado: ${task.deliverable}\n\n` +
        `ENTREGABLE A EVALUAR:\n${output}`,
      maxTokens: 600,
      taskId: task.id,
    });
    const firstLine = (res.text.trim().split('\n')[0] ?? '').toUpperCase();
    const approved = firstLine.includes('APROBADO') && !firstLine.includes('RECHAZADO');
    return {
      approved,
      feedback: approved ? '' : res.text.trim(),
      costUsd: res.costUsd,
    };
  }

  /** Fase de síntesis: GENESUS (Opus) ensambla el paquete final. */
  async synthesize(plan: MissionPlan, results: TaskExecutionResult[]): Promise<string> {
    const body = results
      .map(
        (r) =>
          `### Tarea ${r.task.id} — ${r.task.title} (${r.task.department_id}, ${r.status}, QA: ${r.qaStatus})\n${r.output || '(sin salida)'}`,
      )
      .join('\n\n');
    const res = await this.llm.complete({
      tier: 'opus',
      system:
        'Eres GENESUS. Sintetiza los entregables de los departamentos en un informe ejecutivo ' +
        'final en español latinoamericano, en markdown, con resumen ejecutivo, hallazgos por ' +
        'área, riesgos y próximos pasos.',
      prompt: `MISIÓN: ${plan.mission_title}\n\nRESULTADOS POR TAREA:\n\n${body}`,
      maxTokens: 6000,
    });
    this.onEvent({ type: 'sintesis_completada', costUsd: res.costUsd });
    return res.text;
  }
}

function emptyResult(
  task: TaskSpec,
  status: 'fallida' | 'omitida',
  error: string,
): TaskExecutionResult {
  return {
    task,
    status,
    output: '',
    qaStatus: 'pendiente',
    qaFeedback: '',
    retries: 0,
    costUsd: 0,
    error,
  };
}
