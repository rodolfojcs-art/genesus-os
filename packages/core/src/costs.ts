/**
 * Precios oficiales Anthropic (USD por millón de tokens), vigentes a 2026-06.
 * Fuente: catálogo de modelos de la API de Anthropic.
 */
export interface ModelPricing {
  inputPerMtok: number;
  outputPerMtok: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-fable-5': { inputPerMtok: 10, outputPerMtok: 50 },
  'claude-opus-4-8': { inputPerMtok: 5, outputPerMtok: 25 },
  'claude-opus-4-7': { inputPerMtok: 5, outputPerMtok: 25 },
  'claude-opus-4-6': { inputPerMtok: 5, outputPerMtok: 25 },
  'claude-sonnet-4-6': { inputPerMtok: 3, outputPerMtok: 15 },
  'claude-haiku-4-5': { inputPerMtok: 1, outputPerMtok: 5 },
};

/** Fallback por familia si llega un ID de modelo no listado (ej. snapshot con fecha). */
const FAMILY_FALLBACK: Array<[string, ModelPricing]> = [
  ['fable', { inputPerMtok: 10, outputPerMtok: 50 }],
  ['opus', { inputPerMtok: 5, outputPerMtok: 25 }],
  ['sonnet', { inputPerMtok: 3, outputPerMtok: 15 }],
  ['haiku', { inputPerMtok: 1, outputPerMtok: 5 }],
];

export function priceFor(model: string): ModelPricing {
  const m = model.toLowerCase();
  // Modelos locales/autohospedados y de capa gratuita: sin costo de API.
  if (
    m.startsWith('ollama:') || m.startsWith('local:') || m.startsWith('openclaw:') ||
    m.startsWith('groq:') || m.startsWith('gemini:') || m.startsWith('meta:') ||
    m.includes('gemini') || m.includes('llama')
  ) {
    return { inputPerMtok: 0, outputPerMtok: 0 };
  }
  const exact = MODEL_PRICING[model];
  if (exact) return exact;
  if (m.startsWith('grok') || m.startsWith('grok:')) {
    return { inputPerMtok: 2, outputPerMtok: 10 };
  }
  if (m.startsWith('openai:') || m.startsWith('codex:') || m.startsWith('gpt')) {
    return { inputPerMtok: 2.5, outputPerMtok: 10 };
  }
  for (const [family, pricing] of FAMILY_FALLBACK) {
    if (model.includes(family)) return pricing;
  }
  // Desconocido: asumir el precio más caro para no subestimar el gasto.
  return { inputPerMtok: 5, outputPerMtok: 25 };
}

export function estimateCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const p = priceFor(model);
  const cost = (tokensIn / 1_000_000) * p.inputPerMtok + (tokensOut / 1_000_000) * p.outputPerMtok;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
