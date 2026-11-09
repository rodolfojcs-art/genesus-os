import {
  estimateCostUsd,
  resolveModel,
  type LlmCaller,
  type LlmRequest,
  type LlmResponse,
  type ModelTier,
  type Run,
} from '@genesus/core';
import { env, hasAnthropic, modelOverrides } from './env.js';
import { supabase } from './supabase.js';
import type { BudgetGateway } from './budget.js';
import {
  providerChat,
  providerStream,
  parseModel,
  providerConfigured,
  ollamaAvailable,
  OAI_COMPAT,
  type ChatTurn,
  type Provider,
  type ImageInput,
} from './providers.js';

export type { ChatTurn } from './providers.js';

/** Modos de razonamiento: 4 estrategias + selección directa de un cerebro específico. */
export type ReasoningMode =
  | 'cloud' | 'local' | 'auto' | 'council'
  | 'anthropic' | 'openai' | 'codex' | 'grok' | 'gemini' | 'groq' | 'openclaw' | 'hermes' | 'ollama';

const BRAIN_KEYS = new Set<string>([
  'anthropic', 'openai', 'codex', 'grok', 'gemini', 'groq', 'openclaw', 'hermes', 'ollama',
]);

export class BudgetCutoffError extends Error {
  constructor(remaining: number) {
    super(`Presupuesto diario agotado (restante: $${remaining.toFixed(4)})`);
    this.name = 'BudgetCutoffError';
  }
}

/** Buffer en memoria de runs (espejo para /api/costos cuando no hay Supabase). */
export const recentRuns: Run[] = [];

async function logRun(run: Omit<Run, 'id' | 'createdAt'>): Promise<void> {
  const full: Run = {
    ...run,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  recentRuns.push(full);
  if (recentRuns.length > 2000) recentRuns.splice(0, recentRuns.length - 2000);

  const sb = supabase();
  if (sb) {
    const { error } = await sb.from('runs').insert({
      task_id: run.taskId,
      model: run.model,
      tokens_in: run.tokensIn,
      tokens_out: run.tokensOut,
      cost_usd: run.costUsd,
      latency_ms: run.latencyMs,
    });
    if (error) console.error(`[runs] error registrando llamada: ${error.message}`);
  }
}

/**
 * Elige el cerebro (modelo+proveedor) para un tier según el modo de razonamiento
 * y la disponibilidad real. Esta función es la que vuelve a GENESUS multi-cerebro:
 *  - cloud  → Claude (o el override configurado).
 *  - local  → Ollama (offline, $0).
 *  - auto   → Claude si hay llave; si no, Ollama local.
 *  - council→ base Claude (la deliberación multi-modelo se maneja aparte).
 */
export async function pickModel(tier: ModelTier, mode: ReasoningMode = env.GENESUS_REASONING_MODE): Promise<string> {
  const cloud = resolveModel(tier, modelOverrides);
  const localModel = `ollama:${env.OLLAMA_MODEL}`;

  // Selección directa de un cerebro específico (Grok, Gemini, GPT, etc.).
  if (BRAIN_KEYS.has(mode)) {
    if (mode === 'anthropic') return cloud;
    if (mode === 'ollama') return localModel;
    return `${mode}:${OAI_COMPAT[mode as Exclude<Provider, 'anthropic' | 'ollama'>].defaultModel()}`;
  }

  if (mode === 'local') return localModel;
  if (mode === 'cloud') return cloud;

  // auto / council: usa TODOS los cerebros — cadena de prioridad con respaldo.
  // Claude → OpenAI → Grok → Gemini → Llama(Groq) → Ollama local.
  if (hasAnthropic) return cloud;
  for (const p of ['openai', 'grok', 'gemini', 'groq'] as const) {
    if (providerConfigured(p)) return `${p}:${OAI_COMPAT[p].defaultModel()}`;
  }
  if (await ollamaAvailable()) return localModel;
  return cloud; // último recurso: dejará un error de configuración claro
}

/** Respuesta simulada determinista — SOLO con SIMULATE_LLM=1, costo $0, marcada. */
function simulatedResponse(req: LlmRequest, model: string): LlmResponse {
  const text =
    req.tier === 'opus' && req.prompt.includes('MISIÓN DEL USUARIO')
      ? JSON.stringify({
          mission_title: 'Misión simulada (sin API key)',
          summary:
            'Plan generado por el simulador local. Configura ANTHROPIC_API_KEY para ejecución real.',
          tasks: [
            {
              id: 't1',
              department_id: 'DSGN-001',
              title: 'Borrador simulado',
              objective: 'Demostrar el pipeline sin costo',
              deliverable: 'Texto simulado',
              depends_on: [],
              model_tier: 'sonnet',
              est_cost_usd: 0,
            },
          ],
          est_total_cost_usd: 0,
        })
      : `[SIMULADO · ${model}] Respuesta de prueba sin API key. Prompt recibido (${req.prompt.length} caracteres).`;
  return { text, model: `${model} (simulado)`, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 1 };
}

/** ¿Podemos razonar de algún modo (algún proveedor disponible o simulación)? */
async function canReason(): Promise<boolean> {
  if (env.SIMULATE_LLM) return true;
  if (hasAnthropic || providerConfigured('openai') || providerConfigured('openclaw')) return true;
  return ollamaAvailable();
}

/**
 * LlmCaller con guardarraíles: pre-chequeo de presupuesto con estimación,
 * consumo del costo real post-llamada, logging en `runs` y respaldo a Ollama.
 */
export function createLlmCaller(budget: BudgetGateway): LlmCaller {
  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const maxTokens = req.maxTokens ?? 4000;
      let model = await pickModel(req.tier);

      if (!(await canReason())) {
        if (env.SIMULATE_LLM) return simulatedResponse(req, model);
        throw new Error(
          'Ningún cerebro disponible. Configura ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENCLAW_URL o levanta Ollama (o usa SIMULATE_LLM=1).',
        );
      }

      // Pre-chequeo: estimación pesimista (prompt/4 chars por token + salida máxima)
      const estTokensIn = Math.ceil((req.system.length + req.prompt.length) / 4);
      const estCost = estimateCostUsd(model, estTokensIn, maxTokens);
      const remaining = await budget.remaining();
      if (estCost > remaining) {
        // Sin presupuesto en la nube: si Ollama está vivo, razona local gratis.
        if (parseModel(model).provider !== 'ollama' && (await ollamaAvailable())) {
          model = `ollama:${env.OLLAMA_MODEL}`;
        } else {
          throw new BudgetCutoffError(remaining);
        }
      }

      const t0 = Date.now();
      let result: { text: string; tokensIn: number; tokensOut: number };
      try {
        result = await providerChat(model, req.system, req.prompt, maxTokens, []);
      } catch (err) {
        // Respaldo: si falla un cerebro en la nube y hay Ollama, reintenta local.
        if (parseModel(model).provider !== 'ollama' && (await ollamaAvailable())) {
          model = `ollama:${env.OLLAMA_MODEL}`;
          result = await providerChat(model, req.system, req.prompt, maxTokens, []);
        } else {
          throw err;
        }
      }
      const latencyMs = Date.now() - t0;
      const costUsd = estimateCostUsd(model, result.tokensIn, result.tokensOut);

      const consumed = await budget.consume(costUsd);
      await logRun({
        taskId: req.taskId ?? null,
        model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd,
        latencyMs,
      });
      if (!consumed.allowed) {
        throw new BudgetCutoffError(consumed.remaining);
      }

      return { text: result.text, model, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd, latencyMs };
    },
  };
}

export interface StreamHandlers {
  onChunk: (text: string) => void;
  onDone: (summary: { tokensIn: number; tokensOut: number; costUsd: number; model: string }) => void;
}

/**
 * Streaming para el chat de GENESUS. Reenvía deltas de texto y al final
 * registra el run + consume presupuesto con el uso real reportado por el cerebro.
 * Honra el modo de razonamiento (cloud/local/auto) y respalda en Ollama.
 */
export async function streamCompletion(
  budget: BudgetGateway,
  tier: ModelTier,
  system: string,
  prompt: string,
  handlers: StreamHandlers,
  maxTokens = 4000,
  history: ChatTurn[] = [],
  mode: ReasoningMode = env.GENESUS_REASONING_MODE,
  images?: ImageInput[],
): Promise<void> {
  let model = await pickModel(tier, mode);

  // Visión: si hay imágenes, usa un cerebro con visión (Claude; si no, Gemini).
  if (images?.length) {
    if (hasAnthropic) model = resolveModel('sonnet', modelOverrides);
    else if (providerConfigured('gemini')) model = `gemini:${OAI_COMPAT.gemini.defaultModel()}`;
  }

  if (!(await canReason())) {
    if (env.SIMULATE_LLM) {
      const sim = simulatedResponse({ tier, system, prompt }, model);
      handlers.onChunk(sim.text);
      handlers.onDone({ tokensIn: 0, tokensOut: 0, costUsd: 0, model: sim.model });
      return;
    }
    throw new Error('Ningún cerebro de razonamiento disponible (Claude/OpenAI/OpenCLAW/Ollama).');
  }

  const hasImages = Boolean(images?.length);
  const histChars = history.reduce((s, h) => s + h.content.length, 0);
  const estCost = estimateCostUsd(model, Math.ceil((system.length + prompt.length + histChars) / 4), maxTokens);
  const remaining = await budget.remaining();
  if (estCost > remaining) {
    // Con imágenes no caemos a Ollama (no tiene visión): respetamos el límite.
    if (!hasImages && parseModel(model).provider !== 'ollama' && (await ollamaAvailable())) {
      model = `ollama:${env.OLLAMA_MODEL}`;
    } else {
      throw new BudgetCutoffError(remaining);
    }
  }

  const t0 = Date.now();
  let received = false;
  const onChunk = (t: string) => {
    received = true;
    handlers.onChunk(t);
  };

  let usage: { tokensIn: number; tokensOut: number };
  try {
    usage = await providerStream(model, system, prompt, maxTokens, history, onChunk, images);
  } catch (err) {
    // Respaldo a Ollama SOLO si no hay imágenes y aún no se emitió texto.
    if (!hasImages && !received && parseModel(model).provider !== 'ollama' && (await ollamaAvailable())) {
      model = `ollama:${env.OLLAMA_MODEL}`;
      usage = await providerStream(model, system, prompt, maxTokens, history, onChunk);
    } else {
      throw err;
    }
  }

  const costUsd = estimateCostUsd(model, usage.tokensIn, usage.tokensOut);
  await budget.consume(costUsd);
  await logRun({
    taskId: null,
    model,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    costUsd,
    latencyMs: Date.now() - t0,
  });
  handlers.onDone({ tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd, model });
}

export interface CouncilMember {
  model: string;
  provider: string;
  ok: boolean;
  latencyMs: number;
}

export interface CouncilResult {
  text: string;
  model: string;
  members: CouncilMember[];
}

/**
 * Concilio multi-cerebro: varios modelos disponibles responden la MISMA pregunta
 * en paralelo y luego un sintetizador (Claude si hay, si no el más capaz vivo)
 * funde lo mejor de cada uno en una sola respuesta. Esta es la forma legítima y
 * sólida de "el modelo más potente": no se quitan salvaguardas, se SUMAN cerebros.
 */
export async function councilCompletion(
  budget: BudgetGateway,
  system: string,
  prompt: string,
  history: ChatTurn[] = [],
  maxTokens = 2400,
): Promise<CouncilResult> {
  // 1. Reunir todos los cerebros disponibles (cada proveedor configurado aporta uno).
  const candidates: string[] = [];
  if (hasAnthropic) candidates.push(resolveModel('sonnet', modelOverrides));
  for (const p of Object.keys(OAI_COMPAT) as Array<Exclude<Provider, 'anthropic' | 'ollama'>>) {
    if (providerConfigured(p)) candidates.push(`${p}:${OAI_COMPAT[p].defaultModel()}`);
  }
  if (await ollamaAvailable()) candidates.push(`ollama:${env.OLLAMA_MODEL}`);

  // Si solo hay un cerebro, no hay concilio: responde directo.
  if (candidates.length <= 1) {
    const only = candidates[0] ?? (await pickModel('sonnet'));
    const r = await providerChat(only, system, prompt, maxTokens, history);
    const cost = estimateCostUsd(only, r.tokensIn, r.tokensOut);
    await budget.consume(cost);
    await logRun({ taskId: null, model: only, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: cost, latencyMs: 0 });
    return { text: r.text, model: only, members: [{ model: only, provider: parseModel(only).provider, ok: true, latencyMs: 0 }] };
  }

  // 2. Cada cerebro responde en paralelo, con timeout para que uno lento
  //    (p.ej. un modelo local pesado en CPU) no congele al concilio entero.
  const COUNCIL_TIMEOUT_MS = 25000;
  const members: CouncilMember[] = [];
  const drafts: Array<{ model: string; text: string }> = [];
  await Promise.all(
    candidates.map(async (m) => {
      const t0 = Date.now();
      try {
        const r = await Promise.race([
          providerChat(m, system, prompt, maxTokens, history),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), COUNCIL_TIMEOUT_MS)),
        ]);
        const latency = Date.now() - t0;
        const cost = estimateCostUsd(m, r.tokensIn, r.tokensOut);
        await budget.consume(cost);
        await logRun({ taskId: null, model: m, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: cost, latencyMs: latency });
        if (r.text.trim()) drafts.push({ model: m, text: r.text });
        members.push({ model: m, provider: parseModel(m).provider, ok: Boolean(r.text.trim()), latencyMs: latency });
      } catch {
        members.push({ model: m, provider: parseModel(m).provider, ok: false, latencyMs: Date.now() - t0 });
      }
    }),
  );

  if (drafts.length === 0) throw new Error('Ningún cerebro del concilio respondió.');
  if (drafts.length === 1) return { text: drafts[0]!.text, model: drafts[0]!.model, members };

  // 3. JUEZ: los cerebros se evalúan entre sí y se entrega la mejor respuesta.
  const synthModel = hasAnthropic ? resolveModel('opus', modelOverrides) : drafts[0]!.model;
  const synthSystem =
    'Eres el JUEZ de un concilio de IAs. Recibiste varias respuestas independientes a la misma pregunta. ' +
    'Tu trabajo: (1) evalúa cada respuesta frente a las demás por exactitud, completitud y evidencia, ' +
    'detectando errores, contradicciones o afirmaciones sin respaldo; (2) descarta lo débil o falso; ' +
    '(3) combina lo mejor y más verificable en UNA sola respuesta final superior. Nunca inventes. ' +
    'Responde SOLO con la respuesta final en español, sin mostrar tu evaluación ni meta-comentarios.';
  const synthPrompt =
    `PREGUNTA:\n${prompt}\n\nRESPUESTAS DEL CONCILIO (evalúalas entre sí):\n` +
    drafts.map((d, i) => `── CEREBRO ${i + 1} (${d.model}) ──\n${d.text}`).join('\n\n') +
    '\n\nEvalúa unas respuestas contra otras y entrega la MEJOR respuesta final combinada.';
  const t0 = Date.now();
  const synth = await providerChat(synthModel, synthSystem, synthPrompt, maxTokens, []);
  const cost = estimateCostUsd(synthModel, synth.tokensIn, synth.tokensOut);
  await budget.consume(cost);
  await logRun({ taskId: null, model: synthModel, tokensIn: synth.tokensIn, tokensOut: synth.tokensOut, costUsd: cost, latencyMs: Date.now() - t0 });

  return { text: synth.text, model: `${synthModel} (concilio de ${drafts.length})`, members };
}

/** Inventario de cerebros para la UI: qué proveedores hay, su modelo y si están vivos. */
export async function brainInventory(): Promise<{
  mode: ReasoningMode;
  brains: Array<{ provider: string; label: string; model: string; available: boolean; cost: 'pago' | 'gratis' }>;
}> {
  const ollama = await ollamaAvailable();
  const brains: Array<{ provider: string; label: string; model: string; available: boolean; cost: 'pago' | 'gratis' }> = [
    { provider: 'anthropic', label: 'Claude (Anthropic)', model: resolveModel('opus', modelOverrides), available: hasAnthropic, cost: 'pago' },
  ];
  for (const p of Object.keys(OAI_COMPAT) as Array<Exclude<Provider, 'anthropic' | 'ollama'>>) {
    const spec = OAI_COMPAT[p];
    brains.push({ provider: p, label: spec.label, model: spec.defaultModel(), available: providerConfigured(p), cost: spec.cost });
  }
  brains.push({ provider: 'ollama', label: 'Ollama (local)', model: env.OLLAMA_MODEL, available: ollama, cost: 'gratis' });
  return { mode: env.GENESUS_REASONING_MODE, brains };
}
