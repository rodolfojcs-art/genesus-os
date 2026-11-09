import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { topologicalLayers } from '@genesus/core';
import { env, hasAnthropic, hasSupabase } from './env.js';
import { rateLimitOk } from './auth.js';
import { BudgetCutoffError, recentRuns, streamCompletion, councilCompletion, brainInventory } from './llm.js';
import { runCommand, openApp, listDir, pcControlEnabled, listUndo, undoAction } from './pcControl.js';
import { pcAgent } from './pcAgent.js';
import { listRoutines, createRoutine, deleteRoutine, runRoutine } from './routines.js';
import { startWorkflow, getRun, FLOW_NAMES } from './workflows.js';
import { indexFolder, searchDisk, diskIndexStatus } from './diskIndex.js';
import { createDocument, readDocument, readUploadedDocument, listArtifacts, type DocSpec } from './documents.js';
import type { LlmCaller } from '@genesus/core';
import type { BudgetGateway } from './budget.js';
import type { MissionService } from './missions.js';
import type { MissionQueue } from './queue.js';
import type { PersonalAssistant } from './assistant.js';
import { needsDocOrPc } from './assistant.js';
import {
  DIVISIONS,
  buildDirectory,
  getAgent,
  getSubagents,
  networkCounts,
  searchAgents,
  updateAgent,
} from './registry.js';
import { insertRow, listRows, machineAdapter, updateRow } from './store.js';
import { supabase, supabaseReachable } from './supabase.js';
import { notifyN8n } from './webhooks.js';
import {
  allNotes,
  archiveNote,
  buildGraph,
  createNote,
  listTree,
  readNote,
  searchVault,
  writeNote,
} from './vault.js';
import { groundedComplete } from './grounded.js';
import { gbrainCapture, gbrainSearch, gbrainStatus } from './gbrainBridge.js';
import { synthesize, ttsEnabled } from './tts.js';
import {
  addMessage,
  createConversation,
  deleteConversation,
  listConversations,
  listMessages,
  maybeTitle,
  recentHistory,
  renameConversation,
} from './conversations.js';
import {
  createWatcher,
  deleteWatcher,
  listNotifications,
  listWatchers,
  markNotificationRead,
  runDueWatchers,
  setWatcherStatus,
  unreadCount,
} from './watchers.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    userToken: string | null;
  }
}

export interface AppDeps {
  budget: BudgetGateway;
  llm: LlmCaller;
  missions: MissionService;
  queue: MissionQueue;
  assistant: PersonalAssistant;
}

function bad(reply: FastifyReply, message: string): void {
  void reply.code(400).send({ error: message });
}

function handleLlmError(reply: FastifyReply, err: unknown): void {
  if (err instanceof BudgetCutoffError) {
    void reply.code(402).send({ error: err.message, code: 'presupuesto_agotado' });
    return;
  }
  const msg = err instanceof Error ? err.message : 'Error interno';
  void reply.code(500).send({ error: msg });
}

export async function registerRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // ------------------------------------------------------------------ salud
  app.get('/api/health', async () => {
    const sb = await supabaseReachable();
    return {
      ok: true,
      servicio: 'genesus-os-server',
      red: networkCounts(),
      anthropic: hasAnthropic ? 'configurado' : env.SIMULATE_LLM ? 'simulado' : 'sin configurar',
      supabase: !hasSupabase ? 'modo demo (memoria)' : sb.ok ? 'conectado' : `CAIDO: ${sb.detail}`,
      memoria: hasSupabase && sb.ok ? 'permanente (Supabase)' : 'volátil (se pierde al cerrar)',
      cola: deps.queue.kind,
      presupuesto: {
        limiteDiarioUsd: env.BUDGET_DAILY_USD,
        restanteUsd: await deps.budget.remaining(),
      },
    };
  });

  // ============================================================ IA PERSONAL
  const AskSchema = z.object({ question: z.string().min(1).max(8000) });
  app.post('/api/assistant/ask', async (req, reply) => {
    const parsed = AskSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'question requerido');
    try {
      return await deps.assistant.ask(req.userId, req.userToken, parsed.data.question);
    } catch (err) {
      return handleLlmError(reply, err);
    }
  });

  // ------------------------------------------------------------------ voz (TTS)
  const TtsSchema = z.object({
    text: z.string().min(1).max(8000),
    voice: z.string().optional(),
    rate: z.coerce.number().min(0.5).max(2).optional(),
  });
  app.post('/api/tts', async (req, reply) => {
    const parsed = TtsSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'text requerido');
    if (!ttsEnabled()) return reply.code(503).send({ error: 'TTS no disponible' });
    const out = await synthesize(parsed.data.text, parsed.data.voice ?? 'nova', parsed.data.rate ?? 1);
    if (!out) return reply.code(502).send({ error: 'No se pudo generar el audio' });
    return reply
      .header('content-type', out.contentType)
      .header('cache-control', 'no-store')
      .send(Buffer.from(out.audio));
  });

  // -------------------------------------------------------- conversaciones
  app.get('/api/conversations', async (req) => listConversations(req.userId, req.userToken));
  app.post('/api/conversations', async (req, reply) => {
    const c = await createConversation(req.userId, req.userToken);
    // Antes esto devolvía {} (200) en silencio si Supabase fallaba, y el chat
    // "desaparecía" sin explicación. Ahora el fallo es explícito: el frontend
    // puede degradar con aviso en vez de perder la conversación sin decir nada.
    if (!c) return reply.code(503).send({ error: 'No se pudo guardar la conversación (memoria no disponible ahora)' });
    return c;
  });
  app.get('/api/conversations/:id/messages', async (req) => {
    const { id } = req.params as { id: string };
    return listMessages(req.userId, req.userToken, id);
  });
  app.delete('/api/conversations/:id', async (req) => {
    const { id } = req.params as { id: string };
    await deleteConversation(req.userId, req.userToken, id);
    return { ok: true };
  });
  const RenameSchema = z.object({ title: z.string().min(1).max(120) });
  app.post('/api/conversations/:id/rename', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = RenameSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'title requerido');
    await renameConversation(req.userId, req.userToken, id, parsed.data.title);
    return { ok: true };
  });

  // Streaming SSE: camino crítico = recall + respuesta en vivo. El resto
  // (memoria, relevancia, depto) ocurre tras enviar la respuesta.
  const StreamSchema = z.object({
    question: z.string().min(1).max(8000),
    conversationId: z.string().uuid().optional(),
    voice: z.boolean().optional(),
    mode: z
      .enum([
        'cloud', 'local', 'auto', 'council',
        'anthropic', 'openai', 'codex', 'grok', 'gemini', 'groq', 'openclaw', 'hermes', 'ollama',
      ])
      .optional(),
    images: z
      .array(z.object({ mediaType: z.string().max(40), data: z.string().max(8_000_000) }))
      .max(4)
      .optional(),
    /** true cuando la pregunta ya trae el contenido de archivos adjuntos (no enrutar al agente PC). */
    attached: z.boolean().optional(),
  });
  app.post('/api/assistant/ask/stream', async (req, reply) => {
    const parsed = StreamSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'question requerido');
    const { userId, userToken } = req;
    const question = parsed.data.question;
    const conversationId = parsed.data.conversationId ?? null;
    const spoken = parsed.data.voice === true;
    const mode = parsed.data.mode;
    const images = parsed.data.images;
    const attached = parsed.data.attached === true;

    reply.hijack();
    const origin = (req.headers.origin as string | undefined) ?? '*';
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': origin,
    });
    const send = (obj: unknown) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);

    try {
      // Historial de la conversación (contexto para seguimientos) + persistir la pregunta
      const history = conversationId ? await recentHistory(userToken, conversationId, 8) : [];
      if (conversationId) {
        await addMessage(userToken, conversationId, 'user', question);
        await maybeTitle(userToken, conversationId, question);
      }

      const prepared = await deps.assistant.route(userId, userToken, question, { spoken });
      send({
        meta: {
          department: { code: prepared.agent.code, specialty: prepared.agent.specialty },
          recalledMemories: prepared.recalled.length,
          grounded: prepared.grounded || prepared.codeExec,
        },
      });

      let answer = '';
      let citations: Array<{ title: string; url: string }> = [];
      let usedModel = '';
      const MAX = env.GENESUS_MAX_TOKENS;

      if (images?.length) {
        // Visión: con imágenes vamos directo a un cerebro con visión (Claude/Gemini).
        send({ status: 'Analizando la imagen…' });
        await streamCompletion(deps.budget, 'sonnet', prepared.system, question, {
          onChunk: (text) => { answer += text; send({ delta: text }); },
          onDone: (s) => { usedModel = s.model; },
        }, MAX, history, mode, images);
      } else if (pcControlEnabled() && !attached && needsDocOrPc(question)) {
        // Documentos y acciones del PC DESDE EL CHAT: crear/leer Word/Excel/PPT/PDF,
        // buscar/organizar archivos. El agente ejecuta lo seguro y deja lo riesgoso pendiente.
        send({ status: 'Trabajando en tu documento / PC…' });
        const r = await pcAgent(question);
        const files = r.executed
          .filter((a) => a.tool === 'create_document' && a.ok)
          .map((a) => `📄 ${a.input}`)
          .join('\n');
        const pend = r.pending.length
          ? `\n\n⚠️ Requiere tu confirmación (panel «Mi PC»):\n${r.pending.map((p) => `• \`${p.command}\``).join('\n')}`
          : '';
        answer = `${r.text}${files ? `\n\n${files}` : ''}${pend}`;
        usedModel = 'agente PC';
        send({ delta: answer });
      } else if (mode === 'council') {
        // Concilio multi-cerebro: varios modelos responden y Claude sintetiza la
        // mejor respuesta combinada. Es la vía honesta a "el modelo más potente".
        send({ status: 'Consultando varios cerebros (concilio)…' });
        const c = await councilCompletion(deps.budget, prepared.system, question, history, Math.min(MAX, 6000));
        answer = c.text;
        usedModel = c.model;
        send({ council: c.members });
        send({ delta: c.text });
      } else if (prepared.grounded || prepared.codeExec) {
        // Camino fundamentado: web search / ejecución de código real. No es
        // streaming (las herramientas corren server-side), pero evita inventar.
        send({ status: prepared.codeExec ? 'Ejecutando código…' : 'Buscando en la web…' });
        try {
          const g = await groundedComplete(deps.budget, prepared.system, question, {
            webSearch: prepared.grounded,
            codeExecution: prepared.codeExec,
            maxTokens: Math.min(MAX, 8000),
            history,
          });
          answer = g.text;
          citations = g.citations;
          send({ delta: g.text });
        } catch {
          await streamCompletion(deps.budget, 'sonnet', prepared.system, question, {
            onChunk: (text) => {
              answer += text;
              send({ delta: text });
            },
            onDone: (s) => { usedModel = s.model; },
          }, MAX, history, mode);
        }
      } else {
        await streamCompletion(deps.budget, 'sonnet', prepared.system, question, {
          onChunk: (text) => {
            answer += text;
            send({ delta: text });
          },
          onDone: (s) => { usedModel = s.model; },
        }, MAX, history, mode);
      }

      // Persistir la respuesta del asistente en la conversación
      if (conversationId) {
        await addMessage(userToken, conversationId, 'assistant', answer, {
          department: prepared.agent.code,
          grounded: prepared.grounded || prepared.codeExec,
          citations,
        });
      }

      const fin = await deps.assistant.finalize(userId, userToken, question, prepared, answer);
      send({
        done: true,
        relevance: fin.relevance,
        memoryId: fin.memoryId,
        created: prepared.lowScoreSubstantive,
        citations,
        model: usedModel,
      });
      reply.raw.end();
    } catch (err) {
      send({ error: err instanceof Error ? err.message : 'error' });
      reply.raw.end();
    }
  });

  app.get('/api/assistant/memory', async (req) => {
    const { archived } = req.query as { archived?: string };
    return deps.assistant.listMemory(req.userId, req.userToken, archived === '1');
  });

  app.get('/api/assistant/memory/search', async (req) => {
    const { q } = req.query as { q?: string };
    return deps.assistant.searchMemory(req.userId, req.userToken, q ?? '', 20);
  });

  app.post('/api/assistant/memory/:id/archive', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = await deps.assistant.archiveMemory(req.userId, req.userToken, id);
    if (!ok) return reply.code(404).send({ error: 'Memoria no encontrada' });
    return { archived: true };
  });

  app.get('/api/assistant/questions', async (req) =>
    deps.assistant.listQuestions(req.userId, req.userToken),
  );

  app.post('/api/assistant/obsidian/sync', async (req) =>
    deps.assistant.syncObsidian(req.userId, req.userToken),
  );

  // Inventario de cerebros (gateway multi-modelo): qué proveedores hay y si están vivos.
  app.get('/api/models', async () => brainInventory());

  // Briefing proactivo: noticias en tiempo real (web) + pendientes según tu memoria.
  app.get('/api/assistant/briefing', async (req, reply) => {
    const { userId, userToken } = req;
    try {
      const memories = await deps.assistant.listMemory(userId, userToken, false);
      const memCtx = memories
        .slice(0, 10)
        .map((m) => `• ${m.title ? m.title + ': ' : ''}${m.content}`)
        .join('\n');
      const system =
        'Eres GENESUS, la IA personal de Rodolfo. Generas un BRIEFING breve, directo y accionable en español latinoamericano. ' +
        'Usa la búsqueda web para las noticias reales de hoy y cita las fuentes. No inventes.';
      const prompt =
        (memCtx ? `MEMORIA DEL USUARIO (para personalizar):\n${memCtx}\n\n` : '') +
        'Genera un briefing con TRES secciones cortas:\n' +
        '1) 📰 NOTICIAS DE HOY — 4 a 6 titulares actuales y relevantes (tecnología/IA, negocios y Venezuela/LatAm si aplica), cada uno con su fuente.\n' +
        '2) 📌 PENDIENTES — qué quedó abierto según su memoria (si hay).\n' +
        '3) 🎯 HOY DEBERÍAS — 2 o 3 sugerencias accionables.\n' +
        'Sé conciso; viñetas, sin relleno.';
      const g = await groundedComplete(deps.budget, system, prompt, { webSearch: true, maxTokens: 2500 });
      return { text: g.text, citations: g.citations, generatedAt: new Date().toISOString() };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'error al generar briefing' });
    }
  });

  // ====================================================== CONTROL DEL PC
  app.get('/api/pc/status', async () => ({ enabled: pcControlEnabled(), platform: process.platform }));

  const PcRunSchema = z.object({ command: z.string().min(1).max(4000), confirmed: z.boolean().optional() });
  app.post('/api/pc/run', async (req, reply) => {
    if (!pcControlEnabled()) return reply.code(403).send({ error: 'Control del PC desactivado' });
    const parsed = PcRunSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'command requerido');
    return runCommand(parsed.data.command, parsed.data.confirmed === true);
  });

  const PcOpenSchema = z.object({ target: z.string().min(1).max(1000) });
  app.post('/api/pc/open', async (req, reply) => {
    if (!pcControlEnabled()) return reply.code(403).send({ error: 'Control del PC desactivado' });
    const parsed = PcOpenSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'target requerido');
    return openApp(parsed.data.target);
  });

  app.get('/api/pc/ls', async (req, reply) => {
    if (!pcControlEnabled()) return reply.code(403).send({ error: 'Control del PC desactivado' });
    const { path } = req.query as { path?: string };
    return listDir(path ?? process.env.USERPROFILE ?? '.');
  });

  const PcAgentSchema = z.object({ instruction: z.string().min(1).max(4000) });
  app.post('/api/pc/agent', async (req, reply) => {
    if (!pcControlEnabled()) return reply.code(403).send({ error: 'Control del PC desactivado' });
    const parsed = PcAgentSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'instruction requerido');
    try {
      return await pcAgent(parsed.data.instruction);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'error del agente' });
    }
  });

  // ====================================================== DOCUMENTOS (Office/PDF)
  const DocCreateSchema = z.object({
    kind: z.enum(['docx', 'xlsx', 'pptx', 'pdf']),
    filename: z.string().max(160).optional(),
    spec: z.record(z.unknown()),
  });
  app.post('/api/docs/create', async (req, reply) => {
    const parsed = DocCreateSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'kind y spec requeridos');
    try {
      return await createDocument(parsed.data.kind, parsed.data.spec as DocSpec, parsed.data.filename);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'error al crear documento' });
    }
  });
  app.get('/api/docs/read', async (req, reply) => {
    const { path } = req.query as { path?: string };
    if (!path) return bad(reply, 'path requerido');
    return readDocument(path);
  });
  const DocUploadSchema = z.object({ filename: z.string().min(1).max(300), data: z.string().max(30_000_000) });
  app.post('/api/docs/read-upload', async (req, reply) => {
    const parsed = DocUploadSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'filename y data requeridos');
    return readUploadedDocument(parsed.data.filename, parsed.data.data);
  });

  // ====================================================== CENTRO DE DESHACER
  app.get('/api/pc/undo-list', async () => ({ actions: await listUndo() }));
  const UndoSchema = z.object({ id: z.string().min(1) });
  app.post('/api/pc/undo', async (req, reply) => {
    const parsed = UndoSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'id requerido');
    return undoAction(parsed.data.id);
  });

  // ====================================================== RUTINAS
  app.get('/api/routines', async () => ({ routines: await listRoutines() }));
  const RoutineSchema = z.object({
    name: z.string().min(1).max(120),
    instruction: z.string().min(1).max(4000),
    everyMinutes: z.coerce.number().int().positive().optional(),
  });
  app.post('/api/routines', async (req, reply) => {
    const parsed = RoutineSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'name e instruction requeridos');
    return createRoutine(parsed.data.name, parsed.data.instruction, parsed.data.everyMinutes);
  });
  app.delete('/api/routines/:id', async (req) => {
    await deleteRoutine((req.params as { id: string }).id);
    return { deleted: true };
  });
  app.post('/api/routines/:id/run', async (req, reply) => {
    if (!pcControlEnabled()) return reply.code(403).send({ error: 'Control del PC desactivado' });
    return runRoutine((req.params as { id: string }).id);
  });

  // ====================================================== FLUJOS DE NEGOCIO
  const EjecutarFlujoSchema = z.object({
    flow: z.enum(FLOW_NAMES),
    params: z.record(z.unknown()).default({}),
  });
  app.post('/api/flujo/ejecutar', async (req, reply) => {
    const parsed = EjecutarFlujoSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues[0]?.message ?? 'flow/params inválidos');
    const run = startWorkflow(deps.budget, parsed.data.flow, parsed.data.params);
    return reply.code(202).send({ id: run.id, flow: run.flow, status: run.status });
  });
  app.get('/api/flujo/estado/:id', async (req, reply) => {
    const run = getRun((req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: 'ejecución no encontrada' });
    return run;
  });
  // Webhook ENTRANTE (n8n → GENESUS dispara un flujo). Fuera de /api/: no exige
  // el JWT de Supabase (n8n no tiene sesión de usuario); si N8N_INBOUND_SECRET
  // está configurado, exige el header x-webhook-secret en su lugar.
  app.post('/webhook/n8n', async (req, reply) => {
    if (env.N8N_INBOUND_SECRET && req.headers['x-webhook-secret'] !== env.N8N_INBOUND_SECRET) {
      return reply.code(401).send({ error: 'secreto inválido' });
    }
    const parsed = EjecutarFlujoSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues[0]?.message ?? 'flow/params inválidos');
    const run = startWorkflow(deps.budget, parsed.data.flow, parsed.data.params);
    return reply.code(202).send({ id: run.id, flow: run.flow, status: run.status });
  });

  // ====================================================== ÍNDICE DE DISCO
  app.get('/api/disk/status', async () => diskIndexStatus());
  const DiskIndexSchema = z.object({ folder: z.string().min(1).max(1000) });
  app.post('/api/disk/index', async (req, reply) => {
    const parsed = DiskIndexSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'folder requerido');
    return indexFolder(parsed.data.folder);
  });
  app.get('/api/disk/search', async (req) => {
    const { q } = req.query as { q?: string };
    return { hits: q ? await searchDisk(q, 12) : [] };
  });

  // Workspace de artefactos: listar y abrir los documentos generados por GENESUS.
  app.get('/api/docs/list', async () => ({ artifacts: await listArtifacts() }));
  const DocOpenSchema = z.object({ path: z.string().min(1).max(1000) });
  app.post('/api/docs/open', async (req, reply) => {
    const parsed = DocOpenSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'path requerido');
    if (!pcControlEnabled()) return reply.code(403).send({ error: 'Control del PC desactivado' });
    return openApp(parsed.data.path);
  });

  // ============================================== GBRAIN (cerebro independiente)
  app.get('/api/gbrain/status', async () => gbrainStatus());
  app.get('/api/gbrain/search', async (req) => {
    const { q } = req.query as { q?: string };
    return gbrainSearch(q ?? '', 12);
  });
  const GbrainCaptureSchema = z.object({ text: z.string().min(2).max(8000) });
  app.post('/api/gbrain/capture', async (req, reply) => {
    const parsed = GbrainCaptureSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'text requerido');
    return gbrainCapture(parsed.data.text);
  });

  // ======================================================= VIGÍAS (proactividad)
  app.get('/api/watchers', async (req) => listWatchers(req.userId, req.userToken));

  const WatcherSchema = z.object({
    query: z.string().min(3).max(300),
    intervalMin: z.number().int().min(15).max(10080).default(360),
  });
  app.post('/api/watchers', async (req, reply) => {
    const parsed = WatcherSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'query requerido');
    const w = await createWatcher(req.userId, req.userToken, parsed.data.query, parsed.data.intervalMin);
    if (!w) return bad(reply, 'no se pudo crear el vigía');
    return w;
  });

  app.post('/api/watchers/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = req.body as { status?: 'activo' | 'pausado' };
    if (status !== 'activo' && status !== 'pausado') return bad(reply, 'status inválido');
    await setWatcherStatus(req.userId, req.userToken, id, status);
    return { ok: true };
  });

  app.delete('/api/watchers/:id', async (req) => {
    const { id } = req.params as { id: string };
    await deleteWatcher(req.userId, req.userToken, id);
    return { ok: true };
  });

  // Ejecuta una revisión manual ahora (no espera al planificador)
  app.post('/api/watchers/run', async (req) => {
    await runDueWatchers(deps.budget).catch(() => {});
    return { ok: true };
  });

  app.get('/api/notifications', async (req) => listNotifications(req.userId, req.userToken));
  app.get('/api/notifications/unread', async (req) => ({
    count: await unreadCount(req.userId, req.userToken),
  }));
  app.post('/api/notifications/:id/read', async (req) => {
    const { id } = req.params as { id: string };
    await markNotificationRead(req.userId, req.userToken, id);
    return { ok: true };
  });

  // ====================================================== BÓVEDA (Obsidian)
  app.get('/api/vault/tree', async () => listTree());

  app.get('/api/vault/note', async (req, reply) => {
    const { path } = req.query as { path?: string };
    if (!path) return bad(reply, 'path requerido');
    try {
      return readNote(path);
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : 'no encontrada' });
    }
  });

  const WriteNoteSchema = z.object({ path: z.string().min(1), content: z.string().max(500_000) });
  app.post('/api/vault/note', async (req, reply) => {
    const parsed = WriteNoteSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'path y content requeridos');
    try {
      return writeNote(parsed.data.path, parsed.data.content);
    } catch (err) {
      return bad(reply, err instanceof Error ? err.message : 'error');
    }
  });

  const CreateNoteSchema = z.object({ folder: z.string().default(''), title: z.string().min(1).max(120) });
  app.post('/api/vault/create', async (req, reply) => {
    const parsed = CreateNoteSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'title requerido');
    try {
      return createNote(parsed.data.folder, parsed.data.title);
    } catch (err) {
      return bad(reply, err instanceof Error ? err.message : 'error');
    }
  });

  app.post('/api/vault/archive', async (req, reply) => {
    const { path } = req.body as { path?: string };
    if (!path) return bad(reply, 'path requerido');
    try {
      return archiveNote(path);
    } catch (err) {
      return bad(reply, err instanceof Error ? err.message : 'error');
    }
  });

  app.get('/api/vault/search', async (req) => {
    const { q } = req.query as { q?: string };
    return searchVault(q ?? '', 40);
  });

  app.get('/api/vault/graph', async () => buildGraph());

  // Resuelve un [[wikilink]] por título a su ruta (para navegación en la UI)
  app.get('/api/vault/resolve', async (req) => {
    const { title } = req.query as { title?: string };
    const t = (title ?? '').toLowerCase();
    const match = allNotes().find((p) => {
      const name = (p.split('/').pop() ?? '').replace(/\.md$/, '');
      return name.toLowerCase() === t;
    });
    return { path: match ?? null };
  });

  // -------------------------------------------------------- chat GENESUS SSE
  const ChatSchema = z.object({ message: z.string().min(1).max(8000) });
  app.post('/api/genesus/chat', async (req, reply) => {
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'message requerido');

    const remaining = await deps.budget.remaining();
    const system = `Eres GENESUS, Chief Executive Agent de Genesus Technology LLC (genesustech.com).
Diriges 1.000 agentes departamentales en 10 divisiones (ENRG, ELEC, SCI, COMP, DSGN, MFG, SUPL, COMM, FIN, CORP).
Hablas en español latinoamericano, con tono ejecutivo y directo. Presupuesto restante del día: $${remaining.toFixed(2)}.
Si el usuario te pide crear algo (producto, análisis, planta, diseño), explica brevemente cómo lo descompondrías
y sugiérele crear una misión formal desde el módulo Misiones para activar la red.`;

    reply.hijack();
    const origin = (req.headers.origin as string | undefined) ?? '*';
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': origin,
    });
    try {
      await streamCompletion(deps.budget, 'opus', system, parsed.data.message, {
        onChunk: (text) => {
          reply.raw.write(`data: ${JSON.stringify({ delta: text })}\n\n`);
        },
        onDone: (summary) => {
          reply.raw.write(`data: ${JSON.stringify({ done: true, ...summary })}\n\n`);
          reply.raw.end();
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'error';
      reply.raw.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
      reply.raw.end();
    }
  });

  // ------------------------------------------------------------ LLM directo
  const LlmSchema = z.object({
    tier: z.enum(['sonnet', 'haiku']).default('haiku'),
    system: z.string().max(20_000).default('Responde en español latinoamericano.'),
    prompt: z.string().min(1).max(50_000),
    maxTokens: z.number().int().positive().max(8000).default(1000),
  });
  app.post('/api/llm', async (req, reply) => {
    const parsed = LlmSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues[0]?.message ?? 'input inválido');
    try {
      const res = await deps.llm.complete({
        tier: parsed.data.tier,
        system: parsed.data.system,
        prompt: parsed.data.prompt,
        maxTokens: parsed.data.maxTokens,
      });
      return res;
    } catch (err) {
      return handleLlmError(reply, err);
    }
  });

  // --------------------------------------------------------------- misiones
  const MissionSchema = z.object({
    title: z.string().min(3).max(200),
    brief: z.string().min(10).max(10_000),
    budgetUsd: z.number().positive().max(500).default(5),
  });
  app.post('/api/missions', async (req, reply) => {
    const parsed = MissionSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues[0]?.message ?? 'input inválido');
    try {
      const record = await deps.missions.create(
        req.userId,
        parsed.data.title,
        parsed.data.brief,
        parsed.data.budgetUsd,
      );
      return {
        id: record.id,
        status: record.status,
        plan: record.plan,
        layers: record.plan
          ? topologicalLayers(record.plan.tasks.map((t) => ({ id: t.id, dependsOn: t.depends_on })))
          : [],
      };
    } catch (err) {
      return handleLlmError(reply, err);
    }
  });

  app.get('/api/missions', async (req) => deps.missions.list(req.userId));

  app.get('/api/missions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = deps.missions.get(id);
    if (!record || record.userId !== req.userId) {
      return reply.code(404).send({ error: 'Misión no encontrada' });
    }
    return {
      ...record,
      layers: record.plan
        ? topologicalLayers(record.plan.tasks.map((t) => ({ id: t.id, dependsOn: t.depends_on })))
        : [],
    };
  });

  app.post('/api/missions/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const record = await deps.missions.approve(id, req.userId);
      return { id: record.id, status: record.status };
    } catch (err) {
      return bad(reply, err instanceof Error ? err.message : 'error');
    }
  });

  app.get('/api/missions/:id/artifacts/:artifactId', async (req, reply) => {
    const { id, artifactId } = req.params as { id: string; artifactId: string };
    const record = deps.missions.get(id);
    if (!record || record.userId !== req.userId) {
      return reply.code(404).send({ error: 'Misión no encontrada' });
    }
    const found = deps.missions.readArtifact(id, artifactId);
    if (!found) return reply.code(404).send({ error: 'Artefacto no encontrado' });
    const mime = found.artifact.kind === 'json' ? 'application/json' : 'text/markdown';
    return reply
      .header('content-type', `${mime}; charset=utf-8`)
      .header('content-disposition', `attachment; filename="${found.artifact.fileName}"`)
      .send(found.content);
  });

  // -------------------------------------------------------------------- red
  app.get('/api/divisions', async () =>
    DIVISIONS.map((d) => ({ ...d, agentes: 100, subagentes: 1000 })),
  );

  app.get('/api/agents', async (req) => {
    const query = req.query as Record<string, string | undefined>;
    return searchAgents({
      q: query.q,
      division: query.division,
      page: query.page ? Number(query.page) : 1,
      pageSize: query.pageSize ? Number(query.pageSize) : 24,
    });
  });

  app.get('/api/agents/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const agent = getAgent(code);
    if (!agent) return reply.code(404).send({ error: 'Agente no encontrado' });
    return { ...agent, subagents: getSubagents(code) };
  });

  const AgentPatchSchema = z.object({
    status: z.enum(['activo', 'inactivo']).optional(),
    systemPrompt: z.string().min(50).max(20_000).optional(),
  });
  app.patch('/api/agents/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const parsed = AgentPatchSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'patch inválido');
    const updated = await updateAgent(code, parsed.data);
    if (!updated) return reply.code(404).send({ error: 'Agente no encontrado' });
    return updated;
  });

  const AgentTestSchema = z.object({ prompt: z.string().min(1).max(10_000) });
  app.post('/api/agents/:code/test', async (req, reply) => {
    const { code } = req.params as { code: string };
    const agent = getAgent(code);
    if (!agent) return reply.code(404).send({ error: 'Agente no encontrado' });
    const parsed = AgentTestSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'prompt requerido');
    try {
      return await deps.llm.complete({
        tier: 'sonnet',
        system: agent.systemPrompt,
        prompt: parsed.data.prompt,
        maxTokens: 2000,
      });
    } catch (err) {
      return handleLlmError(reply, err);
    }
  });

  // ------------------------------------------------------------------ costos
  app.get('/api/costs/summary', async () => {
    const today = new Date().toISOString().slice(0, 10);
    let rows = recentRuns.filter((r) => r.createdAt.startsWith(today));
    const sb = supabase();
    if (sb) {
      const { data } = await sb
        .from('runs')
        .select('model, tokens_in, tokens_out, cost_usd, created_at')
        .gte('created_at', `${today}T00:00:00Z`)
        .limit(5000);
      if (data) {
        rows = data.map((r) => ({
          id: '',
          taskId: null,
          model: r.model as string,
          tokensIn: Number(r.tokens_in),
          tokensOut: Number(r.tokens_out),
          costUsd: Number(r.cost_usd),
          latencyMs: 0,
          createdAt: r.created_at as string,
        }));
      }
    }
    const byModel = new Map<string, { llamadas: number; tokensIn: number; tokensOut: number; costUsd: number }>();
    let spent = 0;
    for (const r of rows) {
      spent += r.costUsd;
      const agg = byModel.get(r.model) ?? { llamadas: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
      agg.llamadas++;
      agg.tokensIn += r.tokensIn;
      agg.tokensOut += r.tokensOut;
      agg.costUsd += r.costUsd;
      byModel.set(r.model, agg);
    }
    return {
      dia: today,
      limiteUsd: env.BUDGET_DAILY_USD,
      gastadoHoyUsd: Math.round(spent * 1e6) / 1e6,
      restanteUsd: await deps.budget.remaining(),
      llamadasHoy: rows.length,
      porModelo: [...byModel.entries()].map(([model, agg]) => ({ model, ...agg })),
    };
  });

  // ----------------------------------------------------------------- fábrica
  app.get('/api/machines', async () => {
    const rows = await listRows('machines');
    const out = [];
    for (const row of rows) {
      const adapter = await machineAdapter(String(row.name));
      out.push({
        ...row,
        conector: adapter?.connectorState() ?? 'sin configurar',
        estado: adapter ? await adapter.status() : null,
      });
    }
    return out;
  });

  const StartSchema = z.object({
    qty: z.number().int().positive().max(100_000),
    productSku: z.string().optional(),
  });
  app.post('/api/machines/:name/start', async (req, reply) => {
    const { name } = req.params as { name: string };
    const parsed = StartSchema.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'qty requerido');
    const adapter = await machineAdapter(decodeURIComponent(name));
    if (!adapter) return reply.code(404).send({ error: 'Máquina no encontrada' });
    try {
      const order = await insertRow('orders', {
        kind: 'produccion',
        qty: parsed.data.qty,
        status: 'en_proceso',
        timeline: [
          {
            at: new Date().toISOString(),
            evento: 'orden iniciada',
            maquina: name,
            sku: parsed.data.productSku ?? null,
          },
        ],
      });
      await adapter.startOrder(String(order.id), parsed.data.qty);
      return { order, estado: await adapter.status(), conector: adapter.connectorState() };
    } catch (err) {
      return bad(reply, err instanceof Error ? err.message : 'error');
    }
  });

  app.post('/api/machines/:name/stop', async (req, reply) => {
    const { name } = req.params as { name: string };
    const adapter = await machineAdapter(decodeURIComponent(name));
    if (!adapter) return reply.code(404).send({ error: 'Máquina no encontrada' });
    try {
      await adapter.stop();
      return { estado: await adapter.status() };
    } catch (err) {
      return bad(reply, err instanceof Error ? err.message : 'error');
    }
  });

  // ---------------------------------------------------------------- CRM/MRP
  const crudTables = ['suppliers', 'clients', 'products', 'orders'] as const;
  for (const table of crudTables) {
    app.get(`/api/${table}`, async () => listRows(table));
    app.post(`/api/${table}`, async (req, reply) => {
      const body = req.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return bad(reply, 'cuerpo JSON requerido');
      delete body.id;
      try {
        return await insertRow(table, body);
      } catch (err) {
        return bad(reply, err instanceof Error ? err.message : 'error');
      }
    });
    app.patch(`/api/${table}/:id`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown> | null;
      if (!body) return bad(reply, 'cuerpo JSON requerido');
      delete body.id;
      const row = await updateRow(table, id, body);
      if (!row) return reply.code(404).send({ error: 'No encontrado' });
      return row;
    });
  }

  // ------------------------------------------------------------ configuración
  app.get('/api/config', async () => ({
    presupuestoDiarioUsd: env.BUDGET_DAILY_USD,
    maxAgentesConcurrentes: env.MAX_CONCURRENT_AGENTS,
    profundidadMaxima: env.MAX_RECURSION_DEPTH,
    autoAprobarBajoUsd: env.AUTO_APPROVE_UNDER_USD,
    n8n: env.N8N_WEBHOOK_URL ? 'configurado' : 'sin configurar',
    whatsapp: env.EVOLUTION_API_URL ? 'configurado' : 'sin configurar',
    supabase: !hasSupabase ? 'modo demo' : (await supabaseReachable()).ok ? 'conectado' : 'caido',
    anthropic: hasAnthropic ? 'configurado' : env.SIMULATE_LLM ? 'simulado' : 'sin configurar',
    cola: deps.queue.kind,
  }));

  app.post('/api/config/webhook-test', async () =>
    notifyN8n({
      event: 'webhook.test',
      missionId: 'test',
      title: 'Prueba de webhook GENESUS OS',
      status: 'test',
      costUsd: 0,
      at: new Date().toISOString(),
    }),
  );

  // Directorio que ve GENESUS para un brief dado (útil para depurar planning)
  app.get('/api/genesus/directory', async (req) => {
    const { brief } = req.query as { brief?: string };
    return { directory: buildDirectory(brief ?? '') };
  });

  // Rate limiting de la API (solo /api/, excepto health; no afecta UI estática)
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/health') return;
    if (!rateLimitOk(req.userId || req.ip)) {
      await reply.code(429).send({ error: 'Demasiadas solicitudes, espera un minuto' });
    }
  });
}
