import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, extname, basename, resolve } from 'node:path';
import { env } from './env.js';
import { embed, embeddingsEnabled } from './embeddings.js';
import { readDocument } from './documents.js';

/**
 * Índice semántico del disco: escanea una carpeta, extrae el texto de tus
 * archivos (Word/Excel/PDF/texto/código), los embebe (OpenAI) y permite
 * buscarlos por SIGNIFICADO, no solo por nombre.
 */

interface IndexEntry {
  path: string;
  name: string;
  snippet: string;
  vector: number[];
}

const INDEXABLE = /\.(txt|md|csv|json|html|xml|py|js|ts|docx|xlsx|pdf|log)$/i;
const MAX_FILES = 600;

function indexPath(): string {
  const vault = env.OBSIDIAN_VAULT_PATH ?? join(homedir(), 'GenesusVault');
  return join(vault, 'GENESUS', 'disk-index.json');
}

async function loadIndex(): Promise<IndexEntry[]> {
  try {
    return JSON.parse(await readFile(indexPath(), 'utf-8')) as IndexEntry[];
  } catch {
    return [];
  }
}

/** Recorre una carpeta (recursivo, acotado) devolviendo rutas indexables. */
async function walk(dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES) return;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= MAX_FILES) return;
    if (name.startsWith('.') || name === 'node_modules') continue;
    const p = `${dir}/${name}`; // barras normales: readdir de Windows falla con backslashes anidados
    try {
      const s = await stat(p);
      if (s.isDirectory()) await walk(p, out);
      else if (INDEXABLE.test(name) && s.size < 8_000_000) out.push(p);
    } catch {
      /* sin permiso: saltar */
    }
  }
}

async function extractText(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  if (['.docx', '.xlsx', '.pdf'].includes(ext)) {
    const r = await readDocument(path);
    return 'error' in r ? '' : r.text;
  }
  try {
    return (await readFile(path, 'utf-8')).slice(0, 6000);
  } catch {
    return '';
  }
}

export interface IndexResult {
  ok: boolean;
  indexed: number;
  scanned: number;
  error?: string;
}

/** Indexa una carpeta: extrae texto + embebe cada archivo. */
export async function indexFolder(folder: string): Promise<IndexResult> {
  if (!embeddingsEnabled()) return { ok: false, indexed: 0, scanned: 0, error: 'Faltan embeddings (OPENAI_EMBEDDINGS_KEY)' };
  // Normaliza a barras normales: readdir de Windows falla con backslashes en este runtime.
  const root = resolve(folder).replace(/\\/g, '/');
  const files: string[] = [];
  await walk(root, files);
  const entries: IndexEntry[] = [];
  for (const f of files) {
    const text = (await extractText(f)).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const vector = await embed(`${basename(f)}\n${text.slice(0, 4000)}`);
    if (!vector) continue;
    entries.push({ path: f, name: basename(f), snippet: text.slice(0, 240), vector });
  }
  // Fusiona con lo ya indexado de OTRAS carpetas (reemplaza las de esta raíz).
  const prev = (await loadIndex()).filter((e) => !e.path.startsWith(root));
  const merged = [...prev, ...entries];
  const p = indexPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(merged), 'utf-8');
  return { ok: true, indexed: entries.length, scanned: files.length };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export interface DiskHit {
  path: string;
  name: string;
  snippet: string;
  score: number;
}

/** Busca en el índice por significado. */
export async function searchDisk(query: string, limit = 10): Promise<DiskHit[]> {
  const idx = await loadIndex();
  if (idx.length === 0) return [];
  const q = await embed(query);
  if (!q) return [];
  return idx
    .map((e) => ({ path: e.path, name: e.name, snippet: e.snippet, score: cosine(q, e.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export async function diskIndexStatus(): Promise<{ files: number; enabled: boolean }> {
  return { files: (await loadIndex()).length, enabled: embeddingsEnabled() };
}
