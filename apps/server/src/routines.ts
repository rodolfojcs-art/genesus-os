import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { env } from './env.js';
import { pcAgent } from './pcAgent.js';

/**
 * Rutinas programables: secuencias que GENESUS repite (una instrucción en
 * lenguaje natural que ejecuta el agente del PC), a demanda o cada N minutos.
 */

export interface Routine {
  id: string;
  name: string;
  instruction: string;
  everyMinutes?: number;
  lastRun?: string;
  createdAt: string;
}

function routinesPath(): string {
  const vault = env.OBSIDIAN_VAULT_PATH ?? join(homedir(), 'GenesusVault');
  return join(vault, 'GENESUS', 'routines.json');
}

async function readAll(): Promise<Routine[]> {
  try {
    return JSON.parse(await readFile(routinesPath(), 'utf-8')) as Routine[];
  } catch {
    return [];
  }
}

async function saveAll(list: Routine[]): Promise<void> {
  const p = routinesPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(list, null, 2), 'utf-8');
}

export async function listRoutines(): Promise<Routine[]> {
  return readAll();
}

export async function createRoutine(name: string, instruction: string, everyMinutes?: number): Promise<Routine> {
  const list = await readAll();
  const r: Routine = {
    id: globalThis.crypto?.randomUUID() ?? String(Date.now()),
    name,
    instruction,
    everyMinutes: everyMinutes && everyMinutes > 0 ? everyMinutes : undefined,
    createdAt: new Date().toISOString(),
  };
  list.push(r);
  await saveAll(list);
  return r;
}

export async function deleteRoutine(id: string): Promise<void> {
  await saveAll((await readAll()).filter((r) => r.id !== id));
}

export async function runRoutine(id: string): Promise<{ text: string; error?: string }> {
  const list = await readAll();
  const r = list.find((x) => x.id === id);
  if (!r) return { text: '', error: 'rutina no encontrada' };
  const res = await pcAgent(r.instruction);
  r.lastRun = new Date().toISOString();
  await saveAll(list);
  const pend = res.pending.length ? `\n\n⚠️ Pendiente de confirmación (${res.pending.length}).` : '';
  return { text: res.text + pend };
}

/** Planificador: ejecuta rutinas vencidas (con everyMinutes) cada minuto. */
export function startRoutineScheduler(): void {
  setInterval(async () => {
    try {
      const list = await readAll();
      const now = Date.now();
      let changed = false;
      for (const r of list) {
        if (!r.everyMinutes) continue;
        const last = r.lastRun ? Date.parse(r.lastRun) : 0;
        if (now - last >= r.everyMinutes * 60_000) {
          try {
            await pcAgent(r.instruction);
          } catch {
            /* una rutina que falla no debe tumbar el planificador */
          }
          r.lastRun = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) await saveAll(list);
    } catch {
      /* noop */
    }
  }, 60_000);
}
