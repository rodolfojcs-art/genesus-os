import 'dotenv/config';
import { z } from 'zod';
import type { ModelOverrides } from '@genesus/core';

/**
 * Bandera booleana desde texto. z.coerce.boolean() usa Boolean(string), asi que
 * "0" y "false" daban TRUE — lo contrario de lo escrito en el .env. Esto lee el
 * valor como lo entiende una persona.
 */
const boolFlag = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(def)
    .transform((v) => {
      if (typeof v === "boolean") return v;
      const s = v.trim().toLowerCase();
      if (["1", "true", "yes", "y", "on", "si"].includes(s)) return true;
      if (["0", "false", "no", "n", "off", ""].includes(s)) return false;
      return def;
    });

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default('0.0.0.0'),

  ANTHROPIC_API_KEY: z.string().optional(),
  /** SOLO para desarrollo sin API key: respuestas simuladas, costo 0, marcadas como tales. */
  SIMULATE_LLM: boolFlag(false),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  DATABASE_URL: z.string().optional(),

  BUDGET_DAILY_USD: z.coerce.number().positive().default(25),
  MAX_CONCURRENT_AGENTS: z.coerce.number().int().positive().default(8),
  MAX_RECURSION_DEPTH: z.coerce.number().int().positive().default(3),
  AUTO_APPROVE_UNDER_USD: z.coerce.number().nonnegative().default(0),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),

  N8N_WEBHOOK_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  /** Protege POST /webhook/n8n (entrante): si se define, exige header x-webhook-secret igual a este valor. */
  N8N_INBOUND_SECRET: z.string().optional().or(z.literal('').transform(() => undefined)),
  EVOLUTION_API_URL: z.string().optional(),
  EVOLUTION_API_KEY: z.string().optional(),

  /** Webhook saliente hacia Hermes Agent (notificaciones de vigías por Telegram). */
  HERMES_WEBHOOK_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  HERMES_WEBHOOK_SECRET: z.string().optional().or(z.literal('').transform(() => undefined)),

  /** Bóveda Obsidian: espejo legible de la memoria permanente (bidireccional). */
  OBSIDIAN_VAULT_PATH: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** GBrain — cerebro independiente (RAG híbrido + grafo). Directorio del repo gbrain. */
  GBRAIN_DIR: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** Ruta al binario de Bun (runtime de gbrain). Si falta, se autodetecta. */
  BUN_BIN: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** Embeddings semánticos (OpenAI text-embedding-3-small, 1536 dims). Opcional. */
  OPENAI_EMBEDDINGS_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  /** Llave OpenAI para voz (TTS) y embeddings. Si falta, usa OPENAI_EMBEDDINGS_KEY. */
  OPENAI_API_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),

  GENESUS_MODEL_OPUS: z.string().optional(),
  GENESUS_MODEL_SONNET: z.string().optional(),
  GENESUS_MODEL_HAIKU: z.string().optional(),

  // ── Gateway multi-modelo ────────────────────────────────────────────────
  /** Tope de tokens de SALIDA por respuesta del chat (evita que se corten). */
  GENESUS_MAX_TOKENS: z.coerce.number().int().positive().default(16000),
  /** Modo de razonamiento por defecto: cloud (Claude), local (Ollama), auto (Claude→Ollama), council (varios cerebros + síntesis). */
  GENESUS_REASONING_MODE: z.enum(['cloud', 'local', 'auto', 'council']).default('auto'),
  /** Endpoint de Ollama local (razonamiento offline, $0). */
  OLLAMA_URL: z.string().default('http://localhost:11434'),
  /** Modelo de Ollama para razonamiento (no embeddings). Ej: llama3.1, qwen2.5, gemma2. */
  OLLAMA_MODEL: z.string().default('llama3.1'),
  /** OpenAI como cerebro de razonamiento. Usa OPENAI_API_KEY. */
  GENESUS_MODEL_OPENAI: z.string().optional(),
  /** Codex (OpenAI, orientado a código). Comparte OPENAI_API_KEY. */
  GENESUS_MODEL_CODEX: z.string().optional(),
  /** Grok (xAI) — API compatible-OpenAI en https://api.x.ai/v1. */
  XAI_API_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  XAI_MODEL: z.string().optional(),
  /** Gemini (Google) — endpoint compatible-OpenAI. */
  GEMINI_API_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  GEMINI_MODEL: z.string().optional(),
  /** Meta Llama vía Groq (host gratis y veloz), compatible-OpenAI. */
  GROQ_API_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  GROQ_MODEL: z.string().optional(),
  /** Hermes (Nous Research) vía OpenRouter — compatible-OpenAI. Llave de openrouter.ai. */
  HERMES_API_KEY: z.string().optional().or(z.literal('').transform(() => undefined)),
  HERMES_MODEL: z.string().optional(),
  /** OpenCLAW u otro runtime compatible-OpenAI (base URL /v1). */
  OPENCLAW_URL: z.string().optional().or(z.literal('').transform(() => undefined)),
  OPENCLAW_TOKEN: z.string().optional().or(z.literal('').transform(() => undefined)),
  OPENCLAW_MODEL: z.string().optional(),

  // ── Control del PC (agente de escritorio) ───────────────────────────────
  /** Habilita que GENESUS ejecute acciones en el PC (con salvaguardas). */
  PC_CONTROL_ENABLED: boolFlag(false),
});

export const env = EnvSchema.parse(process.env);

export const modelOverrides: ModelOverrides = {
  ...(env.GENESUS_MODEL_OPUS ? { opus: env.GENESUS_MODEL_OPUS } : {}),
  ...(env.GENESUS_MODEL_SONNET ? { sonnet: env.GENESUS_MODEL_SONNET } : {}),
  ...(env.GENESUS_MODEL_HAIKU ? { haiku: env.GENESUS_MODEL_HAIKU } : {}),
};

export const hasSupabase = Boolean(
  env.SUPABASE_URL && (env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY),
);
export const hasAnthropic = Boolean(env.ANTHROPIC_API_KEY);
