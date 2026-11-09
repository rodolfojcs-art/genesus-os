import type { LlmCaller } from '@genesus/core';
import type { AgentDefinition } from '@genesus/core';
import { extractJson } from '@genesus/core';
import { z } from 'zod';
import { bestAgentFor, getAgent, registerAgent } from './registry.js';
import { supabaseAnon, supabaseForUser } from './supabase.js';
import { embed, embeddingsEnabled } from './embeddings.js';
import { markSynced, readUnsyncedNotes, vaultPath, writeMemoryNote } from './vault.js';
import { gbrainAvailable, gbrainCapture } from './gbrainBridge.js';

export const LOCAL_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Cliente de escritura para la IA personal:
 *  - con token (login real) → cliente con JWT (RLS por auth.uid()).
 *  - sin token (uso local / Open WebUI) → cliente anónimo; la RLS local acota
 *    todo al usuario fijo LOCAL_USER_ID. Así la memoria es permanente sin login.
 */
function clientFor(token: string | null) {
  return token ? supabaseForUser(token) : supabaseAnon();
}

/**
 * GENESUS Personal — la IA personal de Rodolfo.
 *
 * Flujo de una pregunta:
 *  1. Recuperar memoria relevante (FTS) e inyectarla como contexto.
 *  2. Rutear al mejor departamento. Si ninguno encaja, CREAR uno automáticamente.
 *  3. Responder con el agente departamental (Sonnet).
 *  4. Clasificar relevancia (Haiku) y guardar memoria PERMANENTE.
 *     - Relevante  → memoria activa.
 *     - Irrelevante → memoria archivada, PERO el registro (question_log)
 *       conserva qué se preguntó + la referencia para ubicarla rápido.
 */

const UMBRAL_RUTEO = 2; // score mínimo para usar un depto existente

export interface AskResult {
  answer: string;
  department: { code: string; specialty: string; created: boolean };
  memoryId: string | null;
  relevance: 'relevante' | 'irrelevante';
  recalledMemories: number;
  costUsd: number;
}

export interface MemoryItem {
  id: string;
  title: string | null;
  content: string;
  status: string;
  created_at: string;
}

interface AutoDept {
  division_code: string;
  specialty: string;
  system_prompt: string;
}

const AutoDeptSchema = z.object({
  division_code: z.string().min(2).max(8),
  specialty: z.string().min(3).max(120),
  system_prompt: z.string().min(40).max(8000),
});

// Almacén en memoria para desarrollo sin Supabase (se reporta en health).
interface MemRow extends MemoryItem {
  user_id: string;
}
const memMemories: MemRow[] = [];
const memQuestions: Array<{
  id: string;
  user_id: string;
  question: string;
  department_code: string | null;
  department_created: boolean;
  memory_id: string | null;
  relevance: string;
  created_at: string;
}> = [];
let autoSeq = 0;

// Cache por usuario de "¿tiene memorias?" para no llamar a embeddings sobre un
// BRAIN vacío (optimización de latencia en arranque en frío).
const userHasMemory = new Set<string>();

/**
 * PROMPT BASE de GENESUS — versión avanzada, autónoma y multimodal.
 * Se inyecta en cada respuesta (junto con RIGOR_RULES, memoria y modo voz).
 * Diseñado para que GENESUS conozca sus capacidades REALES (y no las niegue),
 * actúe con iniciativa y razone sobre texto, imágenes, tablas, código y datos.
 */
function GENESUS_BASE_PROMPT(): string {
  return [
    'Eres GENESUS, la inteligencia personal de Rodolfo Cadet (Genesus Technology LLC). No eres un chatbot:',
    'eres un sistema operativo de IA con una red de agentes especializados, varios cerebros (Claude, OpenAI,',
    'Codex, Grok, Gemini, Meta/Llama y Ollama local) y herramientas reales que se ejecutan en la propia',
    'máquina del usuario a través de la app GENESUS OS.',
    '',
    'IDENTIDAD Y TONO: hablas español latinoamericano neutro, claro, cálido y directo, como un socio brillante',
    'y de confianza, no como un asistente servil. Vas al grano, sin relleno ni disculpas innecesarias.',
    '',
    'CAPACIDADES REALES (son verdaderas: NO las niegues ni digas "no puedo" cuando sí puedes):',
    '- Memoria permanente entre sesiones: recuerdas lo importante del usuario; usa el contexto recuperado',
    '  abajo en vez de pedir que te repitan lo ya dicho.',
    '- Internet en vivo: cuando un dato es actual o pudo cambiar, lo buscas en la web y respondes con fuentes citadas.',
    '- Ejecución de código real para cálculos, análisis de datos y verificación.',
    '- Control del PC con salvaguardas y creación/lectura NATIVA de documentos Word (.docx), Excel (.xlsx),',
    '  PowerPoint (.pptx) y PDF, a través de tu módulo de control del PC (panel «Mi PC»).',
    '- Razonamiento multi-cerebro: para decisiones difíciles puedes convocar un concilio de modelos y sintetizar lo mejor.',
    '',
    'REGLA CRÍTICA sobre documentos: si el usuario pide un archivo real (Word/Excel/PowerPoint/PDF) y ESTA respuesta',
    'tuya no confirma que el archivo fue creado en disco, NUNCA sustituyas el pedido pegando el contenido completo,',
    'una tabla larga, o un script/código (Python, etc.) en el chat como si fuera el entregable — eso frustra al usuario,',
    'que quiere el archivo terminado, no una conversación de programador. En vez de eso, en 1-2 frases dile que lo va a',
    'generar y pídele que lo repita con una frase directa como "crea/genera un Word/Excel/PowerPoint/PDF con…".',
    '',
    'RAZONAMIENTO MULTIMODAL: razonas sobre texto, imágenes, tablas, código y datos complejos. Si recibes una',
    'imagen o un documento, analízalo con precisión: extrae lo relevante, lee cifras y tablas con cuidado y',
    'no inventes lo que no aparece. Ante problemas complejos, piensa paso a paso antes de responder y entrega',
    'una conclusión estructurada y accionable.',
    '',
    'AUTONOMÍA Y ESTILO DIRECTO (actúa, no solo converses):',
    '- Sé RESOLUTIVO: completa la tarea de una vez. Toma decisiones razonables por defecto en lugar de preguntar.',
    '  Si falta un detalle menor (un nombre, un formato), elige una opción sensata y avanza; no frenes con preguntas.',
    '- Cuando una acción es segura y reversible (leer, consultar, buscar, calcular, redactar, crear archivos o documentos),',
    '  HAZLA directamente. Encadena los pasos necesarios hasta resolver el problema completo.',
    '- Pide confirmación SOLO antes de lo destructivo o difícil de revertir (borrar, sobrescribir, mover, instalar, enviar, gastar).',
    '- Generas y abres documentos reales (Word/Excel/PowerPoint/PDF) y escribes/editas archivos y código directamente en el PC.',
    '- Responde en frases completas y útiles, SIN cerrar con preguntas de relleno tipo "¿quieres que…?". Entrega el resultado.',
    '',
    'Para consultas casuales respondes tú mismo; para temas que requieran un especialista los resuelves igual,',
    'y la red activará el departamento experto en segundo plano.',
  ].join('\n');
}

/** Concierge general: responde al instante consultas casuales/cortas sin invocar
 *  a Opus para crear un departamento. Mantiene el camino crítico rápido. */
const CONCIERGE: AgentDefinition = {
  code: 'GENESUS',
  divisionCode: 'CORP',
  name: 'GENESUS — Asistente personal',
  specialty: 'Asistente personal',
  description: 'Asistente general de la red GENESUS',
  capabilities: [],
  deliverables: [],
  systemPrompt: GENESUS_BASE_PROMPT(),
  modelTier: 'sonnet',
  status: 'activo',
};

/** ¿La consulta amerita crear un departamento especializado nuevo? */
function isSubstantive(question: string): boolean {
  return question.trim().length >= 40;
}

// Reglas de rigor + operación, inyectadas en TODA respuesta (sobre el prompt base o del depto).
const RIGOR_RULES =
  '\n\nREGLAS DE RIGOR Y OPERACIÓN (obligatorias):\n' +
  '- VERDAD ANTE TODO: nunca inventes datos, cifras, nombres, fechas, APIs ni funciones. Separa lo que sabes con certeza de lo estimado y marca lo incierto como "por verificar".\n' +
  '- Si un hecho es actual o pudo cambiar, no lo afirmes sin fuente: búscalo en la web y cítalo.\n' +
  '- Usa tu MEMORIA PERMANENTE (contexto recuperado abajo) en lugar de pedir que te repitan lo ya dicho.\n' +
  '- Calíbrate: si no sabes algo, dilo. Mejor una respuesta honesta y accionable que una segura y falsa.\n' +
  '- Privacidad y seguridad primero: los datos del usuario son suyos; no los expongas y nunca ejecutes acciones destructivas o que desactiven la seguridad.\n' +
  '- Ajusta la profundidad a la tarea: directo en lo simple, riguroso y estructurado en lo complejo.';

/** Detecta si la consulta necesita datos reales/actuales (web search). */
function needsWebGrounding(q: string): boolean {
  return /\b(busca|buscar|investiga|investigar|noticia|noticias|precio|precios|cotiza|cotización|actual|actualidad|hoy|reciente|recientes|último|últimos|última|ahora mismo|en línea|fuente|fuentes|tipo de cambio|dólar|clima|qué pasó|quién ganó|cuándo (es|fue|será)|202[5-9]|203\d)\b/i.test(
    q,
  );
}

/**
 * Detecta si la consulta pide crear/revisar un documento de oficina o actuar en
 * el PC (buscar/organizar archivos). En ese caso el chat se enruta al agente del PC.
 */
export function needsDocOrPc(q: string): boolean {
  // Normaliza acentos para que "créame"/"genéra"/"código" también coincidan.
  const s = q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // Formato de oficina: SIN exigir el punto ("docx" o ".docx" cuentan igual).
  const office = /(word|excel|power\s?point|docx|xlsx|pptx|\bpdf\b|hoja de calculo|presentacion|diapositiva|planilla)/;
  const codeFile = /(archivo|documento|script|codigo|carpeta|\.txt|\.md|\.py|\.js|\.ts|\.json|\.csv|\.html|\.xml|\.bat|\.ps1|\.sh|\.env)/;

  // Verbos/deseos de creación: incluye conjugaciones comunes Y formas de pedido
  // natural ("quiero", "necesito", "dame", "pásame"...) que antes se perdían.
  const create =
    /\b(crea|creame|crear|genera|generame|generar|haz|hazme|hagame|elabora|elaborame|elaborar|arma|armame|armar|exporta|exportar|convierte|convertir|redacta|redactar|escribe|escribeme|escribir|guarda|guardame|guardar|anota|descarga|descargar|produce|producir|prepara|preparame|preparar|quiero|quisiera|necesito|necesitaria|dame|damelo|pasame|pasalo|ponme|pon|mandame|enviame)\b/;
  const review =
    /\b(lee|leeme|leer|revisa|revisame|revisar|analiza|analizame|analizar|resume|resumeme|resumir|extrae|extraeme|extraer|abre|abreme|abrir|muestra|muestrame)\b/;
  const edit =
    /\b(edita|editame|editar|reemplaza|reemplazar|modifica|modificame|modificar|corrige|corrigeme|corregir|cambia|cambiame|cambiar)\b/;
  const pcAction =
    /\b(archivos?\s+duplicados?|organiza\w*|busca\w*\s+(un\s+|el\s+|mi\s+)?archivo|mueve\w*|archiva\w*|renombra\w*|ejecuta\w*\s+(este\s+)?(script|comando|programa)|corre\w*\s+(este\s+)?(script|comando)|abre\s+(la\s+)?(app|aplicacion|carpeta))/;

  return (
    (create.test(s) && (office.test(s) || codeFile.test(s))) ||
    (review.test(s) && (office.test(s) || codeFile.test(s))) ||
    (edit.test(s) && codeFile.test(s)) ||
    pcAction.test(s)
  );
}

/** Detecta si conviene ejecutar código real (cálculo/verificación). */
function needsCodeExec(q: string): boolean {
  return /\b(ejecuta|ejecutar|corre|correr|calcula|calcular|cómputo|computa|resultado de|cuánto (es|da)|simula|grafica|graficar|verifica con código|prueba este código|script|programa esto)\b/i.test(
    q,
  );
}

export interface PreparedTurn {
  agent: AgentDefinition;
  system: string;
  recalled: MemoryItem[];
  lowScoreSubstantive: boolean;
  grounded: boolean;
  codeExec: boolean;
}

export class PersonalAssistant {
  constructor(private readonly llm: LlmCaller) {}

  /**
   * Camino crítico (rápido): recall de memoria + selección de agente SIN Opus.
   * La creación de departamentos especializados se difiere a segundo plano.
   */
  async route(
    userId: string,
    token: string | null,
    question: string,
    opts: { spoken?: boolean } = {},
  ): Promise<PreparedTurn> {
    const recalled = await this.searchMemory(userId, token, question, 6);
    const memoryContext = recalled
      .map((m) => `• ${m.title ? m.title + ': ' : ''}${m.content}`)
      .join('\n');

    const routed = bestAgentFor(question);
    let agent: AgentDefinition;
    let lowScoreSubstantive = false;
    if (routed && routed.score >= UMBRAL_RUTEO) {
      agent = getAgent(routed.agent.code) ?? CONCIERGE;
    } else {
      // Sin buen match: responde el concierge YA; si la consulta es sustantiva,
      // se creará un departamento experto en segundo plano para la próxima vez.
      agent = CONCIERGE;
      lowScoreSubstantive = isSubstantive(question);
    }

    const spokenRules = opts.spoken
      ? '\n\nMODO VOZ: estás conversando por voz. Responde de forma natural y conversacional, ' +
        'como una persona hablando. Sé breve (2-5 frases salvo que pidan detalle), sin listas con viñetas, ' +
        'sin markdown ni emojis, sin encabezados. Frases completas y fluidas para escuchar en voz alta.'
      : '';
    // El prompt base avanzado (capacidades, autonomía, multimodal) aplica SIEMPRE;
    // si responde un departamento especialista, se añade su rol encima del base.
    const persona =
      agent.code === CONCIERGE.code
        ? agent.systemPrompt
        : `${GENESUS_BASE_PROMPT()}\n\nEN ESTA CONSULTA actúas además como especialista de la red GENESUS:\n${agent.systemPrompt}`;
    const system = `${persona}${RIGOR_RULES}${spokenRules}${
      memoryContext
        ? `\n\nMEMORIA PERMANENTE RELEVANTE DEL USUARIO (úsala si aplica):\n${memoryContext}`
        : ''
    }`;
    return {
      agent,
      system,
      recalled,
      lowScoreSubstantive,
      grounded: needsWebGrounding(question),
      codeExec: needsCodeExec(question),
    };
  }

  /**
   * Trabajo posterior FUERA del camino crítico: guarda memoria permanente,
   * clasifica relevancia, registra la pregunta y (si aplica) crea el
   * departamento especializado en segundo plano. No bloquea la respuesta.
   */
  async finalize(
    userId: string,
    token: string | null,
    question: string,
    prepared: PreparedTurn,
    answer: string,
  ): Promise<{ relevance: 'relevante' | 'irrelevante'; memoryId: string | null }> {
    const relevance = await this.classifyRelevance(question);
    const memory = await this.saveMemory(
      userId,
      token,
      question.slice(0, 120),
      `Pregunta: ${question}\nRespuesta: ${answer}`,
      relevance === 'relevante' ? 'activa' : 'archivada',
      'personal',
      prepared.agent.code,
    );
    if (memory) userHasMemory.add(userId);

    await this.logQuestion(userId, token, {
      question,
      department_code: prepared.agent.code,
      department_created: prepared.lowScoreSubstantive,
      memory_id: memory?.id ?? null,
      relevance,
    });

    // Departamento especializado en segundo plano (no se esperó para responder)
    if (prepared.lowScoreSubstantive) {
      this.createDepartment(userId, token, question).catch((err) =>
        console.error('[assistant] creación de depto en segundo plano falló:', err),
      );
    }
    return { relevance, memoryId: memory?.id ?? null };
  }

  /** Versión no-streaming (usada por la capa OpenAI-compat). */
  async ask(userId: string, token: string | null, question: string): Promise<AskResult> {
    const prepared = await this.route(userId, token, question);
    const res = await this.llm.complete({
      tier: 'sonnet',
      system: prepared.system,
      prompt: question,
      maxTokens: 2000,
    });
    const { relevance, memoryId } = await this.finalize(
      userId,
      token,
      question,
      prepared,
      res.text,
    );
    return {
      answer: res.text,
      department: {
        code: prepared.agent.code,
        specialty: prepared.agent.specialty,
        created: prepared.lowScoreSubstantive,
      },
      memoryId,
      relevance,
      recalledMemories: prepared.recalled.length,
      costUsd: res.costUsd,
    };
  }

  /** Crea un departamento nuevo cuando ninguno encaja (GENESUS decide la taxonomía). */
  private async createDepartment(
    userId: string,
    token: string | null,
    question: string,
  ): Promise<{ agent: AgentDefinition; costUsd: number }> {
    const res = await this.llm.complete({
      tier: 'opus',
      system: `Eres GENESUS. Ninguno de los departamentos existentes cubre bien esta consulta del usuario.
Diseña un NUEVO departamento especializado para atenderla y futuras consultas similares.
Divisiones disponibles (usa el código más cercano, o "CORP" si es transversal):
ENRG, ELEC, SCI, COMP, DSGN, MFG, SUPL, COMM, FIN, CORP.
Responde ÚNICAMENTE con JSON:
{
  "division_code": "una de las anteriores",
  "specialty": "nombre corto de la especialidad del nuevo departamento",
  "system_prompt": "system prompt completo del agente, en español latinoamericano, que lo define como experto del tema y miembro de la red GENESUS"
}`,
      prompt: `CONSULTA DEL USUARIO:\n${question}`,
      maxTokens: 1500,
    });

    let auto: AutoDept;
    try {
      auto = AutoDeptSchema.parse(extractJson(res.text));
    } catch {
      auto = {
        division_code: 'CORP',
        specialty: question.slice(0, 60),
        system_prompt: `Eres un agente especializado de GENESUS OS dedicado a: ${question.slice(0, 200)}. Respondes en español latinoamericano, con precisión y de forma accionable.`,
      };
    }

    autoSeq += 1;
    const code = `AUTO-${String(autoSeq).padStart(3, '0')}`;
    const agent: AgentDefinition = {
      code,
      divisionCode: auto.division_code as AgentDefinition['divisionCode'],
      name: `Departamento ${code} — ${auto.specialty}`,
      specialty: auto.specialty,
      description: auto.specialty,
      capabilities: [],
      deliverables: [],
      systemPrompt: auto.system_prompt,
      modelTier: 'sonnet',
      status: 'activo',
    };
    registerAgent(agent);

    // Persistir como departamento custom (RLS permite custom=true)
    const sb = clientFor(token);
    if (sb) {
      const { data: div } = await sb
        .from('divisions')
        .select('id')
        .eq('code', auto.division_code)
        .maybeSingle();
      const divId =
        (div?.id as string | undefined) ??
        (await sb.from('divisions').select('id').eq('code', 'CORP').maybeSingle()).data?.id;
      if (divId) {
        const uniqueCode = `AUTO-${Date.now().toString(36).toUpperCase()}`;
        agent.code = uniqueCode;
        await sb.from('agents').insert({
          division_id: divId,
          code: uniqueCode,
          name: agent.name,
          specialty: agent.specialty,
          system_prompt: agent.systemPrompt,
          model_tier: 'sonnet',
          status: 'activo',
          custom: true,
        });
        registerAgent(agent);
      }
    }
    return { agent, costUsd: res.costUsd };
  }

  private async classifyRelevance(question: string): Promise<'relevante' | 'irrelevante'> {
    try {
      const res = await this.llm.complete({
        tier: 'haiku',
        system:
          'Clasifica si vale la pena recordar permanentemente esta consulta del usuario para su IA personal. ' +
          'Responde SOLO con una palabra: RELEVANTE (si aporta contexto, datos, decisiones o conocimiento útil a futuro) ' +
          'o IRRELEVANTE (saludos, pruebas, charla trivial sin información que valga la pena conservar).',
        prompt: question,
        maxTokens: 8,
      });
      return res.text.toUpperCase().includes('IRRELEVANTE') ? 'irrelevante' : 'relevante';
    } catch {
      return 'relevante';
    }
  }

  async saveMemory(
    userId: string,
    token: string | null,
    title: string,
    content: string,
    status: 'activa' | 'archivada' = 'activa',
    scope: 'personal' | 'obsidian' = 'personal',
    department?: string,
  ): Promise<MemoryItem | null> {
    const embedding = await embed(`${title}\n${content}`);
    const sb = clientFor(token);
    let saved: MemoryItem | null = null;
    if (sb) {
      const { data, error } = await sb
        .from('brain_memory')
        .insert({ user_id: userId, scope, title, content, status, embedding })
        .select('id, title, content, status, created_at')
        .single();
      if (error) {
        console.error(`[memory] error guardando: ${error.message}`);
      } else {
        saved = data as MemoryItem;
      }
    }
    if (!saved) {
      const row: MemRow = {
        id: crypto.randomUUID(),
        user_id: userId,
        title,
        content,
        status,
        created_at: new Date().toISOString(),
      };
      memMemories.push(row);
      saved = row;
    }
    // Espejo Obsidian (solo memorias personales; las importadas ya viven en la bóveda)
    if (saved && scope === 'personal' && vaultPath()) {
      writeMemoryNote({
        id: saved.id,
        title,
        content,
        status,
        department,
        relevance: status === 'activa' ? 'relevante' : 'irrelevante',
      });
    }
    // Volcado al cerebro independiente GBrain (solo memorias activas relevantes).
    if (saved && status === 'activa' && gbrainAvailable()) {
      gbrainCapture(`${title}\n\n${content}`).catch(() => {});
    }
    return saved;
  }

  /** Indexa a BRAIN las notas nuevas escritas por el usuario en GENESUS/Notas. */
  async syncObsidian(userId: string, token: string | null): Promise<{ imported: number }> {
    if (!vaultPath()) return { imported: 0 };
    const notes = readUnsyncedNotes();
    let imported = 0;
    for (const note of notes) {
      const saved = await this.saveMemory(
        userId,
        token,
        note.title,
        note.content.slice(0, 8000),
        'activa',
        'obsidian',
      );
      if (saved) {
        markSynced(note.file);
        imported++;
      }
    }
    return { imported };
  }

  async searchMemory(
    userId: string,
    token: string | null,
    query: string,
    limit = 8,
  ): Promise<MemoryItem[]> {
    const sb = clientFor(token);
    if (sb) {
      const found = new Map<string, MemoryItem>();
      // 1. Recall semántico — solo si hay embeddings Y el usuario ya tiene memoria
      //    (evita una llamada de embeddings inútil sobre un BRAIN vacío).
      if (embeddingsEnabled() && userHasMemory.has(userId)) {
        const vec = await embed(query);
        if (vec) {
          const { data } = await sb.rpc('match_memories', {
            query_embedding: vec,
            match_threshold: 0.35,
            match_count: limit,
            p_user_id: userId,
          });
          for (const m of data ?? []) {
            found.set(m.id as string, {
              id: m.id as string,
              title: null,
              content: m.content as string,
              status: 'activa',
              created_at: '',
            });
          }
        }
      }
      // 2. FTS léxico (siempre)
      const { data, error } = await sb.rpc('search_memories_text', {
        p_query: query,
        p_limit: limit,
        p_user_id: userId,
      });
      if (error) console.error(`[memory] error buscando: ${error.message}`);
      for (const m of data ?? []) {
        if (!found.has(m.id as string)) {
          found.set(m.id as string, {
            id: m.id as string,
            title: (m.title as string) ?? null,
            content: m.content as string,
            status: 'activa',
            created_at: '',
          });
        }
      }
      return [...found.values()].slice(0, limit);
    }
    const q = query.toLowerCase();
    return memMemories
      .filter((m) => m.user_id === userId && m.status === 'activa' && (m.content.toLowerCase().includes(q) || (m.title ?? '').toLowerCase().includes(q)))
      .slice(0, limit);
  }

  async listMemory(userId: string, token: string | null, includeArchived: boolean): Promise<MemoryItem[]> {
    const sb = clientFor(token);
    if (sb) {
      let q = sb
        .from('brain_memory')
        .select('id, title, content, status, created_at')
        .eq('scope', 'personal')
        .order('created_at', { ascending: false })
        .limit(200);
      if (!includeArchived) q = q.eq('status', 'activa');
      const { data, error } = await q;
      if (error) {
        console.error(`[memory] error listando: ${error.message}`);
        return [];
      }
      if ((data?.length ?? 0) > 0) userHasMemory.add(userId); // habilita recall semántico
      return (data ?? []) as MemoryItem[];
    }
    return memMemories
      .filter((m) => m.user_id === userId && (includeArchived || m.status === 'activa'))
      .slice()
      .reverse();
  }

  /** Archiva (no borra) una memoria. El registro de la pregunta permanece. */
  async archiveMemory(userId: string, token: string | null, id: string): Promise<boolean> {
    const sb = clientFor(token);
    if (sb) {
      const { error } = await sb
        .from('brain_memory')
        .update({ status: 'archivada' })
        .eq('id', id)
        .eq('user_id', userId);
      return !error;
    }
    const row = memMemories.find((m) => m.id === id && m.user_id === userId);
    if (row) row.status = 'archivada';
    return Boolean(row);
  }

  private async logQuestion(
    userId: string,
    token: string | null,
    entry: {
      question: string;
      department_code: string | null;
      department_created: boolean;
      memory_id: string | null;
      relevance: string;
    },
  ): Promise<void> {
    const sb = clientFor(token);
    if (sb) {
      const { error } = await sb.from('question_log').insert({ user_id: userId, ...entry });
      if (error) console.error(`[question_log] ${error.message}`);
      return;
    }
    memQuestions.push({ id: crypto.randomUUID(), user_id: userId, created_at: new Date().toISOString(), ...entry });
  }

  async listQuestions(userId: string, token: string | null): Promise<unknown[]> {
    const sb = clientFor(token);
    if (sb) {
      const { data } = await sb
        .from('question_log')
        .select('id, question, department_code, department_created, memory_id, relevance, created_at')
        .order('created_at', { ascending: false })
        .limit(200);
      return data ?? [];
    }
    return memQuestions.filter((q) => q.user_id === userId).slice().reverse();
  }
}
