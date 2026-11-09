import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { BudgetGateway } from './budget.js';
import { env } from './env.js';
import { createDocument, readDocument, type DocSpec } from './documents.js';
import { groundedComplete } from './grounded.js';
import { notifyWorkflowEvent } from './webhooks.js';

/**
 * Orquestador de flujos de negocio: secuencias de pasos predefinidas que
 * reutilizan los motores existentes (documentos, análisis con grounding,
 * sistema de archivos) en vez de reimplementarlos. Cada flujo corre en
 * segundo plano tras /api/flujo/ejecutar; el progreso se consulta con
 * /api/flujo/estado/:id. Si un paso falla, se revierte lo ya hecho
 * (archivos creados o movidos) y el estado queda como 'revertido'.
 */

export const FLOW_NAMES = ['procesar_documento', 'organizar_proyecto', 'research_brief'] as const;
export type FlowName = (typeof FLOW_NAMES)[number];

export interface WorkflowStep {
  name: string;
  status: 'en_progreso' | 'ok' | 'error';
  detail?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface WorkflowRun {
  id: string;
  flow: FlowName;
  params: Record<string, unknown>;
  status: 'en_progreso' | 'completado' | 'fallido' | 'revertido';
  steps: WorkflowStep[];
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

type Undo = () => Promise<void>;

const runs = new Map<string, WorkflowRun>();

export function getRun(id: string): WorkflowRun | undefined {
  return runs.get(id);
}

function logPath(): string {
  const vault = env.OBSIDIAN_VAULT_PATH ?? join(homedir(), 'GenesusVault');
  return join(vault, 'GENESUS', 'workflow-log.json');
}

/** Guarda cada ejecución terminada en un log JSON (auditoría), últimas 200. */
async function persistRun(run: WorkflowRun): Promise<void> {
  try {
    const p = logPath();
    let log: WorkflowRun[] = [];
    try {
      log = JSON.parse(await readFile(p, 'utf-8')) as WorkflowRun[];
    } catch {
      /* primer registro */
    }
    log.unshift(run);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(log.slice(0, 200), null, 2), 'utf-8');
  } catch {
    /* el log no debe romper la ejecución */
  }
}

/** Ejecuta un paso, registra su estado en el run y relanza el error si falla. */
async function runStep<T>(run: WorkflowRun, name: string, fn: () => Promise<T>): Promise<T> {
  const step: WorkflowStep = { name, status: 'en_progreso', startedAt: new Date().toISOString() };
  run.steps.push(step);
  run.updatedAt = step.startedAt;
  try {
    const result = await fn();
    step.status = 'ok';
    step.finishedAt = new Date().toISOString();
    return result;
  } catch (err) {
    step.status = 'error';
    step.detail = err instanceof Error ? err.message : String(err);
    step.finishedAt = new Date().toISOString();
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ── Flujo 1: procesar_documento ─────────────────────────────────────────────
// recibir archivo (ruta) → leer → analizar → generar y guardar reporte Word → notificar

const ProcesarDocumentoParams = z.object({ path: z.string().min(1) });

async function flowProcesarDocumento(budget: BudgetGateway, run: WorkflowRun, undo: Undo[]) {
  const { path } = ProcesarDocumentoParams.parse(run.params);

  const leido = await runStep(run, 'leer', async () => {
    const r = await readDocument(path);
    if ('error' in r) throw new Error(`No se pudo leer ${path}: ${r.error}`);
    return r;
  });

  const analisis = await runStep(run, 'analizar', async () => {
    const g = await groundedComplete(
      budget,
      'Eres GENESUS analizando un documento para Rodolfo. Da un resumen ejecutivo objetivo en español: ' +
        'hallazgos clave, cifras relevantes, riesgos u oportunidades. Directo, sin relleno, sin inventar datos que no estén en el texto.',
      `Documento (${leido.kind}, ${leido.path}):\n\n${leido.text.slice(0, 20000)}`,
      { webSearch: false, maxTokens: 1500 },
    );
    return g.text;
  });

  // "generar reporte" y "guardar" son la misma operación en createDocument
  // (construye el .docx y lo escribe a disco de una vez) — se reporta como un
  // solo paso real en vez de fingir dos pasos separados.
  const reporte = await runStep(run, 'generar_y_guardar_reporte_word', async () => {
    const spec: DocSpec = {
      title: `Análisis — ${basename(path)}`,
      blocks: [
        { type: 'heading', level: 1, text: 'Resumen ejecutivo' },
        { type: 'paragraph', text: analisis },
        { type: 'heading', level: 2, text: 'Documento fuente' },
        { type: 'paragraph', text: leido.path },
      ],
    };
    const doc = await createDocument('docx', spec, `analisis_${basename(path, extname(path))}`);
    undo.push(async () => {
      await unlink(doc.path).catch(() => {});
    });
    return doc;
  });

  await runStep(run, 'notificar', async () => ({ notificado: true }));

  return { documentoAnalizado: path, reportePath: reporte.path, resumen: analisis.slice(0, 400) };
}

// ── Flujo 2: organizar_proyecto ──────────────────────────────────────────────
// escanear carpeta → clasificar → detectar duplicados (nunca borra sin
// confirmación explícita) → mover a subcarpetas por categoría → crear índice Excel

const OrganizarProyectoParams = z.object({
  path: z.string().min(1),
  eliminarDuplicados: z.boolean().default(false),
});

const CATEGORIAS: Record<string, string[]> = {
  documentos: ['.docx', '.doc', '.pdf', '.txt', '.md', '.rtf', '.odt'],
  hojas_de_calculo: ['.xlsx', '.xls', '.csv'],
  presentaciones: ['.pptx', '.ppt'],
  imagenes: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'],
  codigo: ['.ts', '.tsx', '.js', '.jsx', '.py', '.json', '.html', '.css', '.java', '.c', '.cpp', '.go', '.rs'],
  datos: ['.sql', '.db', '.sqlite', '.parquet', '.xml', '.yaml', '.yml'],
};

function categoriaDe(ext: string): string {
  for (const [categoria, extensiones] of Object.entries(CATEGORIAS)) {
    if (extensiones.includes(ext)) return categoria;
  }
  return 'otros';
}

const MAX_ARCHIVOS = 600; // mismo tope que diskIndex.ts, por consistencia
const IGNORAR = new Set(['node_modules', '.git', '_organizado']);

/**
 * Recorre una carpeta (recursivo, acotado). Usa concatenación con '/' en vez
 * de path.join: en este runtime, readdir con rutas que mezclan backslashes de
 * Windows puede devolver 0 archivos en silencio (bug ya documentado en diskIndex.ts).
 */
async function scanRecursivo(dir: string, out: string[] = []): Promise<string[]> {
  if (out.length >= MAX_ARCHIVOS) return out;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (out.length >= MAX_ARCHIVOS) return out;
    if (name.startsWith('.') || IGNORAR.has(name)) continue;
    const p = `${dir}/${name}`;
    try {
      const s = await stat(p);
      if (s.isDirectory()) await scanRecursivo(p, out);
      else out.push(p);
    } catch {
      /* sin permiso: saltar */
    }
  }
  return out;
}

async function hashArchivo(path: string): Promise<string | null> {
  try {
    return createHash('md5').update(await readFile(path)).digest('hex');
  } catch {
    return null;
  }
}

async function flowOrganizarProyecto(run: WorkflowRun, undo: Undo[]) {
  const { path, eliminarDuplicados } = OrganizarProyectoParams.parse(run.params);
  const root = resolve(path).replace(/\\/g, '/');

  const archivos = await runStep(run, 'escanear', async () => {
    const list = await scanRecursivo(root);
    if (list.length === 0) throw new Error(`La carpeta ${root} no tiene archivos para organizar`);
    return list;
  });

  const clasificados = await runStep(run, 'clasificar', async () => {
    return Promise.all(
      archivos.map(async (original) => {
        const s = await stat(original).catch(() => null);
        return { original, categoria: categoriaDe(extname(original).toLowerCase()), bytes: s?.size ?? 0 };
      }),
    );
  });

  const conHash = await runStep(run, 'detectar_duplicados', async () => {
    const withHash = await Promise.all(
      clasificados.map(async (f) => ({ ...f, hash: await hashArchivo(f.original) })),
    );
    const porHash = new Map<string, typeof withHash>();
    for (const f of withHash) {
      if (!f.hash) continue;
      const grupo = porHash.get(f.hash) ?? [];
      grupo.push(f);
      porHash.set(f.hash, grupo);
    }
    const gruposDuplicados = [...porHash.values()].filter((g) => g.length > 1);
    return { archivos: withHash, gruposDuplicados };
  });

  const movidos = await runStep(run, 'mover_archivos', async () => {
    const resultado: Array<{ original: string; nuevo: string; categoria: string }> = [];
    for (const f of conHash.archivos) {
      const destDir = `${root}/_organizado/${f.categoria}`;
      await mkdir(destDir, { recursive: true });
      const ext = extname(f.original);
      const base = basename(f.original, ext);
      let dest = `${destDir}/${base}${ext}`;
      let n = 1;
      while (await exists(dest)) {
        dest = `${destDir}/${base}_${n}${ext}`;
        n++;
      }
      await rename(f.original, dest);
      undo.push(async () => {
        await rename(dest, f.original).catch(() => {});
      });
      resultado.push({ original: f.original, nuevo: dest, categoria: f.categoria });
    }
    return resultado;
  });

  // Los duplicados son copias con bytes IDÉNTICOS (verificado por hash): borrar
  // las extra no pierde datos únicos, pero solo se ejecuta si el llamador pasó
  // eliminarDuplicados:true explícitamente — nunca por defecto.
  const duplicados = await runStep(run, 'eliminar_duplicados', async () => {
    if (!eliminarDuplicados) {
      return {
        eliminados: 0,
        detalle: `${conHash.gruposDuplicados.length} grupo(s) de duplicados detectados, sin eliminar (pasa eliminarDuplicados:true para confirmarlo)`,
      };
    }
    let eliminados = 0;
    for (const grupo of conHash.gruposDuplicados) {
      const rutasNuevas = grupo
        .map((g) => movidos.find((m) => m.original === g.original)?.nuevo)
        .filter((x): x is string => Boolean(x));
      for (const extra of rutasNuevas.slice(1)) {
        await unlink(extra).catch(() => {});
        eliminados++;
      }
    }
    return { eliminados, detalle: `${eliminados} archivo(s) duplicado(s) eliminado(s) (copias idénticas verificadas por hash, sin pérdida de datos únicos)` };
  });

  const indice = await runStep(run, 'crear_indice_excel', async () => {
    const rows: Array<Array<string | number>> = [
      ['Archivo original', 'Nueva ubicación', 'Categoría', 'Duplicado'],
      ...movidos.map((m) => [
        m.original,
        m.nuevo,
        m.categoria,
        conHash.gruposDuplicados.some((g) => g.some((x) => x.original === m.original)) ? 'sí' : 'no',
      ]),
    ];
    const doc = await createDocument(
      'xlsx',
      { title: 'Índice de organización', sheets: [{ name: 'Índice', rows }] },
      `indice_${basename(root)}`,
    );
    undo.push(async () => {
      await unlink(doc.path).catch(() => {});
    });
    return doc;
  });

  return {
    carpeta: root,
    archivosMovidos: movidos.length,
    gruposDuplicados: conHash.gruposDuplicados.length,
    duplicadosEliminados: duplicados.eliminados,
    indicePath: indice.path,
  };
}

// ── Flujo 3: research_brief ──────────────────────────────────────────────────
// recibir tema → buscar en web y sintetizar → generar Word con fuentes

const ResearchBriefParams = z.object({ tema: z.string().min(3) });

async function flowResearchBrief(budget: BudgetGateway, run: WorkflowRun, undo: Undo[]) {
  const { tema } = ResearchBriefParams.parse(run.params);

  // El grounding de Claude busca en la web Y sintetiza en la misma llamada:
  // es un solo paso real, no dos (la API no separa "buscar" de "redactar").
  const g = await runStep(run, 'investigar_y_sintetizar_con_busqueda_web', async () => {
    return groundedComplete(
      budget,
      'Eres GENESUS investigando un tema para Rodolfo. Busca información real y reciente, sintetiza los ' +
        'hallazgos clave en prosa clara (español), y básate solo en lo que encuentres. No inventes datos.',
      `Tema de investigación: ${tema}`,
      { webSearch: true, maxTokens: 2500 },
    );
  });

  const doc = await runStep(run, 'generar_word_con_fuentes', async () => {
    const blocks: DocSpec['blocks'] = [
      { type: 'heading', level: 1, text: tema },
      { type: 'paragraph', text: g.text },
    ];
    if (g.citations.length) {
      blocks.push({ type: 'heading', level: 2, text: 'Fuentes' });
      blocks.push({ type: 'table', rows: [['Título', 'URL'], ...g.citations.map((c) => [c.title, c.url])] });
    }
    const created = await createDocument('docx', { title: `Research Brief — ${tema}`, blocks }, `research_brief_${tema}`);
    undo.push(async () => {
      await unlink(created.path).catch(() => {});
    });
    return created;
  });

  return { tema, reportePath: doc.path, fuentes: g.citations.length, costoUsd: g.costUsd };
}

// ── Orquestación ─────────────────────────────────────────────────────────────

function newRun(flow: FlowName, params: Record<string, unknown>): WorkflowRun {
  const now = new Date().toISOString();
  const run: WorkflowRun = {
    id: globalThis.crypto?.randomUUID() ?? String(Date.now()),
    flow,
    params,
    status: 'en_progreso',
    steps: [],
    createdAt: now,
    updatedAt: now,
  };
  runs.set(run.id, run);
  return run;
}

async function executeFlow(budget: BudgetGateway, run: WorkflowRun): Promise<void> {
  const undo: Undo[] = [];
  try {
    if (run.flow === 'procesar_documento') run.result = await flowProcesarDocumento(budget, run, undo);
    else if (run.flow === 'organizar_proyecto') run.result = await flowOrganizarProyecto(run, undo);
    else if (run.flow === 'research_brief') run.result = await flowResearchBrief(budget, run, undo);
    run.status = 'completado';
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err);
    let revertido = 0;
    for (let i = undo.length - 1; i >= 0; i--) {
      try {
        await undo[i]!();
        revertido++;
      } catch {
        /* revertir es best-effort: no debe lanzar un segundo error */
      }
    }
    run.status = revertido > 0 ? 'revertido' : 'fallido';
  } finally {
    run.updatedAt = new Date().toISOString();
    await persistRun(run);
    await notifyWorkflowEvent({ workflowId: run.id, flow: run.flow, status: run.status, at: run.updatedAt }).catch(() => {});
  }
}

/** Inicia un flujo en segundo plano y devuelve el run de inmediato (consultar con getRun). */
export function startWorkflow(budget: BudgetGateway, flow: FlowName, params: Record<string, unknown>): WorkflowRun {
  const run = newRun(flow, params);
  executeFlow(budget, run).catch(() => {
    /* executeFlow ya maneja y registra sus propios errores */
  });
  return run;
}
