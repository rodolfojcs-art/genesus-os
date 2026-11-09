import WebSocket from 'ws';
import { createHash } from 'node:crypto';

/**
 * Edge Neural TTS — voz neuronal en español neutro, GRATIS y sin API key.
 * Usa el mismo servicio de "Leer en voz alta" de Microsoft Edge. Suena como una
 * persona real (no el TTS robótico del sistema). Ideal cuando no hay saldo OpenAI.
 *
 * Voces neutras LATAM por defecto:
 *   - femenina: es-US-PalomaNeural (español neutro EE.UU.)
 *   - masculina: es-US-AlonsoNeural
 * Alternativas naturales: es-MX-DaliaNeural / es-MX-JorgeNeural.
 */

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS_BASE = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_TOKEN}`;
const SEC_MS_GEC_VERSION = '1-140.0.3485.14';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/**
 * Token de seguridad que Microsoft exige (Sec-MS-GEC): SHA-256 mayúsculas de
 * (ticks de Windows redondeados a 5 min + token de cliente). Sin esto el
 * servicio responde 403. Se calcula por petición.
 */
function secMsGec(): string {
  const unixSeconds = Math.floor(Date.now() / 1000);
  // FileTime en ticks de 100 ns desde 1601; redondeado al múltiplo de 5 minutos.
  let ticks = (BigInt(unixSeconds) + 11644473600n) * 10000000n;
  ticks -= ticks % 3000000000n;
  return createHash('sha256').update(`${ticks.toString()}${TRUSTED_TOKEN}`).digest('hex').toUpperCase();
}

function wssUrl(connectionId: string): string {
  return `${WSS_BASE}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`;
}

export const EDGE_VOICES = {
  f: 'es-US-PalomaNeural',
  m: 'es-US-AlonsoNeural',
} as const;

/** Mapea voces tipo OpenAI / género a una voz neuronal de Edge en español. */
export function edgeVoiceFor(voice?: string): string {
  if (voice && /^es-[A-Z]{2}-/.test(voice)) return voice; // ya es una voz Edge explícita
  const male = voice === 'onyx' || voice === 'echo' || voice === 'm';
  return male ? EDGE_VOICES.m : EDGE_VOICES.f;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Convierte un factor de velocidad (1 = normal) al formato de prosodia de SSML. */
function ratePct(rate: number): string {
  const pct = Math.round((rate - 1) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

function buildSsml(text: string, voice: string, rate: number): string {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='es-MX'>` +
    `<voice name='${voice}'>` +
    `<prosody rate='${ratePct(rate)}' pitch='+0Hz'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`
  );
}

/**
 * Sintetiza `text` con Edge TTS y devuelve un MP3. Resuelve null si el servicio
 * no responde (sin internet, bloqueo, etc.) para que el llamador use otro respaldo.
 */
export function edgeSynthesize(
  text: string,
  voice: string = EDGE_VOICES.f,
  rate = 1,
  timeoutMs = 15000,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const done = (val: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve(val);
    };

    const connectionId = (globalThis.crypto?.randomUUID() ?? `${Date.now()}-x`).replace(/-/g, '');
    const ws = new WebSocket(wssUrl(connectionId), {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const timer = setTimeout(() => done(null), timeoutMs);

    ws.on('open', () => {
      const ts = new Date().toISOString();
      ws.send(
        `X-Timestamp:${ts}\r\n` +
          `Content-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                  outputFormat: OUTPUT_FORMAT,
                },
              },
            },
          }),
      );
      const requestId = (globalThis.crypto?.randomUUID() ?? `${ts}-${Math.round(rate * 1e6)}`).replace(/-/g, '');
      ws.send(
        `X-RequestId:${requestId}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${ts}\r\n` +
          `Path:ssml\r\n\r\n` +
          buildSsml(text, voice, rate),
      );
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Cada frame binario: [2 bytes header length][header][audio].
        const headerLen = (data[0]! << 8) | data[1]!;
        const header = data.slice(2, 2 + headerLen).toString('utf-8');
        if (header.includes('Path:audio')) {
          chunks.push(data.slice(2 + headerLen));
        }
      } else {
        const msg = data.toString('utf-8');
        if (msg.includes('Path:turn.end')) {
          done(chunks.length ? Buffer.concat(chunks) : null);
        }
      }
    });

    ws.on('error', () => done(null));
    ws.on('close', () => done(chunks.length ? Buffer.concat(chunks) : null));
  });
}
