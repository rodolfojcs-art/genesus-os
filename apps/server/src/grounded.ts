import { estimateCostUsd, resolveModel } from '@genesus/core';
import { env, hasAnthropic, modelOverrides } from './env.js';
import type { BudgetGateway } from './budget.js';
import { BudgetCutoffError, recentRuns } from './llm.js';
import { supabase } from './supabase.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Respuesta "grounded" anti-alucinación: el modelo puede BUSCAR EN LA WEB
 * (datos reales y actuales, con citas) y EJECUTAR CÓDIGO en un sandbox real,
 * usando las herramientas de servidor de Anthropic. Corrige las debilidades de
 * datos inventados, información obsoleta y "no ejecuto código".
 */

export interface Citation {
  title: string;
  url: string;
}

export interface GroundedResult {
  text: string;
  citations: Citation[];
  model: string;
  costUsd: number;
  usedWebSearch: boolean;
  usedCode: boolean;
}

interface ContentBlock {
  type: string;
  text?: string;
  citations?: Array<{ type?: string; url?: string; title?: string }>;
}
interface MsgResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

async function logRun(model: string, tokensIn: number, tokensOut: number, costUsd: number, latencyMs: number) {
  recentRuns.push({
    id: crypto.randomUUID(),
    taskId: null,
    model,
    tokensIn,
    tokensOut,
    costUsd,
    latencyMs,
    createdAt: new Date().toISOString(),
  });
  const sb = supabase();
  if (sb) {
    await sb
      .from('runs')
      .insert({ model, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd, latency_ms: latencyMs })
      .then(({ error }) => {
        if (error) console.error(`[runs] ${error.message}`);
      });
  }
}

export interface GroundedOptions {
  webSearch?: boolean;
  codeExecution?: boolean;
  maxTokens?: number;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Completa con herramientas de servidor. La API ejecuta web search / código en
 * su infraestructura y devuelve la respuesta final ya fundamentada. Maneja
 * `pause_turn` reenviando hasta 3 veces. Lanza si falla (el llamador hace
 * fallback a una respuesta normal).
 */
export async function groundedComplete(
  budget: BudgetGateway,
  system: string,
  prompt: string,
  opts: GroundedOptions = {},
): Promise<GroundedResult> {
  if (!hasAnthropic) throw new Error('grounded requiere ANTHROPIC_API_KEY');
  const model = resolveModel('sonnet', modelOverrides);
  const maxTokens = opts.maxTokens ?? 3000;

  const tools: Array<Record<string, unknown>> = [];
  if (opts.webSearch !== false) tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 4 });
  if (opts.codeExecution) tools.push({ type: 'code_execution_20250825', name: 'code_execution' });

  // Pre-chequeo de presupuesto (con holgura para herramientas)
  const estCost = estimateCostUsd(model, Math.ceil((system.length + prompt.length) / 4) + 4000, maxTokens) + 0.02;
  const remaining = await budget.remaining();
  if (estCost > remaining) throw new BudgetCutoffError(remaining);

  const messages: Array<{ role: string; content: unknown }> = [
    ...(opts.history ?? []),
    { role: 'user', content: prompt },
  ];
  const citations: Citation[] = [];
  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let usedWebSearch = false;
  let usedCode = false;
  const t0 = Date.now();

  for (let i = 0; i < 4; i++) {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY!,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages, tools }),
    });
    const body = (await res.json()) as MsgResponse;
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? 'error'}`);

    tokensIn += body.usage?.input_tokens ?? 0;
    tokensOut += body.usage?.output_tokens ?? 0;

    for (const block of body.content ?? []) {
      if (block.type === 'text') {
        text += block.text ?? '';
        for (const c of block.citations ?? []) {
          if (c.url) citations.push({ title: c.title ?? c.url, url: c.url });
        }
      }
      if (block.type === 'server_tool_use' || block.type === 'web_search_tool_result') usedWebSearch = true;
      if (block.type.includes('code_execution')) usedCode = true;
    }

    if (body.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: body.content });
      continue; // reanudar el loop de herramientas
    }
    break;
  }

  const costUsd = estimateCostUsd(model, tokensIn, tokensOut) + (usedWebSearch ? 0.01 : 0);
  await budget.consume(costUsd);
  await logRun(model, tokensIn, tokensOut, costUsd, Date.now() - t0);

  // Dedup de citas por URL
  const seen = new Set<string>();
  const uniqueCitations = citations.filter((c) => (seen.has(c.url) ? false : seen.add(c.url)));

  return { text, citations: uniqueCitations, model, costUsd, usedWebSearch, usedCode };
}
