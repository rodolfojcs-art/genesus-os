import { env } from './env.js';
import { resolveModel } from '@genesus/core';
import { modelOverrides } from './env.js';
import {
  classifyCommand,
  listDir,
  openApp,
  readTextFile,
  runCommand,
  writeTextFile,
  editTextFile,
  pcControlEnabled,
} from './pcControl.js';
import { createDocument, readDocument, type DocKind, type DocSpec } from './documents.js';

/**
 * Agente de control del PC: convierte una instrucción en español en acciones
 * reales sobre Windows usando Claude con herramientas (tool use). Ejecuta las
 * acciones SEGURAS por sí solo; las que modifican el sistema las DEJA PENDIENTES
 * de confirmación (el usuario aprueba en la UI). Nunca ejecuta lo bloqueado.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const TOOLS = [
  {
    name: 'run_powershell',
    description:
      'Ejecuta un comando de PowerShell en el PC Windows del usuario. Para tareas de solo lectura (consultar, listar, ver estado). Las acciones que modifican el sistema quedarán pendientes de confirmación del usuario.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Comando de PowerShell a ejecutar' } },
      required: ['command'],
    },
  },
  {
    name: 'open_app',
    description: 'Abre una aplicación, carpeta o documento por nombre o ruta (ej: "notepad", "calc", "C:\\\\Users").',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Nombre de la app o ruta' } },
      required: ['target'],
    },
  },
  {
    name: 'list_dir',
    description: 'Lista el contenido de una carpeta (solo lectura).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta de la carpeta' } },
      required: ['path'],
    },
  },
  {
    name: 'read_file',
    description: 'Lee un archivo de texto (solo lectura).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta del archivo' } },
      required: ['path'],
    },
  },
  {
    name: 'read_document',
    description:
      'Lee y extrae el texto de un documento de oficina: Word (.docx), Excel (.xlsx), PDF (.pdf) o texto. Úsalo para analizar el contenido de un archivo del usuario.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta del documento' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Escribe un archivo de texto/código en disco (crea o sobrescribe): .txt, .md, .py, .js, .json, .csv, .html, etc. Crear nuevo es directo; sobrescribir pide confirmación.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta completa del archivo' },
        content: { type: 'string', description: 'Contenido a escribir' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Edita un archivo de texto/código por buscar-y-reemplazar (hace respaldo .bak automático). Úsalo para cambios puntuales en archivos existentes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta del archivo' },
        find: { type: 'string', description: 'Texto exacto a buscar' },
        replace: { type: 'string', description: 'Texto de reemplazo' },
        all: { type: 'boolean', description: 'Reemplazar todas las ocurrencias (por defecto sí)' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'create_document',
    description:
      'Crea un documento REAL en disco: Word (docx), Excel (xlsx), PowerPoint (pptx) o PDF. Se guarda en Documentos/GENESUS y se abre automáticamente.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['docx', 'xlsx', 'pptx', 'pdf'] },
        filename: { type: 'string', description: 'Nombre del archivo (sin extensión o con ella)' },
        spec: {
          type: 'object',
          description:
            'Contenido. docx/pdf: {title, blocks:[{type:"heading"|"paragraph"|"bullets"|"table", text, level(1-3), items:[], rows:[[]]}]}. xlsx: {title, sheets:[{name, rows:[[]]}]} (1ª fila = encabezado). pptx: {title, slides:[{title, bullets:[], text}]}.',
        },
      },
      required: ['kind', 'spec'],
    },
  },
];

const SYSTEM =
  'Eres GENESUS operando el PC Windows de Rodolfo. Eres RESOLUTIVO y DIRECTO, como un ingeniero senior: ' +
  'completas la tarea de una vez, tomando decisiones razonables por defecto en lugar de preguntar. NO pidas aclaraciones ' +
  'salvo que sea imprescindible; si falta un detalle (nombre de archivo, contenido), elige una opción sensata y avanza. ' +
  'Herramientas: run_powershell (comandos), read_file/read_document (leer texto/Word/Excel/PDF), write_file (crear/editar texto y código), ' +
  'edit_file (buscar-reemplazar con respaldo .bak), create_document (Word/Excel/PowerPoint/PDF, se abre solo), open_app, list_dir. ' +
  'Ejecuta directamente lo de solo lectura, crear archivos nuevos y editar (respaldado). Solo quedan PENDIENTES de confirmación las acciones ' +
  'destructivas o de sobrescritura; no insistas en ellas. Nunca desactives la seguridad ni toques archivos del sistema. ' +
  'Encadena varios pasos si hace falta para resolver el problema completo. ' +
  'Al terminar, responde en español de forma breve: qué hiciste y dónde quedó. No cierres con preguntas de relleno.';

export interface PcAgentResult {
  text: string;
  executed: Array<{ tool: string; input: string; ok: boolean; output?: string }>;
  pending: Array<{ command: string; reason?: string }>;
}

interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
interface TextBlock { type: 'text'; text: string }
type ContentBlock = ToolUseBlock | TextBlock | { type: string; [k: string]: unknown };

async function callClaude(messages: unknown[]): Promise<{ content: ContentBlock[]; stop_reason: string }> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: resolveModel('sonnet', modelOverrides),
      max_tokens: 1500,
      system: SYSTEM,
      tools: TOOLS,
      messages,
    }),
  });
  const body = (await res.json()) as { content?: ContentBlock[]; stop_reason?: string; error?: { message: string } };
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? 'error'}`);
  return { content: body.content ?? [], stop_reason: body.stop_reason ?? 'end_turn' };
}

/** Ejecuta una herramienta y devuelve el resultado + metadatos de UI. */
async function runTool(
  name: string,
  input: Record<string, unknown>,
  executed: PcAgentResult['executed'],
  pending: PcAgentResult['pending'],
): Promise<string> {
  if (name === 'run_powershell') {
    const command = String(input.command ?? '');
    const cls = classifyCommand(command);
    if (cls.level === 'blocked') {
      executed.push({ tool: name, input: command, ok: false, output: `bloqueado: ${cls.reason}` });
      return `BLOQUEADO (${cls.reason}). No se ejecuta por seguridad.`;
    }
    if (cls.level === 'confirm') {
      pending.push({ command });
      return `PENDIENTE_DE_CONFIRMACIÓN: el usuario debe aprobar este comando antes de ejecutarse: ${command}`;
    }
    const r = await runCommand(command, false);
    const out = (r.stdout ?? '') + (r.stderr ? `\n[err] ${r.stderr}` : '');
    executed.push({ tool: name, input: command, ok: r.executed, output: out.slice(0, 1500) });
    return out.slice(0, 4000) || '(sin salida)';
  }
  if (name === 'open_app') {
    const target = String(input.target ?? '');
    const r = await openApp(target);
    executed.push({ tool: name, input: target, ok: r.executed, output: r.stdout });
    return r.executed ? `Abierto: ${target}` : `No se pudo abrir: ${r.reason ?? ''}`;
  }
  if (name === 'list_dir') {
    const path = String(input.path ?? '');
    const r = await listDir(path);
    if ('error' in r) return `Error: ${r.error}`;
    executed.push({ tool: name, input: path, ok: true });
    return r.entries.map((e) => `${e.dir ? '[dir] ' : '      '}${e.name}`).join('\n').slice(0, 4000);
  }
  if (name === 'read_file') {
    const path = String(input.path ?? '');
    const r = await readTextFile(path);
    if ('error' in r) return `Error: ${r.error}`;
    executed.push({ tool: name, input: path, ok: true });
    return r.content.slice(0, 4000);
  }
  if (name === 'read_document') {
    const path = String(input.path ?? '');
    const r = await readDocument(path);
    if ('error' in r) {
      executed.push({ tool: name, input: path, ok: false, output: r.error });
      return `Error: ${r.error}`;
    }
    executed.push({ tool: name, input: path, ok: true, output: `${r.kind}, ${r.text.length} chars` });
    return r.text.slice(0, 8000) + (r.truncated ? '\n…(truncado)' : '');
  }
  if (name === 'write_file') {
    const path = String(input.path ?? '');
    const r = await writeTextFile(path, String(input.content ?? ''), false);
    if (r.needsConfirmation) {
      pending.push({ command: `Sobrescribir archivo: ${path}` });
      return `PENDIENTE_DE_CONFIRMACIÓN: el archivo ya existe; el usuario debe aprobar sobrescribir ${path}.`;
    }
    executed.push({ tool: name, input: path, ok: r.executed, output: r.stdout ?? r.reason ?? r.stderr });
    return r.executed ? (r.stdout ?? 'escrito') : `No se escribió: ${r.reason ?? r.stderr ?? ''}`;
  }
  if (name === 'edit_file') {
    const path = String(input.path ?? '');
    const r = await editTextFile(path, String(input.find ?? ''), String(input.replace ?? ''), input.all !== false);
    executed.push({ tool: name, input: path, ok: r.executed, output: r.stdout ?? r.stderr });
    return r.executed ? (r.stdout ?? 'editado') : `No se editó: ${r.stderr ?? r.reason ?? ''}`;
  }
  if (name === 'create_document') {
    const kind = String(input.kind ?? 'docx') as DocKind;
    const spec = (input.spec ?? {}) as DocSpec;
    const filename = input.filename ? String(input.filename) : undefined;
    try {
      const doc = await createDocument(kind, spec, filename);
      await openApp(doc.path); // abrir automáticamente el documento creado
      executed.push({ tool: name, input: `${kind}: ${doc.path}`, ok: true, output: `${doc.bytes} bytes, abierto` });
      return `Documento creado y abierto: ${doc.path} (${doc.bytes} bytes)`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error';
      executed.push({ tool: name, input: kind, ok: false, output: msg });
      return `Error al crear el documento: ${msg}`;
    }
  }
  return 'herramienta desconocida';
}

/** Bucle agente: instrucción → acciones (máx 6 iteraciones de herramientas). */
export async function pcAgent(instruction: string): Promise<PcAgentResult> {
  if (!pcControlEnabled()) {
    return { text: 'El control del PC está desactivado. Actívalo con PC_CONTROL_ENABLED=1 (solo Windows).', executed: [], pending: [] };
  }
  if (!env.ANTHROPIC_API_KEY) {
    return { text: 'El agente del PC necesita ANTHROPIC_API_KEY para razonar las acciones.', executed: [], pending: [] };
  }

  const executed: PcAgentResult['executed'] = [];
  const pending: PcAgentResult['pending'] = [];
  const messages: unknown[] = [{ role: 'user', content: instruction }];
  let finalText = '';

  for (let i = 0; i < 6; i++) {
    const { content, stop_reason } = await callClaude(messages);
    const textParts = content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text);
    if (textParts.length) finalText = textParts.join('\n');

    const toolUses = content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (stop_reason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content });
    const results = [];
    for (const tu of toolUses) {
      const out = await runTool(tu.name, tu.input, executed, pending);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
    }
    messages.push({ role: 'user', content: results });
  }

  return { text: finalText || 'Listo.', executed, pending };
}
