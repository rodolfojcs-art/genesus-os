import { env } from './env.js';

/**
 * Gateway multi-modelo de GENESUS.
 *
 * Un mismo identificador de modelo puede apuntar a varios cerebros según su prefijo:
 *   - claude-... / (sin prefijo)  → Anthropic (Claude Opus/Sonnet/Haiku)
 *   - ollama:NOMBRE               → Ollama local (offline, $0)
 *   - openai:NOMBRE / gpt-...     → OpenAI
 *   - codex:NOMBRE                → OpenAI (orientado a código)
 *   - openclaw:NOMBRE             → OpenCLAW u otro runtime compatible-OpenAI
 *
 * Cada proveedor expone el mismo contrato (chat + stream) para que el resto del
 * sistema no sepa con qué cerebro está hablando. Esto es lo que vuelve a GENESUS
 * multi-cerebro y resiliente: si uno falla o se queda sin presupuesto, otro responde.
 */

export type Provider = 'anthropic' | 'ollama' | 'openai' | 'codex' | 'grok' | 'gemini' | 'groq' | 'openclaw' | 'hermes';

/** Registro de cerebros compatibles-OpenAI (todos hablan el mismo dialecto /chat/completions). */
interface OaiCompatSpec {
  label: string;
  base: () => string;
  key: () => string | undefined;
  defaultModel: () => string;
  cost: 'pago' | 'gratis';
}

export const OAI_COMPAT: Record<Exclude<Provider, 'anthropic' | 'ollama'>, OaiCompatSpec> = {
  openai: {
    label: 'OpenAI',
    base: () => 'https://api.openai.com/v1',
    key: () => env.OPENAI_API_KEY ?? env.OPENAI_EMBEDDINGS_KEY,
    defaultModel: () => env.GENESUS_MODEL_OPENAI ?? 'gpt-4o-mini',
    cost: 'pago',
  },
  codex: {
    label: 'Codex (OpenAI · código)',
    base: () => 'https://api.openai.com/v1',
    key: () => env.OPENAI_API_KEY ?? env.OPENAI_EMBEDDINGS_KEY,
    defaultModel: () => env.GENESUS_MODEL_CODEX ?? 'gpt-4o',
    cost: 'pago',
  },
  grok: {
    label: 'Grok (xAI)',
    base: () => 'https://api.x.ai/v1',
    key: () => env.XAI_API_KEY,
    defaultModel: () => env.XAI_MODEL ?? 'grok-2-latest',
    cost: 'pago',
  },
  gemini: {
    label: 'Gemini (Google)',
    base: () => 'https://generativelanguage.googleapis.com/v1beta/openai',
    key: () => env.GEMINI_API_KEY,
    defaultModel: () => env.GEMINI_MODEL ?? 'gemini-2.0-flash',
    cost: 'gratis',
  },
  groq: {
    label: 'Meta Llama (Groq)',
    base: () => 'https://api.groq.com/openai/v1',
    key: () => env.GROQ_API_KEY,
    defaultModel: () => env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
    cost: 'gratis',
  },
  openclaw: {
    label: 'OpenCLAW',
    base: () => (env.OPENCLAW_URL ?? '').replace(/\/$/, ''),
    // OpenCLAW es un agente, no un modelo: solo cuenta como cerebro si expone un
    // endpoint de chat REAL (URL propia, no el Ollama local que ya tenemos).
    key: () => (env.OPENCLAW_URL && !env.OPENCLAW_URL.includes('11434')) ? (env.OPENCLAW_TOKEN ?? 'openclaw') : undefined,
    defaultModel: () => env.OPENCLAW_MODEL ?? 'default',
    cost: 'gratis',
  },
  hermes: {
    label: 'Hermes (local)',
    // Hermes corre local en Ollama (modelo hermes3). Si defines HERMES_API_KEY,
    // usa OpenRouter en la nube en su lugar.
    base: () => (env.HERMES_API_KEY ? 'https://openrouter.ai/api/v1' : `${env.OLLAMA_URL}/v1`),
    key: () => env.HERMES_API_KEY || 'ollama',
    defaultModel: () => env.HERMES_MODEL || 'hermes3',
    cost: 'gratis',
  },
};

export interface ParsedModel {
  provider: Provider;
  /** Nombre del modelo tal como lo espera el proveedor (sin prefijo). */
  name: string;
}

export function parseModel(model: string): ParsedModel {
  if (model.startsWith('ollama:') || model.startsWith('local:')) {
    return { provider: 'ollama', name: model.split(':').slice(1).join(':') || env.OLLAMA_MODEL };
  }
  // Prefijos explícitos de proveedores compatibles-OpenAI.
  for (const p of ['openclaw', 'codex', 'grok', 'gemini', 'groq', 'hermes', 'openai'] as const) {
    const pre = `${p}:`;
    if (model.startsWith(pre)) {
      return { provider: p, name: model.slice(pre.length) || OAI_COMPAT[p].defaultModel() };
    }
  }
  if (model.startsWith('meta:')) {
    return { provider: 'groq', name: model.slice('meta:'.length) || OAI_COMPAT.groq.defaultModel() };
  }
  if (model.startsWith('gpt')) return { provider: 'openai', name: model };
  return { provider: 'anthropic', name: model };
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export interface StreamResult {
  tokensIn: number;
  tokensOut: number;
}

/** Imagen para razonamiento multimodal (base64 sin el prefijo data:). */
export interface ImageInput {
  mediaType: string; // image/png, image/jpeg, image/webp, image/gif
  data: string; // base64 puro
}

/** Construye el contenido del último mensaje de usuario con imágenes (formato Anthropic). */
function anthropicUserContent(prompt: string, images?: ImageInput[]): unknown {
  if (!images?.length) return prompt;
  return [
    ...images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    })),
    { type: 'text', text: prompt },
  ];
}

// ── Disponibilidad ──────────────────────────────────────────────────────────

const ollamaReachable: { checked: number; ok: boolean } = { checked: 0, ok: false };

/** ¿Está Ollama vivo? Cacheado 30 s para no golpear el endpoint en cada turno. */
export async function ollamaAvailable(): Promise<boolean> {
  const now = Date.now();
  if (now - ollamaReachable.checked < 30_000) return ollamaReachable.ok;
  try {
    const res = await fetch(`${env.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    ollamaReachable.ok = res.ok;
  } catch {
    ollamaReachable.ok = false;
  }
  ollamaReachable.checked = now;
  return ollamaReachable.ok;
}

export function providerConfigured(p: Provider): boolean {
  if (p === 'anthropic') return Boolean(env.ANTHROPIC_API_KEY);
  if (p === 'ollama') return true; // se valida en vivo con ollamaAvailable()
  return Boolean(OAI_COMPAT[p].key());
}

// ── Anthropic ────────────────────────────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

async function anthropicChat(
  model: string,
  system: string,
  prompt: string,
  maxTokens: number,
  history: ChatTurn[],
): Promise<ChatResult> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY!,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [...history, { role: 'user', content: prompt }],
    }),
  });
  const body = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: AnthropicUsage;
    error?: { message: string };
  };
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? 'error'}`);
  const text = (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  return { text, tokensIn: body.usage?.input_tokens ?? 0, tokensOut: body.usage?.output_tokens ?? 0 };
}

async function anthropicStream(
  model: string,
  system: string,
  prompt: string,
  maxTokens: number,
  history: ChatTurn[],
  onChunk: (t: string) => void,
  images?: ImageInput[],
): Promise<StreamResult> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY!,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      system,
      messages: [...history, { role: 'user', content: anthropicUserContent(prompt, images) }],
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  let tokensIn = 0;
  let tokensOut = 0;
  await readSse(res.body, (payload) => {
    const event = JSON.parse(payload) as {
      type: string;
      message?: { usage?: AnthropicUsage };
      delta?: { type?: string; text?: string };
      usage?: AnthropicUsage;
    };
    if (event.type === 'message_start') tokensIn = event.message?.usage?.input_tokens ?? 0;
    else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') onChunk(event.delta.text ?? '');
    else if (event.type === 'message_delta') tokensOut = event.usage?.output_tokens ?? tokensOut;
  });
  return { tokensIn, tokensOut };
}

// ── Ollama (local, $0) ───────────────────────────────────────────────────────

interface OllamaResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done?: boolean;
}

function ollamaMessages(system: string, prompt: string, history: ChatTurn[]) {
  return [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...history,
    { role: 'user', content: prompt },
  ];
}

// En CPU, generar miles de tokens es lento; topamos para equilibrar agilidad y
// no cortar respuestas. (La nube usa GENESUS_MAX_TOKENS, mucho más alto.)
const OLLAMA_MAX_PREDICT = 2048;
// Mantener el modelo en memoria entre turnos evita la recarga en frío (~50 s).
const OLLAMA_KEEP_ALIVE = '30m';

function ollamaOptions(maxTokens: number) {
  return { num_predict: Math.min(maxTokens, OLLAMA_MAX_PREDICT) };
}

async function ollamaChat(
  name: string,
  system: string,
  prompt: string,
  maxTokens: number,
  history: ChatTurn[],
): Promise<ChatResult> {
  const res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: name,
      messages: ollamaMessages(system, prompt, history),
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: ollamaOptions(maxTokens),
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as OllamaResponse;
  return {
    text: body.message?.content ?? '',
    tokensIn: body.prompt_eval_count ?? 0,
    tokensOut: body.eval_count ?? 0,
  };
}

async function ollamaStream(
  name: string,
  system: string,
  prompt: string,
  maxTokens: number,
  history: ChatTurn[],
  onChunk: (t: string) => void,
): Promise<StreamResult> {
  const res = await fetch(`${env.OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: name,
      messages: ollamaMessages(system, prompt, history),
      stream: true,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: ollamaOptions(maxTokens),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let tokensIn = 0;
  let tokensOut = 0;
  // Ollama emite NDJSON (un objeto JSON por línea), no SSE.
  await readNdjson(res.body, (line) => {
    const ev = JSON.parse(line) as OllamaResponse;
    if (ev.message?.content) onChunk(ev.message.content);
    if (ev.prompt_eval_count) tokensIn = ev.prompt_eval_count;
    if (ev.eval_count) tokensOut = ev.eval_count;
  });
  return { tokensIn, tokensOut };
}

// ── OpenAI-compatible (OpenAI / Codex / OpenCLAW) ────────────────────────────

type OaiProvider = Exclude<Provider, 'anthropic' | 'ollama'>;

function openAiCompatConfig(provider: OaiProvider): { base: string; key: string } {
  const spec = OAI_COMPAT[provider];
  return { base: spec.base(), key: spec.key() ?? '' };
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

function openAiUserContent(prompt: string, images?: ImageInput[]): unknown {
  if (!images?.length) return prompt;
  return [
    { type: 'text', text: prompt },
    ...images.map((img) => ({
      type: 'image_url',
      image_url: { url: `data:${img.mediaType};base64,${img.data}` },
    })),
  ];
}

function openAiMessages(system: string, prompt: string, history: ChatTurn[], images?: ImageInput[]) {
  return [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...history,
    { role: 'user', content: openAiUserContent(prompt, images) },
  ];
}

async function openAiChat(
  provider: OaiProvider,
  name: string,
  system: string,
  prompt: string,
  maxTokens: number,
  history: ChatTurn[],
): Promise<ChatResult> {
  const { base, key } = openAiCompatConfig(provider);
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: name,
      max_tokens: maxTokens,
      messages: openAiMessages(system, prompt, history),
    }),
  });
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: OpenAiUsage;
    error?: { message: string };
  };
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${body.error?.message ?? 'error'}`);
  return {
    text: body.choices?.[0]?.message?.content ?? '',
    tokensIn: body.usage?.prompt_tokens ?? 0,
    tokensOut: body.usage?.completion_tokens ?? 0,
  };
}

async function openAiStream(
  provider: OaiProvider,
  name: string,
  system: string,
  prompt: string,
  maxTokens: number,
  history: ChatTurn[],
  onChunk: (t: string) => void,
  images?: ImageInput[],
): Promise<StreamResult> {
  const { base, key } = openAiCompatConfig(provider);
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: name,
      max_tokens: maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      messages: openAiMessages(system, prompt, history, images),
    }),
  });
  if (!res.ok || !res.body) throw new Error(`${provider} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let tokensIn = 0;
  let tokensOut = 0;
  await readSse(res.body, (payload) => {
    if (payload === '[DONE]') return;
    const ev = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string } }>;
      usage?: OpenAiUsage;
    };
    const delta = ev.choices?.[0]?.delta?.content;
    if (delta) onChunk(delta);
    if (ev.usage) {
      tokensIn = ev.usage.prompt_tokens ?? tokensIn;
      tokensOut = ev.usage.completion_tokens ?? tokensOut;
    }
  });
  return { tokensIn, tokensOut };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export async function providerChat(
  model: string,
  system: string,
  prompt: string,
  maxTokens: number,
  history: ChatTurn[] = [],
): Promise<ChatResult> {
  const { provider, name } = parseModel(model);
  if (provider === 'anthropic') return anthropicChat(name, system, prompt, maxTokens, history);
  if (provider === 'ollama') return ollamaChat(name, system, prompt, maxTokens, history);
  return openAiChat(provider, name, system, prompt, maxTokens, history);
}

export async function providerStream(
  model: string,
  system: string,
  prompt: string,
  maxTokens: number,
  history: ChatTurn[],
  onChunk: (t: string) => void,
  images?: ImageInput[],
): Promise<StreamResult> {
  const { provider, name } = parseModel(model);
  if (provider === 'anthropic') return anthropicStream(name, system, prompt, maxTokens, history, onChunk, images);
  if (provider === 'ollama') return ollamaStream(name, system, prompt, maxTokens, history, onChunk);
  return openAiStream(provider, name, system, prompt, maxTokens, history, onChunk, images);
}

// ── Helpers de stream ────────────────────────────────────────────────────────

/** Lee un cuerpo SSE (líneas `data: ...`) y entrega cada payload crudo. */
async function readSse(body: ReadableStream<Uint8Array>, onPayload: (payload: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(line.indexOf(':') + 1).trim();
      if (!payload) continue;
      try {
        onPayload(payload);
      } catch {
        /* línea parcial */
      }
    }
  }
}

/** Lee un cuerpo NDJSON (un objeto JSON por línea) — formato de stream de Ollama. */
async function readNdjson(body: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onLine(trimmed);
      } catch {
        /* línea parcial */
      }
    }
  }
}
