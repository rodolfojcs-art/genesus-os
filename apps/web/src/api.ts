import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

/** Cliente Supabase del frontend: SOLO auth + lecturas con RLS. Nunca llaves de servicio. */
export const supabase: SupabaseClient | null =
  SUPABASE_URL && SUPABASE_ANON ? createClient(SUPABASE_URL, SUPABASE_ANON) : null;

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Toda llamada va al backend propio. El navegador JAMÁS habla con Anthropic. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = {
    'content-type': 'application/json',
    ...(await authHeader()),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // sin cuerpo JSON
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

/** Descarga autenticada de artefactos (blob → archivo). */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, { headers: await authHeader() });
  if (!res.ok) throw new ApiError(res.status, `No se pudo descargar (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Pregunta a la IA personal vía SSE: meta → deltas → done. */
export interface Citation {
  title: string;
  url: string;
}

/** Genera audio de voz (TTS) del texto y devuelve una URL de objeto reproducible. */
export async function ttsToUrl(text: string, voice = 'nova', rate = 1): Promise<string | null> {
  const res = await fetch(`${API_BASE}/api/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ text, voice, rate }),
  });
  if (!res.ok) return null;
  const blob = await res.blob();
  if (blob.size === 0) return null;
  return URL.createObjectURL(blob);
}

export type ReasoningMode =
  | 'cloud' | 'local' | 'auto' | 'council'
  | 'anthropic' | 'openai' | 'codex' | 'grok' | 'gemini' | 'groq' | 'openclaw' | 'hermes' | 'ollama';

export interface CouncilMember {
  model: string;
  provider: string;
  ok: boolean;
  latencyMs: number;
}

// ── Control del PC ───────────────────────────────────────────────────────────
export interface PcAgentResult {
  text: string;
  executed: Array<{ tool: string; input: string; ok: boolean; output?: string }>;
  pending: Array<{ command: string; reason?: string }>;
}
export interface PcRunResult {
  executed: boolean;
  level: 'safe' | 'confirm' | 'blocked';
  reason?: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  needsConfirmation?: boolean;
}

export async function pcStatus(): Promise<{ enabled: boolean; platform: string }> {
  try {
    return await api('/api/pc/status');
  } catch {
    return { enabled: false, platform: '' };
  }
}
export async function pcAgentRun(instruction: string): Promise<PcAgentResult> {
  return api('/api/pc/agent', { method: 'POST', body: JSON.stringify({ instruction }) });
}
export async function pcRun(command: string, confirmed = false): Promise<PcRunResult> {
  return api('/api/pc/run', { method: 'POST', body: JSON.stringify({ command, confirmed }) });
}

/** Sube un archivo (base64) y devuelve su texto extraído (docx/xlsx/pdf/txt…). */
export async function readUpload(filename: string, data: string): Promise<{ text?: string; kind?: string; error?: string }> {
  return api('/api/docs/read-upload', { method: 'POST', body: JSON.stringify({ filename, data }) });
}

// ── Workspace de artefactos + Briefing ───────────────────────────────────────
export interface Artifact { name: string; path: string; kind: string; bytes: number; modified: string }
export async function listArtifacts(): Promise<{ artifacts: Artifact[] }> {
  return api('/api/docs/list');
}
export async function openArtifact(path: string): Promise<{ executed: boolean }> {
  return api('/api/docs/open', { method: 'POST', body: JSON.stringify({ path }) });
}
export async function getBriefing(): Promise<{ text: string; citations: Citation[]; generatedAt: string; error?: string }> {
  return api('/api/assistant/briefing');
}

// ── Deshacer · Rutinas · Índice de disco ─────────────────────────────────────
export interface UndoEntry { id: string; kind: string; path: string; label: string; ts: string }
export async function listUndo(): Promise<{ actions: UndoEntry[] }> { return api('/api/pc/undo-list'); }
export async function doUndo(id: string): Promise<{ ok: boolean; reason?: string; path?: string }> {
  return api('/api/pc/undo', { method: 'POST', body: JSON.stringify({ id }) });
}

export interface Routine { id: string; name: string; instruction: string; everyMinutes?: number; lastRun?: string }
export async function listRoutines(): Promise<{ routines: Routine[] }> { return api('/api/routines'); }
export async function createRoutine(name: string, instruction: string, everyMinutes?: number): Promise<Routine> {
  return api('/api/routines', { method: 'POST', body: JSON.stringify({ name, instruction, everyMinutes }) });
}
export async function deleteRoutine(id: string): Promise<{ deleted: boolean }> {
  return api(`/api/routines/${id}`, { method: 'DELETE' });
}
export async function runRoutine(id: string): Promise<{ text: string; error?: string }> {
  return api(`/api/routines/${id}/run`, { method: 'POST' });
}

export interface DiskHit { path: string; name: string; snippet: string; score: number }
export async function diskStatus(): Promise<{ files: number; enabled: boolean }> { return api('/api/disk/status'); }
export async function diskIndex(folder: string): Promise<{ ok: boolean; indexed: number; scanned: number; error?: string }> {
  return api('/api/disk/index', { method: 'POST', body: JSON.stringify({ folder }) });
}
export async function diskSearch(q: string): Promise<{ hits: DiskHit[] }> {
  return api(`/api/disk/search?q=${encodeURIComponent(q)}`);
}

export async function streamAssistant(
  question: string,
  conversationId: string | null,
  handlers: {
    onMeta: (meta: {
      department: { code: string; specialty: string };
      recalledMemories: number;
      grounded: boolean;
    }) => void;
    onStatus: (text: string) => void;
    onDelta: (text: string) => void;
    onCouncil?: (members: CouncilMember[]) => void;
    onDone: (fin: {
      relevance: string;
      memoryId: string | null;
      created: boolean;
      citations: Citation[];
      model?: string;
    }) => void;
    onError: (message: string) => void;
  },
  opts: { voice?: boolean; mode?: ReasoningMode; images?: Array<{ mediaType: string; data: string }>; attached?: boolean } = {},
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/assistant/ask/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      question,
      conversationId: conversationId ?? undefined,
      voice: opts.voice === true ? true : undefined,
      mode: opts.mode,
      images: opts.images?.length ? opts.images : undefined,
      attached: opts.attached === true ? true : undefined,
    }),
  });
  if (!res.ok || !res.body) {
    handlers.onError(`Error ${res.status}`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const ev = JSON.parse(line.slice(6)) as {
          meta?: { department: { code: string; specialty: string }; recalledMemories: number; grounded: boolean };
          status?: string;
          delta?: string;
          council?: CouncilMember[];
          done?: boolean;
          relevance?: string;
          memoryId?: string | null;
          created?: boolean;
          citations?: Citation[];
          model?: string;
          error?: string;
        };
        if (ev.error) handlers.onError(ev.error);
        else if (ev.meta) handlers.onMeta(ev.meta);
        else if (ev.status) handlers.onStatus(ev.status);
        else if (ev.council) handlers.onCouncil?.(ev.council);
        else if (ev.delta) handlers.onDelta(ev.delta);
        else if (ev.done)
          handlers.onDone({
            relevance: ev.relevance ?? 'relevante',
            memoryId: ev.memoryId ?? null,
            created: Boolean(ev.created),
            citations: ev.citations ?? [],
            model: ev.model,
          });
      } catch {
        // línea parcial
      }
    }
  }
}

/** Chat con GENESUS vía SSE (el server hace stream desde Anthropic). */
export async function streamGenesusChat(
  message: string,
  onDelta: (text: string) => void,
  onDone: (summary: { costUsd?: number }) => void,
  onError: (message: string) => void,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/genesus/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ message }),
  });
  if (!res.ok || !res.body) {
    onError(`Error ${res.status} al conectar con GENESUS`);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6)) as {
          delta?: string;
          done?: boolean;
          costUsd?: number;
          error?: string;
        };
        if (event.error) onError(event.error);
        else if (event.delta) onDelta(event.delta);
        else if (event.done) onDone({ costUsd: event.costUsd });
      } catch {
        // línea parcial
      }
    }
  }
}
