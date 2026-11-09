import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { env } from './env.js';

/**
 * Puente a GBrain — el cerebro independiente (RAG híbrido + grafo de conocimiento,
 * de garrytan/gbrain). GENESUS lo invoca por CLI (Bun) sin acoplarse a su interno.
 *
 * Seguridad: GENESUS NO le pasa las llaves del usuario a gbrain. gbrain corre en
 * modo búsqueda por palabras clave/grafo. La síntesis con IA y el vector search se
 * habilitan cuando el usuario configure las llaves en gbrain (decisión suya).
 */

function gbrainDir(): string | null {
  const d = env.GBRAIN_DIR ?? join(homedir(), 'gbrain', 'gbrain-master');
  return existsSync(join(d, 'src', 'cli.ts')) ? d : null;
}

function bunBin(): string | null {
  if (env.BUN_BIN && existsSync(env.BUN_BIN)) return env.BUN_BIN;
  const candidates = [
    join(homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function gbrainAvailable(): boolean {
  return Boolean(gbrainDir() && bunBin());
}

/** Ejecuta un comando del CLI de gbrain y devuelve su stdout (con timeout). */
function runGbrain(args: string[], timeoutMs = 30000): Promise<{ ok: boolean; out: string }> {
  const dir = gbrainDir();
  const bun = bunBin();
  if (!dir || !bun) return Promise.resolve({ ok: false, out: 'gbrain no disponible' });

  return new Promise((resolve) => {
    const proc = spawn(bun, ['run', join(dir, 'src', 'cli.ts'), ...args], {
      cwd: dir,
      // La app GENESUS pasa sus llaves a gbrain (autorizado por el usuario) para
      // habilitar síntesis IA. Embeddings son locales vía Ollama (sin llave).
      env: process.env,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, out: 'timeout' });
    }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out || err });
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, out: 'error al ejecutar gbrain' });
    });
  });
}

export interface GbrainHit {
  score: number;
  slug: string;
  title: string;
}

/** Búsqueda en el cerebro independiente (BM25 + grafo). */
export async function gbrainSearch(query: string, limit = 8): Promise<GbrainHit[]> {
  if (!query.trim()) return [];
  const { ok, out } = await runGbrain(['search', query, '--limit', String(limit)]);
  if (!ok) return [];
  const hits: GbrainHit[] = [];
  for (const line of out.split('\n')) {
    // Formato: [0.9943] inbox/2026-... -- # Título
    const m = /^\[([\d.]+)\]\s+(\S+)\s+--\s+#?\s*(.*)$/.exec(line.trim());
    if (m) hits.push({ score: Number(m[1]), slug: m[2]!, title: (m[3] ?? '').trim() });
  }
  return hits.slice(0, limit);
}

/** Captura un texto en el cerebro independiente (preserva la frase). */
export async function gbrainCapture(text: string): Promise<{ ok: boolean; slug?: string }> {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 6000);
  if (!clean) return { ok: false };
  const { ok, out } = await runGbrain(['capture', clean], 45000);
  const slug = /slug:\s*(\S+)/.exec(out)?.[1];
  return { ok, slug };
}

export interface GbrainStatus {
  available: boolean;
  pages: number;
  chunks: number;
  embeddingCoveragePct: number;
  aiEnabled: boolean;
}

export async function gbrainStatus(): Promise<GbrainStatus> {
  if (!gbrainAvailable()) {
    return { available: false, pages: 0, chunks: 0, embeddingCoveragePct: 0, aiEnabled: false };
  }
  const { ok, out } = await runGbrain(['status', '--json']);
  if (!ok) return { available: true, pages: 0, chunks: 0, embeddingCoveragePct: 0, aiEnabled: false };
  try {
    const start = out.indexOf('{');
    const data = JSON.parse(out.slice(start)) as {
      sync?: { sources?: Array<{ pages?: number; chunks_total?: number; embedding_coverage_pct?: number }> };
    };
    const s = data.sync?.sources?.[0];
    return {
      available: true,
      pages: s?.pages ?? 0,
      chunks: s?.chunks_total ?? 0,
      embeddingCoveragePct: s?.embedding_coverage_pct ?? 0,
      aiEnabled: (s?.embedding_coverage_pct ?? 0) > 0,
    };
  } catch {
    return { available: true, pages: 0, chunks: 0, embeddingCoveragePct: 0, aiEnabled: false };
  }
}
