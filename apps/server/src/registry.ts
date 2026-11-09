import { generateNetwork } from '@genesus/agents';
import type { AgentDefinition, DivisionDefinition, SubagentDefinition } from '@genesus/core';
import { supabase, supabaseRead } from './supabase.js';

/**
 * Registro de la red. Fuente de verdad:
 *  1. Supabase (red real sembrada, incluye divisiones enriquecidas y
 *     departamentos creados automáticamente por la IA personal).
 *  2. Generador determinista (build-time) como fallback sin base de datos.
 *
 * Tras `hydrateFromSupabase()` el registro queda en memoria para lookup O(1).
 */
const fallback = generateNetwork();

let agentsByCode = new Map<string, AgentDefinition>(fallback.agents.map((a) => [a.code, a]));
const subagentsByAgent = new Map<string, SubagentDefinition[]>();
for (const s of fallback.subagents) {
  const list = subagentsByAgent.get(s.agentCode) ?? [];
  list.push(s);
  subagentsByAgent.set(s.agentCode, list);
}
let agentList: AgentDefinition[] = [...fallback.agents];
let divisionList: DivisionDefinition[] = [...fallback.divisions];

const overrides = new Map<string, Partial<Pick<AgentDefinition, 'status' | 'systemPrompt'>>>();

export let DIVISIONS: DivisionDefinition[] = divisionList;

/** Carga la red desde Supabase si está disponible (reemplaza el fallback). */
export async function hydrateFromSupabase(): Promise<{ source: string; agents: number }> {
  const sb = supabaseRead();
  if (!sb) return { source: 'generador (sin Supabase)', agents: agentList.length };

  const { data: divs, error: dErr } = await sb.from('divisions').select('code, name, color, description');
  const { data: ags, error: aErr } = await sb
    .from('agents')
    .select('code, division_id, specialty, system_prompt, model_tier, status, custom, divisions(code)')
    .order('code')
    .limit(5000);
  if (dErr || aErr || !divs || !ags || ags.length === 0) {
    return { source: 'generador (Supabase vacío o error)', agents: agentList.length };
  }

  divisionList = divs.map((d) => ({
    code: d.code as DivisionDefinition['code'],
    name: d.name as string,
    color: d.color as string,
    director: '',
    description: (d.description as string) ?? '',
  }));
  DIVISIONS = divisionList;

  const next = new Map<string, AgentDefinition>();
  const list: AgentDefinition[] = [];
  for (const a of ags) {
    const divCode =
      (a as { divisions?: { code?: string } }).divisions?.code ??
      (a.code as string).split('-')[0] ??
      'CORP';
    const def: AgentDefinition = {
      code: a.code as string,
      divisionCode: divCode as AgentDefinition['divisionCode'],
      name: `Departamento ${a.code}`,
      specialty: a.specialty as string,
      description: a.specialty as string,
      capabilities: [],
      deliverables: [],
      systemPrompt: a.system_prompt as string,
      modelTier: (a.model_tier as AgentDefinition['modelTier']) ?? 'sonnet',
      status: (a.status as AgentDefinition['status']) ?? 'activo',
    };
    next.set(def.code, def);
    list.push(def);
  }
  agentsByCode = next;
  agentList = list;
  return { source: 'Supabase', agents: agentList.length };
}

export function networkCounts(): { divisions: number; agents: number; subagents: number } {
  return {
    divisions: divisionList.length,
    agents: agentList.length,
    subagents: agentList.length * 10,
  };
}

export function getAgent(code: string): AgentDefinition | undefined {
  const base = agentsByCode.get(code);
  if (!base) return undefined;
  return { ...base, ...overrides.get(code) };
}

export function getSubagents(agentCode: string): SubagentDefinition[] {
  const known = subagentsByAgent.get(agentCode);
  if (known) return known;
  // Subagente QA sintético para agentes cargados desde DB o creados al vuelo
  return [
    {
      code: `${agentCode}.5`,
      agentCode,
      role: 'Control de calidad',
      modelTier: 'haiku',
      systemPrompt:
        `Eres el subagente de control de calidad de ${agentCode}. Evalúa si el entregable cumple ` +
        `los criterios. Primera línea exactamente "APROBADO" o "RECHAZADO"; si rechazas, lista los problemas.`,
    },
  ];
}

export interface AgentSearchParams {
  q?: string;
  division?: string;
  page?: number;
  pageSize?: number;
}

export function searchAgents(params: AgentSearchParams): {
  total: number;
  page: number;
  pageSize: number;
  items: Array<Omit<AgentDefinition, 'systemPrompt'>>;
} {
  const q = params.q?.toLowerCase().trim();
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 24));

  let list = agentList;
  if (params.division) list = list.filter((a) => a.divisionCode === params.division);
  if (q) {
    list = list.filter(
      (a) =>
        a.code.toLowerCase().includes(q) ||
        a.specialty.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q),
    );
  }
  const items = list.slice((page - 1) * pageSize, page * pageSize).map((a) => {
    const { systemPrompt: _omit, ...rest } = { ...a, ...overrides.get(a.code) };
    return rest;
  });
  return { total: list.length, page, pageSize, items };
}

export async function updateAgent(
  code: string,
  patch: { status?: 'activo' | 'inactivo'; systemPrompt?: string },
): Promise<AgentDefinition | undefined> {
  const base = agentsByCode.get(code);
  if (!base) return undefined;
  overrides.set(code, { ...overrides.get(code), ...patch });
  const sb = supabase();
  if (sb) {
    const row: Record<string, unknown> = {};
    if (patch.status) row.status = patch.status;
    if (patch.systemPrompt) row.system_prompt = patch.systemPrompt;
    if (Object.keys(row).length > 0) {
      const { error } = await sb.from('agents').update(row).eq('code', code);
      if (error) console.error(`[agents] error actualizando ${code}: ${error.message}`);
    }
  }
  return getAgent(code);
}

/** Inserta un departamento creado en runtime (IA personal) al registro en memoria. */
export function registerAgent(def: AgentDefinition): void {
  agentsByCode.set(def.code, def);
  agentList = [...agentList, def];
}

export function divisionIdCache(): Promise<Map<string, string>> {
  return (async () => {
    const sb = supabaseRead();
    const map = new Map<string, string>();
    if (!sb) return map;
    const { data } = await sb.from('divisions').select('id, code');
    for (const d of data ?? []) map.set(d.code as string, d.id as string);
    return map;
  })();
}

const STOPWORDS = new Set([
  'para', 'una', 'unos', 'unas', 'con', 'del', 'las', 'los', 'que', 'este', 'esta',
  'sobre', 'desde', 'hasta', 'como', 'por', 'sus', 'mas', 'más', 'sin', 'ser', 'cual',
  'cuales', 'donde', 'cuando', 'porque', 'quiero', 'puedo', 'puedes', 'tengo', 'hacer',
]);

/** Minúsculas sin diacríticos: "Eólica" → "eolica" (ruteo robusto a tildes). */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function terms(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

/** Mejor agente para un texto + su puntaje (solapamiento de términos). */
export function bestAgentFor(text: string): { agent: AgentDefinition; score: number } | null {
  const words = terms(text);
  if (words.length === 0) return null;
  let best: AgentDefinition | null = null;
  let bestScore = 0;
  for (const a of agentList) {
    if (a.status !== 'activo') continue;
    const hay = fold(`${a.specialty} ${a.description}`);
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best ? { agent: best, score: bestScore } : null;
}

/** Directorio compacto para el planning de GENESUS. */
export function buildDirectory(brief: string): string {
  const words = terms(brief);
  const scored = agentList.map((a) => {
    const hay = fold(`${a.specialty} ${a.description}`);
    let score = 0;
    for (const w of words) if (hay.includes(w)) score++;
    return { a, score };
  });
  const top = scored
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, 36)
    .map((s) => s.a);
  const covered = new Set(top.map((a) => a.code));
  for (const div of divisionList) {
    if (!top.some((a) => a.divisionCode === div.code)) {
      const first = agentList.find((a) => a.divisionCode === div.code);
      if (first && !covered.has(first.code)) top.push(first);
    }
  }
  return top.map((a) => `${a.code} — ${a.specialty} (${a.description})`).join('\n');
}
