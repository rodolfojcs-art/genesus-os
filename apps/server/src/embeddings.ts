import { env } from './env.js';

/**
 * Embeddings semánticos para Genesus BRAIN (opcional).
 * Usa OpenAI text-embedding-3-small (1536 dims — coincide con la columna
 * vector(1536) de brain_memory). Sin llave, la memoria usa FTS léxico.
 */
export function embeddingsEnabled(): boolean {
  return Boolean(env.OPENAI_EMBEDDINGS_KEY);
}

export async function embed(text: string): Promise<number[] | null> {
  if (!env.OPENAI_EMBEDDINGS_KEY) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.OPENAI_EMBEDDINGS_KEY}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text.slice(0, 8000),
      }),
    });
    if (!res.ok) {
      console.error(`[embeddings] HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    return body.data?.[0]?.embedding ?? null;
  } catch (err) {
    console.error('[embeddings] error:', err);
    return null;
  }
}
