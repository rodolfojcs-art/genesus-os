import { env } from './env.js';

/**
 * Cola de ejecución de misiones. Con DATABASE_URL usa pg-boss (durable, sobre
 * Postgres, sin Redis); sin ella, ejecución in-process — suficiente para
 * desarrollo, se reporta en /api/health.
 */
export interface MissionQueue {
  readonly kind: 'pg-boss' | 'in-process';
  start(handler: (missionId: string) => Promise<void>): Promise<void>;
  enqueue(missionId: string): Promise<void>;
}

const QUEUE_NAME = 'mission-run';

class InProcessQueue implements MissionQueue {
  readonly kind = 'in-process' as const;
  private handler: ((missionId: string) => Promise<void>) | null = null;

  async start(handler: (missionId: string) => Promise<void>): Promise<void> {
    this.handler = handler;
  }

  async enqueue(missionId: string): Promise<void> {
    const handler = this.handler;
    if (!handler) throw new Error('La cola no está inicializada');
    setImmediate(() => {
      handler(missionId).catch((err) => {
        console.error(`[queue] misión ${missionId} terminó con error no manejado:`, err);
      });
    });
  }
}

class PgBossQueue implements MissionQueue {
  readonly kind = 'pg-boss' as const;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private boss: any = null;

  async start(handler: (missionId: string) => Promise<void>): Promise<void> {
    const { default: PgBoss } = await import('pg-boss');
    this.boss = new PgBoss(env.DATABASE_URL!);
    await this.boss.start();
    await this.boss.createQueue(QUEUE_NAME);
    await this.boss.work(QUEUE_NAME, async (jobs: Array<{ data: { missionId: string } }>) => {
      for (const job of jobs) {
        await handler(job.data.missionId);
      }
    });
  }

  async enqueue(missionId: string): Promise<void> {
    if (!this.boss) throw new Error('pg-boss no está inicializado');
    await this.boss.send(QUEUE_NAME, { missionId });
  }
}

export async function createQueue(): Promise<MissionQueue> {
  if (env.DATABASE_URL) {
    try {
      const q = new PgBossQueue();
      return q;
    } catch (err) {
      console.error('[queue] pg-boss no disponible, usando cola in-process:', err);
    }
  }
  return new InProcessQueue();
}
