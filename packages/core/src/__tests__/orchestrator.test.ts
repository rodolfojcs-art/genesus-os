import { describe, expect, it } from 'vitest';
import { MissionEngine, extractJson, type LlmCaller, type LlmRequest } from '../orchestrator.js';

const PLAN_JSON = JSON.stringify({
  mission_title: 'Informe de viabilidad — microturbina 5 kW',
  summary: 'Plan de tres tareas para evaluar viabilidad técnica y comercial.',
  tasks: [
    {
      id: 't1',
      department_id: 'ENRG-001',
      title: 'Especificación técnica',
      objective: 'Definir specs de la microturbina',
      deliverable: 'Documento de especificaciones',
      depends_on: [],
      model_tier: 'sonnet',
      est_cost_usd: 0.2,
    },
    {
      id: 't2',
      department_id: 'FIN-001',
      title: 'Proyección financiera',
      objective: 'Proyectar costos e ingresos',
      deliverable: 'Modelo financiero resumido',
      depends_on: ['t1'],
      model_tier: 'sonnet',
      est_cost_usd: 0.2,
    },
  ],
  est_total_cost_usd: 0.4,
});

function makeAgent(code: string) {
  return { code, specialty: 'demo', systemPrompt: `Agente ${code}` };
}

function fakeLlm(handler: (req: LlmRequest) => string): LlmCaller {
  return {
    async complete(req) {
      return {
        text: handler(req),
        model: `fake-${req.tier}`,
        tokensIn: 100,
        tokensOut: 100,
        costUsd: 0.01,
        latencyMs: 5,
      };
    },
  };
}

describe('extractJson', () => {
  it('extrae JSON con fences y texto alrededor', () => {
    const obj = extractJson('Aquí va el plan:\n```json\n{"a": 1}\n```\nfin');
    expect(obj).toEqual({ a: 1 });
  });

  it('extrae JSON balanceado con llaves anidadas en strings', () => {
    expect(extractJson('x {"a": "tiene } llave", "b": {"c": 2}} y')).toEqual({
      a: 'tiene } llave',
      b: { c: 2 },
    });
  });
});

describe('MissionEngine', () => {
  it('planifica y valida el plan con Zod', async () => {
    const engine = new MissionEngine({
      llm: fakeLlm((req) => (req.tier === 'opus' ? PLAN_JSON : 'APROBADO')),
      getAgent: makeAgent,
    });
    const plan = await engine.plan('misión demo', 'ENRG-001, FIN-001');
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[1]?.depends_on).toEqual(['t1']);
  });

  it('rechaza planes inválidos del modelo', async () => {
    const engine = new MissionEngine({
      llm: fakeLlm(() => '{"mission_title": "x"}'),
      getAgent: makeAgent,
    });
    await expect(engine.plan('misión', 'dir')).rejects.toThrow();
  });

  it('ejecuta el DAG con QA y propaga contexto entre tareas', async () => {
    const prompts: LlmRequest[] = [];
    const engine = new MissionEngine({
      llm: {
        async complete(req) {
          prompts.push(req);
          const text =
            req.tier === 'haiku'
              ? 'APROBADO'
              : req.taskId === 't1'
                ? 'SPEC-TECNICA-V1'
                : 'MODELO-FINANCIERO';
          return { text, model: 'fake', tokensIn: 10, tokensOut: 10, costUsd: 0.01, latencyMs: 1 };
        },
      },
      getAgent: makeAgent,
    });
    const plan = await import('../types.js').then((m) =>
      m.MissionPlanSchema.parse(JSON.parse(PLAN_JSON)),
    );
    const results = await engine.execute(plan);
    expect(results.every((r) => r.status === 'completada')).toBe(true);
    expect(results.every((r) => r.qaStatus === 'aprobado')).toBe(true);
    // La tarea t2 recibe la salida de t1 como contexto
    const t2Prompt = prompts.find((p) => p.taskId === 't2' && p.tier === 'sonnet');
    expect(t2Prompt?.prompt).toContain('SPEC-TECNICA-V1');
  });

  it('reintenta tras rechazo de QA con feedback (máx 2)', async () => {
    let qaCalls = 0;
    const engine = new MissionEngine({
      llm: {
        async complete(req) {
          let text = 'entregable';
          if (req.tier === 'haiku') {
            qaCalls++;
            text = qaCalls === 1 ? 'RECHAZADO: falta la sección de costos' : 'APROBADO';
          }
          return { text, model: 'fake', tokensIn: 10, tokensOut: 10, costUsd: 0.01, latencyMs: 1 };
        },
      },
      getAgent: makeAgent,
      maxQaRetries: 2,
    });
    const plan = await import('../types.js').then((m) =>
      m.MissionPlanSchema.parse(JSON.parse(PLAN_JSON)),
    );
    const results = await engine.execute(plan.tasks.length === 2 ? { ...plan, tasks: [plan.tasks[0]!] } : plan);
    expect(results[0]?.retries).toBe(1);
    expect(results[0]?.qaStatus).toBe('aprobado');
  });
});
