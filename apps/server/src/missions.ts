import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  MissionEngine,
  type LlmCaller,
  type MissionEvent,
  type MissionPlan,
  type MissionStatus,
  type TaskExecutionResult,
} from '@genesus/core';
import { env } from './env.js';
import { BudgetCutoffError } from './llm.js';
import { buildDirectory, getAgent, getSubagents } from './registry.js';
import { supabase } from './supabase.js';
import { notifyN8n } from './webhooks.js';
import type { MissionQueue } from './queue.js';

const ARTIFACTS_DIR = resolve(process.cwd(), 'artifacts');

export interface StoredArtifact {
  id: string;
  kind: 'markdown' | 'json' | 'csv' | 'svg';
  title: string;
  fileName: string;
  taskId: string | null;
}

export interface TimedMissionEvent {
  at: string;
  event: MissionEvent;
}

export interface MissionRecord {
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
  events: TimedMissionEvent[];
  results: TaskExecutionResult[];
  synthesis: string;
  artifacts: StoredArtifact[];
  error: string | null;
}

function summarize(m: MissionRecord) {
  return {
    id: m.id,
    title: m.title,
    status: m.status,
    costUsd: m.costUsd,
    estCostUsd: m.plan?.est_total_cost_usd ?? 0,
    tasks: m.plan?.tasks.length ?? 0,
    createdAt: m.createdAt,
    completedAt: m.completedAt,
  };
}

export class MissionService {
  private missions = new Map<string, MissionRecord>();

  constructor(
    private readonly llm: LlmCaller,
    private readonly queue: MissionQueue,
  ) {}

  list(userId: string) {
    return [...this.missions.values()]
      .filter((m) => m.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(summarize);
  }

  get(id: string): MissionRecord | undefined {
    return this.missions.get(id);
  }

  private engineFor(record: MissionRecord): MissionEngine {
    return new MissionEngine({
      llm: this.llm,
      maxConcurrent: env.MAX_CONCURRENT_AGENTS,
      maxQaRetries: 2,
      getAgent: (code) => {
        const a = getAgent(code);
        if (!a || a.status !== 'activo') return undefined;
        const qa = getSubagents(code).find((s) => s.code.endsWith('.5'));
        return {
          code: a.code,
          specialty: a.specialty,
          systemPrompt: a.systemPrompt,
          qaSubagentPrompt: qa?.systemPrompt,
        };
      },
      onEvent: (event) => {
        record.events.push({ at: new Date().toISOString(), event });
      },
    });
  }

  /** Intake + planning. Nada se ejecuta sin aprobación (salvo auto-aprobación configurada). */
  async create(
    userId: string,
    title: string,
    brief: string,
    budgetUsd: number,
  ): Promise<MissionRecord> {
    const record: MissionRecord = {
      id: crypto.randomUUID(),
      userId,
      title,
      brief,
      status: 'borrador',
      plan: null,
      budgetUsd,
      costUsd: 0,
      createdAt: new Date().toISOString(),
      completedAt: null,
      events: [],
      results: [],
      synthesis: '',
      artifacts: [],
      error: null,
    };
    this.missions.set(record.id, record);
    await this.persist(record);

    const engine = this.engineFor(record);
    record.plan = await engine.plan(brief, buildDirectory(brief));
    record.status = 'planificada';
    await this.persist(record);

    if (
      env.AUTO_APPROVE_UNDER_USD > 0 &&
      record.plan.est_total_cost_usd <= env.AUTO_APPROVE_UNDER_USD
    ) {
      await this.approve(record.id, userId);
    }
    return record;
  }

  async approve(id: string, userId: string): Promise<MissionRecord> {
    const record = this.missions.get(id);
    if (!record || record.userId !== userId) throw new Error('Misión no encontrada');
    if (record.status !== 'planificada') {
      throw new Error(`La misión está en estado "${record.status}", no se puede aprobar`);
    }
    record.status = 'aprobada';
    await this.persist(record);
    await this.queue.enqueue(id);
    return record;
  }

  /** Ejecutada por la cola (pg-boss o in-process). */
  async run(id: string): Promise<void> {
    const record = this.missions.get(id);
    if (!record || !record.plan) return;
    const engine = this.engineFor(record);
    record.status = 'en_ejecucion';
    await this.persist(record);

    try {
      record.results = await engine.execute(record.plan);
      record.synthesis = await engine.synthesize(record.plan, record.results);
      record.costUsd = record.results.reduce((s, r) => s + r.costUsd, 0);
      this.writeArtifacts(record);
      record.status = 'completada';
      record.completedAt = new Date().toISOString();
      await this.persist(record);
      await notifyN8n({
        event: 'mission.completed',
        missionId: record.id,
        title: record.title,
        status: record.status,
        costUsd: record.costUsd,
        at: record.completedAt,
      });
    } catch (err) {
      if (err instanceof BudgetCutoffError) {
        record.status = 'pausada_por_presupuesto';
        record.error = err.message;
        await this.persist(record);
        await notifyN8n({
          event: 'mission.budget_paused',
          missionId: record.id,
          title: record.title,
          status: record.status,
          costUsd: record.costUsd,
          at: new Date().toISOString(),
        });
        return;
      }
      record.status = 'fallida';
      record.error = err instanceof Error ? err.message : String(err);
      await this.persist(record);
      await notifyN8n({
        event: 'mission.failed',
        missionId: record.id,
        title: record.title,
        status: record.status,
        costUsd: record.costUsd,
        at: new Date().toISOString(),
      });
    }
  }

  /** Artefactos descargables: plan.json, entregable por tarea (md) y síntesis (md). */
  private writeArtifacts(record: MissionRecord): void {
    const dir = join(ARTIFACTS_DIR, record.id);
    mkdirSync(dir, { recursive: true });

    const add = (artifact: Omit<StoredArtifact, 'id'>, content: string) => {
      const id = crypto.randomUUID();
      writeFileSync(join(dir, artifact.fileName), content, 'utf8');
      record.artifacts.push({ ...artifact, id });
    };

    add(
      { kind: 'json', title: 'Plan de misión (DAG)', fileName: 'plan.json', taskId: null },
      JSON.stringify(record.plan, null, 2),
    );
    for (const r of record.results) {
      if (r.status !== 'completada') continue;
      add(
        {
          kind: 'markdown',
          title: `${r.task.title} (${r.task.department_id})`,
          fileName: `${r.task.id}-entregable.md`,
          taskId: r.task.id,
        },
        `# ${r.task.title}\n\n> Departamento: ${r.task.department_id} · QA: ${r.qaStatus} · Reintentos: ${r.retries}\n\n${r.output}`,
      );
    }
    add(
      { kind: 'markdown', title: 'Síntesis ejecutiva (GENESUS)', fileName: 'sintesis.md', taskId: null },
      record.synthesis,
    );
  }

  readArtifact(missionId: string, artifactId: string): { artifact: StoredArtifact; content: string } | null {
    const record = this.missions.get(missionId);
    const artifact = record?.artifacts.find((a) => a.id === artifactId);
    if (!record || !artifact) return null;
    const path = join(ARTIFACTS_DIR, missionId, artifact.fileName);
    if (!existsSync(path)) return null;
    return { artifact, content: readFileSync(path, 'utf8') };
  }

  /** Persistencia best-effort en Supabase (la fuente operativa v1 es memoria + disco). */
  private async persist(record: MissionRecord): Promise<void> {
    const sb = supabase();
    if (!sb) return;
    const { error } = await sb.from('missions').upsert(
      {
        id: record.id,
        user_id: record.userId,
        title: record.title,
        brief: record.brief,
        status: record.status,
        plan: record.plan,
        budget_usd: record.budgetUsd,
        cost_usd: record.costUsd,
        created_at: record.createdAt,
        completed_at: record.completedAt,
      },
      { onConflict: 'id' },
    );
    if (error) console.error(`[missions] error persistiendo ${record.id}: ${error.message}`);
  }
}
