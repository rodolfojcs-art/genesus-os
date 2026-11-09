import { env } from './env.js';
import { edgeSynthesize, edgeVoiceFor } from './edgeTts.js';

/**
 * Síntesis de voz (TTS) de GENESUS. Prioridad:
 *   1. Edge Neural TTS — voz neuronal en español NEUTRO, gratis y sin llave.
 *      Suena como una persona real (no el TTS robótico del sistema).
 *   2. OpenAI (voz "nova") si hay saldo — respaldo de alta calidad.
 * La llave vive solo en el servidor; el navegador recibe el audio, nunca la key.
 */

const VOICES = ['nova', 'shimmer', 'alloy', 'echo', 'fable', 'onyx', 'sage', 'coral'];

function openaiKey(): string | null {
  return env.OPENAI_API_KEY ?? env.OPENAI_EMBEDDINGS_KEY ?? null;
}

/** TTS siempre disponible: Edge es gratis; OpenAI es un extra opcional. */
export function ttsEnabled(): boolean {
  return true;
}

/** Limpia markdown/emojis para que la voz suene natural (no lea asteriscos). */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (bloque de código omitido) ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>|]/g, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 4000);
}

export async function synthesize(
  text: string,
  voice = 'nova',
  rate = 1,
): Promise<{ audio: ArrayBuffer; contentType: string } | null> {
  const input = cleanForSpeech(text);
  if (!input) return null;

  // 1. Edge Neural TTS — gratis, español neutro, voz humana. Primera opción.
  try {
    const mp3 = await edgeSynthesize(input, edgeVoiceFor(voice), rate);
    if (mp3 && mp3.length > 0) {
      // Copia a un ArrayBuffer "limpio" (evita SharedArrayBuffer en el tipo).
      const ab = mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength) as ArrayBuffer;
      return { audio: ab, contentType: 'audio/mpeg' };
    }
  } catch (err) {
    console.error(`[tts] Edge falló, intento OpenAI: ${err instanceof Error ? err.message : err}`);
  }

  // 2. OpenAI (si hay saldo) — respaldo de alta calidad.
  const key = openaiKey();
  if (!key) return null;
  const v = VOICES.includes(voice) ? voice : 'nova';

  // Modelo más natural primero; fallback a tts-1-hd si no está disponible.
  for (const model of ['gpt-4o-mini-tts', 'tts-1-hd']) {
    const bodyObj: Record<string, unknown> = {
      model,
      voice: v,
      input,
      response_format: 'mp3',
    };
    if (model === 'gpt-4o-mini-tts') {
      bodyObj.instructions =
        'Habla en español latinoamericano, con tono cálido, cercano y natural, como una persona real conversando. Ritmo fluido, no robótico.';
    }
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(bodyObj),
    });
    if (res.ok) {
      return { audio: await res.arrayBuffer(), contentType: 'audio/mpeg' };
    }
    if (model === 'tts-1-hd') {
      const err = await res.text();
      console.error(`[tts] fallo: ${res.status} ${err.slice(0, 200)}`);
    }
  }
  return null;
}
