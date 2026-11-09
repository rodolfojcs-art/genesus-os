import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { env } from './env.js';

/**
 * Bóveda local de GENESUS — clon de Obsidian dentro del servidor.
 *
 * Es la "boveda de servidor local" donde la memoria es PERMANENTE y se ARCHIVA:
 *   GENESUS/Memoria/  → memorias activas (espejo de brain_memory.status='activa')
 *   GENESUS/Archivo/  → memorias archivadas (status='archivada') — nunca se borran
 *   GENESUS/Notas/    → notas que escribe el usuario (se indexan a BRAIN)
 *
 * Capacidades tipo Obsidian: notas markdown, enlaces [[wiki]], backlinks,
 * búsqueda full-text y grafo de conexiones. Todo servido desde el filesystem
 * local — sin depender de la app Obsidian externa.
 */

export const VAULT_SUB = {
  memoria: join('GENESUS', 'Memoria'),
  archivo: join('GENESUS', 'Archivo'),
  notas: join('GENESUS', 'Notas'),
};

/** Raíz de la bóveda: SIEMPRE existe (env o default local en el home). */
export function vaultRoot(): string {
  return env.OBSIDIAN_VAULT_PATH ?? join(homedir(), 'GenesusVault');
}

/** Compatibilidad: la bóveda siempre está disponible localmente. */
export function vaultPath(): string {
  return vaultRoot();
}

export function ensureVault(): string {
  const root = vaultRoot();
  for (const dir of Object.values(VAULT_SUB)) mkdirSync(join(root, dir), { recursive: true });
  const readme = join(root, 'GENESUS', 'LEEME.md');
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      `# Genesus BRAIN — bóveda local

Esta es tu bóveda de conocimiento, integrada en GENESUS (clon de Obsidian).

- **Memoria/**: memorias activas de tu IA personal (permanentes; se escriben solas).
- **Archivo/**: memorias archivadas (irrelevantes) — se conservan para siempre, nunca se borran.
- **Notas/**: escribe aquí tus notas; se indexan a la memoria permanente.

Usa enlaces \`[[Nombre de otra nota]]\` para conectar ideas. La pestaña **Bóveda**
en GENESUS muestra el árbol, el editor, los backlinks y el grafo de conexiones.
`,
      'utf8',
    );
  }
  return root;
}

// -------------------------------------------------------------------------
// Seguridad: toda ruta relativa se resuelve dentro de la bóveda (anti-traversal)
// -------------------------------------------------------------------------
function safeResolve(relPath: string): string {
  const root = vaultRoot();
  const target = resolve(root, normalize(relPath).replace(/^([/\\])+/, ''));
  const rel = relative(root, target);
  if (rel.startsWith('..') || resolve(target) === resolve(root) + '..') {
    throw new Error('Ruta fuera de la bóveda');
  }
  if (rel.split(sep).some((seg) => seg === '..')) {
    throw new Error('Ruta inválida');
  }
  return target;
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70) || 'nota'
  );
}

/**
 * Nombre de archivo humano (estilo Obsidian: el archivo ES el título).
 * Solo elimina caracteres ilegales en el filesystem; conserva espacios y tildes
 * para que los [[wikilinks]] coincidan con el título de la nota.
 */
export function safeFileName(title: string): string {
  return (
    title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90) || 'Nota'
  );
}

export interface TreeNode {
  name: string;
  path: string; // relativo a la raíz de la bóveda
  type: 'folder' | 'note';
  children?: TreeNode[];
}

/** Árbol de carpetas y notas .md (relativo a la bóveda). */
export function listTree(): TreeNode {
  const root = ensureVault();
  function walk(absDir: string): TreeNode[] {
    const entries = readdirSync(absDir, { withFileTypes: true });
    const folders: TreeNode[] = [];
    const notes: TreeNode[] = [];
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = join(absDir, e.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (e.isDirectory()) {
        folders.push({ name: e.name, path: rel, type: 'folder', children: walk(abs) });
      } else if (e.name.endsWith('.md')) {
        notes.push({ name: e.name.replace(/\.md$/, ''), path: rel, type: 'note' });
      }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    notes.sort((a, b) => a.name.localeCompare(b.name));
    return [...folders, ...notes];
  }
  return { name: 'GENESUS', path: '', type: 'folder', children: walk(join(root, 'GENESUS')) };
}

export interface NoteContent {
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, string>;
  links: string[];
  backlinks: Array<{ path: string; title: string }>;
}

function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { fm: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fm, body: raw.slice(m[0].length) };
}

/** Extrae enlaces [[wiki]] de un texto. */
export function extractLinks(text: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]!.trim());
  return [...out];
}

function noteTitleFromPath(relPath: string): string {
  const name = relPath.split('/').pop() ?? relPath;
  return name.replace(/\.md$/, '');
}

/** Todas las notas .md de la bóveda (rutas relativas). */
export function allNotes(): string[] {
  const root = ensureVault();
  const out: string[] = [];
  function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith('.md')) out.push(relative(root, abs).split(sep).join('/'));
    }
  }
  walk(join(root, 'GENESUS'));
  return out;
}

export function readNote(relPath: string): NoteContent {
  const abs = safeResolve(relPath);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error('Nota no encontrada');
  const raw = readFileSync(abs, 'utf8');
  const { fm, body } = parseFrontmatter(raw);
  const title = noteTitleFromPath(relPath);
  const links = extractLinks(body);

  // Backlinks: notas que enlazan a esta por título
  const backlinks: Array<{ path: string; title: string }> = [];
  for (const other of allNotes()) {
    if (other === relPath) continue;
    const otherRaw = readFileSync(safeResolve(other), 'utf8');
    if (extractLinks(otherRaw).some((l) => l.toLowerCase() === title.toLowerCase())) {
      backlinks.push({ path: other, title: noteTitleFromPath(other) });
    }
  }
  return { path: relPath, title, content: body, frontmatter: fm, links, backlinks };
}

export function writeNote(relPath: string, content: string): NoteContent {
  if (!relPath.endsWith('.md')) throw new Error('La ruta debe terminar en .md');
  const abs = safeResolve(relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return readNote(relPath);
}

export function createNote(folderRel: string, title: string): NoteContent {
  const folder = folderRel || VAULT_SUB.notas.split(sep).join('/');
  const rel = `${folder}/${safeFileName(title)}.md`;
  const abs = safeResolve(rel);
  if (existsSync(abs)) throw new Error('Ya existe una nota con ese nombre');
  const body = `---\ncreada: ${new Date().toISOString()}\norigen: usuario\n---\n\n# ${title}\n\n`;
  return writeNote(rel, body);
}

/** Archiva una nota: la mueve a GENESUS/Archivo (permanente, nunca se borra). */
export function archiveNote(relPath: string): { path: string } {
  const abs = safeResolve(relPath);
  if (!existsSync(abs)) throw new Error('Nota no encontrada');
  const name = relPath.split('/').pop()!;
  const dest = join(vaultRoot(), VAULT_SUB.archivo, name);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(abs, dest);
  return { path: relative(vaultRoot(), dest).split(sep).join('/') };
}

export function deleteNote(relPath: string): void {
  // "Borrar" en GENESUS archiva (la memoria es permanente). Solo Archivo se purga.
  if (relPath.includes(VAULT_SUB.archivo.split(sep).join('/'))) {
    rmSync(safeResolve(relPath), { force: true });
  } else {
    archiveNote(relPath);
  }
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
}

export function searchVault(query: string, limit = 30): SearchHit[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const rel of allNotes()) {
    const raw = readFileSync(safeResolve(rel), 'utf8');
    const lower = raw.toLowerCase();
    const idx = lower.indexOf(q);
    const title = noteTitleFromPath(rel);
    if (idx >= 0 || title.toLowerCase().includes(q)) {
      const at = idx >= 0 ? idx : 0;
      hits.push({
        path: rel,
        title,
        snippet: raw.slice(Math.max(0, at - 40), at + 120).replace(/\n/g, ' '),
      });
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

export interface GraphData {
  nodes: Array<{ id: string; title: string; group: string }>;
  edges: Array<{ source: string; target: string }>;
}

/** Grafo de conexiones [[wiki]] entre notas (como el graph view de Obsidian). */
export function buildGraph(): GraphData {
  const notes = allNotes();
  const titleToPath = new Map<string, string>();
  for (const rel of notes) titleToPath.set(noteTitleFromPath(rel).toLowerCase(), rel);

  const nodes = notes.map((rel) => ({
    id: rel,
    title: noteTitleFromPath(rel),
    group: rel.split('/')[1] ?? 'GENESUS', // Memoria | Archivo | Notas
  }));
  const edges: Array<{ source: string; target: string }> = [];
  for (const rel of notes) {
    const raw = readFileSync(safeResolve(rel), 'utf8');
    for (const link of extractLinks(raw)) {
      const target = titleToPath.get(link.toLowerCase());
      if (target && target !== rel) edges.push({ source: rel, target });
    }
  }
  return { nodes, edges };
}

// -------------------------------------------------------------------------
// Espejo de memoria (BRAIN → bóveda) y sync de notas (bóveda → BRAIN)
// -------------------------------------------------------------------------

export interface NoteInput {
  id: string;
  title: string;
  content: string;
  status: 'activa' | 'archivada';
  department?: string;
  relevance?: string;
}

export function writeMemoryNote(note: NoteInput): string {
  ensureVault();
  const dir = join(vaultRoot(), note.status === 'activa' ? VAULT_SUB.memoria : VAULT_SUB.archivo);
  mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = join(dir, `${day}-${slug(note.title)}-${note.id.slice(0, 8)}.md`);
  writeFileSync(
    file,
    `---
genesus_id: ${note.id}
fecha: ${new Date().toISOString()}
departamento: ${note.department ?? 'n/d'}
relevancia: ${note.relevance ?? 'relevante'}
estado: ${note.status}
---

# ${note.title}

${note.content}
`,
    'utf8',
  );
  return file;
}

export interface ImportedNote {
  title: string;
  content: string;
  file: string;
}

export function readUnsyncedNotes(): ImportedNote[] {
  ensureVault();
  const dir = join(vaultRoot(), VAULT_SUB.notas);
  const out: ImportedNote[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const file = join(dir, name);
    const raw = readFileSync(file, 'utf8');
    if (/^---[\s\S]*?genesus_sync:\s*true[\s\S]*?---/.test(raw)) continue;
    out.push({ title: name.replace(/\.md$/, ''), content: raw, file });
  }
  return out;
}

export function markSynced(file: string): void {
  const raw = readFileSync(file, 'utf8');
  const next = raw.startsWith('---')
    ? raw.replace(/^---\n/, `---\ngenesus_sync: true\n`)
    : `---\ngenesus_sync: true\n---\n\n${raw}`;
  writeFileSync(file, next, 'utf8');
}
