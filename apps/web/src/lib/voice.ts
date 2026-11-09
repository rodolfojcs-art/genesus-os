import { useCallback, useRef, useState } from 'react';
import { ttsToUrl } from '../api';

/**
 * Hook de voz para GENESUS:
 *  - Escucha (STT): Web Speech API del navegador, en español, tiempo real.
 *  - Habla (TTS): voz neuronal en ESPAÑOL NEUTRO desde el backend (Edge Neural
 *    TTS gratis, o OpenAI si hay saldo). Si no hay red, cae a la mejor voz
 *    española del navegador. Suena como una conversación con una persona real.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySR = any;

export function voiceSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  );
}

/** Limpia markdown/emojis para que la voz del navegador suene natural. */
function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' (bloque de código) ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>|]/g, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface SpeakOpts {
  voice?: string; // voz OpenAI (nova=femenina, onyx=masculina)
  rate?: number; // velocidad (1 = normal)
  gender?: 'f' | 'm';
}

const FEMALE_RE = /sabina|helena|dalia|laura|paloma|isabela|elena|mónica|monica|female|mujer/i;
const MALE_RE = /raul|raúl|pablo|jorge|alvaro|álvaro|diego|enrique|male|hombre/i;
// Preferencia de español NEUTRO: LATAM primero, España al final.
const LANG_RANK = ['es-mx', 'es-us', 'es-419', 'es-co', 'es-ar', 'es-cl', 'es-pe', 'es-ve', 'es-es'];

/** Si el TTS del servidor no entrega audio (sin internet/saldo), se omite el resto de la sesión. */
let cloudTtsDead = false;

/** La lista de voces carga async; la cacheamos y esperamos a `voiceschanged`. */
let voicesCache: SpeechSynthesisVoice[] = [];
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth) return resolve([]);
    const now = synth.getVoices();
    if (now.length) {
      voicesCache = now;
      return resolve(now);
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      voicesCache = synth.getVoices();
      resolve(voicesCache);
    };
    synth.addEventListener?.('voiceschanged', finish, { once: true });
    setTimeout(finish, 1500); // respaldo si el evento no dispara
  });
}

function langScore(lang: string): number {
  const l = lang.toLowerCase();
  const i = LANG_RANK.findIndex((r) => l.startsWith(r));
  return i === -1 ? LANG_RANK.length : i;
}

/**
 * Elige la mejor voz en español NEUTRO del navegador. Nunca devuelve una voz en
 * inglés para texto en español (causa del "robot mal acentuado"): si no hay
 * ninguna voz española instalada, devuelve null y se fuerza lang='es' igual.
 */
function pickSpanishVoice(gender?: 'f' | 'm'): SpeechSynthesisVoice | null {
  const voices = voicesCache.length ? voicesCache : (window.speechSynthesis?.getVoices() ?? []);
  const es = voices.filter((v) => v.lang.toLowerCase().startsWith('es'));
  if (es.length === 0) return null; // sin voz española: mejor null que una inglesa
  const re = gender === 'm' ? MALE_RE : gender === 'f' ? FEMALE_RE : null;

  // Orden: idioma más neutro → calidad neural → género solicitado.
  const ranked = [...es].sort((a, b) => {
    const la = langScore(a.lang) - langScore(b.lang);
    if (la !== 0) return la;
    const na = (/(natural|online|neural|premium|google)/i.test(b.name) ? 1 : 0) -
      (/(natural|online|neural|premium|google)/i.test(a.name) ? 1 : 0);
    if (na !== 0) return na;
    if (re) return (re.test(b.name) ? 1 : 0) - (re.test(a.name) ? 1 : 0);
    return 0;
  });
  if (re) {
    const byGender = ranked.find((v) => re.test(v.name));
    if (byGender) return byGender;
  }
  return ranked[0]!;
}

/** Voz del navegador (gratis, sin API key) — último respaldo. */
async function speakBrowser(text: string, onEnd?: () => void, opts?: SpeakOpts): Promise<void> {
  if (!('speechSynthesis' in window)) {
    onEnd?.();
    return;
  }
  await loadVoices();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(cleanForSpeech(text));
  const v = pickSpanishVoice(opts?.gender);
  if (v) u.voice = v;
  u.lang = v?.lang ?? 'es-MX';
  u.rate = opts?.rate ?? 1.0;
  u.pitch = opts?.gender === 'm' ? 0.95 : 1.02;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  window.speechSynthesis.speak(u);
}

export function useVoice(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const recRef = useRef<AnySR>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  function ensureRec(): AnySR {
    if (recRef.current) return recRef.current;
    const w = window as any;
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return null;
    const rec = new Ctor();
    rec.lang = 'es-MX';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e: any) => {
      let finalText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r && r.isFinal) finalText += r[0]?.transcript ?? '';
      }
      if (finalText.trim()) onFinalRef.current(finalText.trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    return rec;
  }

  const startListening = useCallback(() => {
    const rec = ensureRec();
    if (!rec) return;
    try {
      rec.start();
      setListening(true);
    } catch {
      /* ya estaba escuchando */
    }
  }, []);

  const stopListening = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {
      /* noop */
    }
    setListening(false);
  }, []);

  const speak = useCallback(async (text: string, onEnd?: () => void, opts?: SpeakOpts) => {
    setSpeaking(true);
    const finishAll = () => {
      setSpeaking(false);
      onEnd?.();
    };
    // 1. Voz neuronal del servidor (Edge Neural TTS gratis, o OpenAI si hay saldo).
    //    Devuelve una voz en español NEUTRO que suena como persona real.
    //    Si una vez no hubo audio (sin internet/saldo), se omite el resto de la sesión.
    if (!cloudTtsDead) {
      try {
        const url = await ttsToUrl(text, opts?.voice ?? 'nova', opts?.rate ?? 1);
        if (url) {
          audioRef.current?.pause();
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.playbackRate = 1; // la velocidad ya viene aplicada en el audio
          const finish = () => {
            URL.revokeObjectURL(url);
            finishAll();
          };
          audio.onended = finish;
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            void speakBrowser(text, finishAll, opts);
          };
          await audio.play().catch(() => void speakBrowser(text, finishAll, opts));
          return;
        }
        cloudTtsDead = true; // no hubo audio: pasa directo al navegador en adelante
      } catch {
        /* cae al respaldo del navegador */
      }
    }
    // 2. Último respaldo: voz del navegador (mejor voz española disponible).
    void speakBrowser(text, finishAll, opts);
  }, []);

  const stopSpeaking = useCallback(() => {
    audioRef.current?.pause();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  return { listening, speaking, startListening, stopListening, speak, stopSpeaking };
}
