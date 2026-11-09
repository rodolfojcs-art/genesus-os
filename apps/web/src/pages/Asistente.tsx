import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  streamAssistant,
  pcStatus,
  pcAgentRun,
  pcRun,
  readUpload,
  listArtifacts,
  openArtifact,
  getBriefing,
  listUndo,
  doUndo,
  listRoutines,
  createRoutine,
  deleteRoutine,
  runRoutine,
  diskStatus,
  diskIndex,
  diskSearch,
  type Citation,
  type CouncilMember,
  type ReasoningMode,
  type PcAgentResult,
  type Artifact,
} from '../api';
import { useVoice, voiceSupported } from '../lib/voice';
import { Empty, Pill, Spinner } from '../components/ui';

interface Conversation {
  id: string;
  title: string;
  updated_at: string;
}
interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  meta: { department?: string; grounded?: boolean; citations?: Citation[] };
  created_at: string;
}
interface MemoryItem {
  id: string;
  title: string | null;
  content: string;
  status: string;
  created_at: string;
}
interface QuestionItem {
  id: string;
  question: string;
  department_code: string | null;
  relevance: string;
  created_at: string;
}
interface Watcher {
  id: string;
  query: string;
  interval_min: number;
  status: string;
}
interface NotificationItem {
  id: string;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
}
interface GbrainStatus {
  available: boolean;
  pages: number;
  chunks: number;
  embeddingCoveragePct: number;
  aiEnabled: boolean;
}
interface GbrainHit {
  score: number;
  slug: string;
  title: string;
}
interface BrainInventory {
  mode: ReasoningMode;
  brains: Array<{ provider: string; label?: string; model: string; available: boolean; cost: 'pago' | 'gratis' }>;
}

/** Mensaje en vuelo (streaming) que se muestra sobre los persistidos. */
interface LiveTurn {
  question: string;
  answer: string;
  department?: string;
  grounded?: boolean;
  status?: string;
  citations?: Citation[];
  council?: CouncilMember[];
  model?: string;
  streaming: boolean;
  error?: string;
  /** true si la conversación no se pudo guardar (memoria/Supabase no disponible). */
  unsaved?: boolean;
}

function Citations({ items }: { items: Citation[] }) {
  if (!items?.length) return null;
  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
        Fuentes ({items.length})
      </div>
      <ol className="list-decimal space-y-0.5 pl-5">
        {items.map((c, j) => (
          <li key={j} className="text-xs">
            <a className="text-teal hover:underline" href={c.url} target="_blank" rel="noreferrer">
              {c.title}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Bubble({
  role,
  children,
  meta,
}: {
  role: 'user' | 'assistant';
  children: React.ReactNode;
  meta?: React.ReactNode;
}) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-indigo px-4 py-2.5 text-sm text-white">
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-surface border border-line px-4 py-3 text-sm">
        {meta}
        <div className="whitespace-pre-wrap leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

export function Asistente() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [input, setInput] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState<null | 'memoria' | 'registro' | 'vigias' | 'gbrain' | 'cerebros' | 'pc' | 'artefactos' | 'deshacer' | 'rutinas' | 'disco'>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [newRoutine, setNewRoutine] = useState({ name: '', instruction: '', every: '' });
  const [diskFolder, setDiskFolder] = useState('');
  const [diskQuery, setDiskQuery] = useState('');
  const [diskMsg, setDiskMsg] = useState('');
  const [briefing, setBriefing] = useState<{ loading: boolean; text?: string; error?: string }>({ loading: false });
  const [reasoning, setReasoning] = useState<ReasoningMode>(() => {
    const saved = localStorage.getItem('genesus_reasoning');
    return saved === 'local' || saved === 'council' ? saved : 'auto';
  });
  // Control del PC
  const [pcInput, setPcInput] = useState('');
  const [pcBusy, setPcBusy] = useState(false);
  const [pcResult, setPcResult] = useState<PcAgentResult | null>(null);
  const [pcMsg, setPcMsg] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [newWatcher, setNewWatcher] = useState('');
  const [gbrainQuery, setGbrainQuery] = useState('');
  const [voiceMode, setVoiceMode] = useState(false);
  const [gender, setGender] = useState<'f' | 'm'>(
    () => (localStorage.getItem('genesus_voice_gender') as 'f' | 'm') || 'f',
  );
  const [rate, setRate] = useState<number>(() => Number(localStorage.getItem('genesus_voice_rate')) || 1);
  const [autoRead, setAutoRead] = useState<boolean>(() => localStorage.getItem('genesus_voice_autoread') === '1');
  const [voiceCfg, setVoiceCfg] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<Array<{ mediaType: string; data: string; preview: string }>>([]);
  const [docs, setDocs] = useState<Array<{ name: string; text: string; loading?: boolean }>>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const supportsVoice = voiceSupported();

  function fileToBase64(f: File): Promise<string> {
    return new Promise((res) => {
      const r = new FileReader();
      r.onload = () => {
        const s = String(r.result);
        res(s.slice(s.indexOf(',') + 1));
      };
      r.readAsDataURL(f);
    });
  }

  async function addImages(files: FileList | null) {
    if (!files) return;
    const next = [...images];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/') || next.length >= 4) continue;
      const dataUrl = await new Promise<string>((res) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.readAsDataURL(f);
      });
      next.push({ mediaType: f.type, data: dataUrl.slice(dataUrl.indexOf(',') + 1), preview: dataUrl });
    }
    setImages(next.slice(0, 4));
  }

  // Adjunta archivos/carpeta: sube y extrae su texto (docx/xlsx/pdf/txt…) para que GENESUS los lea.
  async function addDocs(files: FileList | null) {
    if (!files) return;
    const supported = /\.(docx|xlsx|pdf|txt|md|csv|json|pptx|html|xml|py|js|ts|env)$/i;
    const list = Array.from(files).filter((f) => supported.test(f.name)).slice(0, 10);
    for (const f of list) {
      setDocs((d) => [...d, { name: f.name, text: '', loading: true }]);
      try {
        const b64 = await fileToBase64(f);
        const r = await readUpload(f.name, b64);
        setDocs((d) => d.map((x) => (x.name === f.name && x.loading ? { name: f.name, text: r.text ?? `(${r.error ?? 'no legible'})` } : x)));
      } catch {
        setDocs((d) => d.map((x) => (x.name === f.name && x.loading ? { name: f.name, text: '(error al leer)' } : x)));
      }
    }
  }

  // El textarea crece con el contenido, hasta 1/3 de la pantalla (luego hace scroll).
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.floor(window.innerHeight / 3))}px`;
  }, [input]);

  const voice = useVoice((text) => {
    setInput(text);
    if (voiceMode) void send(text);
  });

  const speakOpts = () => ({ gender, rate, voice: gender === 'm' ? 'onyx' : 'nova' });
  const speakText = (text: string) => void voice.speak(text, undefined, speakOpts());

  function persistVoice(g: 'f' | 'm', r: number, auto: boolean) {
    localStorage.setItem('genesus_voice_gender', g);
    localStorage.setItem('genesus_voice_rate', String(r));
    localStorage.setItem('genesus_voice_autoread', auto ? '1' : '0');
  }

  function changeReasoning(m: ReasoningMode) {
    setReasoning(m);
    localStorage.setItem('genesus_reasoning', m);
  }

  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api<Conversation[]>('/api/conversations'),
  });
  const messages = useQuery({
    queryKey: ['messages', activeId],
    queryFn: () => api<Message[]>(`/api/conversations/${activeId}/messages`),
    enabled: Boolean(activeId),
  });

  // Drawer data
  const memory = useQuery({
    queryKey: ['assistant-memory', showArchived],
    queryFn: () => api<MemoryItem[]>(`/api/assistant/memory?archived=${showArchived ? '1' : '0'}`),
    enabled: drawer === 'gbrain',
  });
  const questions = useQuery({
    queryKey: ['assistant-questions'],
    queryFn: () => api<QuestionItem[]>('/api/assistant/questions'),
    enabled: drawer === 'registro',
  });
  const watchers = useQuery({
    queryKey: ['watchers'],
    queryFn: () => api<Watcher[]>('/api/watchers'),
    enabled: drawer === 'vigias',
  });
  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotificationItem[]>('/api/notifications'),
    refetchInterval: 60_000,
  });
  const unread = notifications.data?.filter((n) => !n.read).length ?? 0;

  const gbrainStatus = useQuery({
    queryKey: ['gbrain-status'],
    queryFn: () => api<GbrainStatus>('/api/gbrain/status'),
    enabled: drawer === 'gbrain',
  });
  const brains = useQuery({
    queryKey: ['brains'],
    queryFn: () => api<BrainInventory>('/api/models'),
    refetchInterval: 30_000,
  });
  const pcEnabled = useQuery({ queryKey: ['pc-status'], queryFn: pcStatus });
  const artifacts = useQuery({
    queryKey: ['artifacts'],
    queryFn: () => listArtifacts().then((r) => r.artifacts),
    enabled: drawer === 'artefactos',
  });
  const undoList = useQuery({
    queryKey: ['undo'],
    queryFn: () => listUndo().then((r) => r.actions),
    enabled: drawer === 'deshacer',
  });
  const routines = useQuery({
    queryKey: ['routines'],
    queryFn: () => listRoutines().then((r) => r.routines),
    enabled: drawer === 'rutinas',
  });
  const disk = useQuery({ queryKey: ['disk-status'], queryFn: diskStatus, enabled: drawer === 'disco' });
  const diskResults = useQuery({
    queryKey: ['disk-search', diskQuery],
    queryFn: () => diskSearch(diskQuery).then((r) => r.hits),
    enabled: drawer === 'disco' && diskQuery.trim().length >= 2,
  });

  async function loadBriefing() {
    setBriefing({ loading: true });
    try {
      const b = await getBriefing();
      setBriefing({ loading: false, text: b.text, error: b.error });
    } catch (e) {
      setBriefing({ loading: false, error: e instanceof Error ? e.message : 'error' });
    }
  }

  async function runPcAgent(text?: string) {
    const q = (text ?? pcInput).trim();
    if (!q || pcBusy) return;
    setPcBusy(true);
    setPcMsg('');
    setPcResult(null);
    setPcInput('');
    try {
      setPcResult(await pcAgentRun(q));
    } catch (e) {
      setPcMsg(e instanceof Error ? e.message : 'Error del agente del PC');
    } finally {
      setPcBusy(false);
    }
  }

  async function confirmPcCommand(command: string) {
    setPcMsg('Ejecutando…');
    try {
      const r = await pcRun(command, true);
      setPcMsg(r.executed ? `✅ Ejecutado (code ${r.code ?? 0}).${r.stdout ? ' ' + r.stdout.slice(0, 200) : ''}` : `No se ejecutó: ${r.reason ?? ''}`);
      setPcResult((prev) => (prev ? { ...prev, pending: prev.pending.filter((p) => p.command !== command) } : prev));
    } catch (e) {
      setPcMsg(e instanceof Error ? e.message : 'Error al ejecutar');
    }
  }
  const gbrainResults = useQuery({
    queryKey: ['gbrain-search', gbrainQuery],
    queryFn: () => api<GbrainHit[]>(`/api/gbrain/search?q=${encodeURIComponent(gbrainQuery)}`),
    enabled: drawer === 'gbrain' && gbrainQuery.trim().length >= 2,
  });

  const createWatcher = useMutation({
    mutationFn: (query: string) =>
      api('/api/watchers', { method: 'POST', body: JSON.stringify({ query, intervalMin: 360 }) }),
    onSuccess: () => {
      setNewWatcher('');
      void qc.invalidateQueries({ queryKey: ['watchers'] });
    },
  });
  const delWatcher = useMutation({
    mutationFn: (id: string) => api(`/api/watchers/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['watchers'] }),
  });
  const runWatchers = useMutation({
    mutationFn: () => api('/api/watchers/run', { method: 'POST' }),
    onSuccess: () =>
      setTimeout(() => void qc.invalidateQueries({ queryKey: ['notifications'] }), 4000),
  });
  const readNotif = useMutation({
    mutationFn: (id: string) => api(`/api/notifications/${id}/read`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const archive = useMutation({
    mutationFn: (id: string) => api(`/api/assistant/memory/${id}/archive`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['assistant-memory'] }),
  });
  const delConv = useMutation({
    mutationFn: (id: string) => api(`/api/conversations/${id}`, { method: 'DELETE' }),
    onSuccess: (_d, id) => {
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      if (activeId === id) setActiveId(null);
    },
  });

  // Auto-scroll al fondo cuando llegan mensajes o streaming
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.data, live?.answer, activeId]);

  function newConversation() {
    setActiveId(null);
    setLive(null);
    setInput('');
  }

  async function send(textArg?: string) {
    const hasImgs = images.length > 0;
    const readyDocs = docs.filter((d) => !d.loading && d.text);
    const hasDocs = readyDocs.length > 0;
    let q = (textArg ?? input).trim();
    if ((!q && !hasImgs && !hasDocs) || busy) return;
    if (!q && hasImgs) q = 'Analiza esta imagen y descríbela con precisión.';
    if (!q && hasDocs) q = 'Analiza y resume estos archivos adjuntos.';
    if (voice.listening) voice.stopListening();
    const sentImages = images.map((i) => ({ mediaType: i.mediaType, data: i.data }));
    // El texto de los archivos adjuntos viaja como contexto de la pregunta.
    const docContext = hasDocs
      ? readyDocs.map((d) => `--- ARCHIVO ADJUNTO: ${d.name} ---\n${d.text}`).join('\n\n') + '\n\n'
      : '';
    const displayQ = q + (hasDocs ? ` 📎${readyDocs.length}` : '');
    const sendQ = docContext + q;
    setInput('');
    setImages([]);
    setDocs([]);
    setBusy(true);

    // Asegura una conversación activa (crea una si es nueva). Si falla (p.ej. la
    // memoria/Supabase no responde), NO abortamos la pregunta: seguimos sin
    // persistencia y lo avisamos, en vez de que el chat "desaparezca" en silencio.
    let convId = activeId;
    let unsaved = false;
    if (!convId) {
      try {
        const c = await api<Conversation>('/api/conversations', { method: 'POST' });
        convId = c.id;
        setActiveId(convId);
        await qc.invalidateQueries({ queryKey: ['conversations'] });
      } catch (e) {
        unsaved = true;
        console.error('No se pudo crear la conversación:', e);
      }
    }

    let full = '';
    setLive({ question: displayQ, answer: '', streaming: true, unsaved });
    await streamAssistant(
      sendQ,
      convId,
      {
        onMeta: (m) => setLive((l) => (l ? { ...l, department: m.department.code, grounded: m.grounded } : l)),
        onStatus: (t) => setLive((l) => (l ? { ...l, status: t } : l)),
        onCouncil: (members) => setLive((l) => (l ? { ...l, council: members } : l)),
        onDelta: (t) => {
          full += t;
          setLive((l) => (l ? { ...l, status: undefined, answer: l.answer + t } : l));
        },
        onDone: (fin) => {
          setLive((l) => (l ? { ...l, streaming: false, citations: fin.citations, model: fin.model } : l));
          if (convId) {
            void qc.invalidateQueries({ queryKey: ['messages', convId] });
            void qc.invalidateQueries({ queryKey: ['conversations'] });
          }
          void qc.invalidateQueries({ queryKey: ['assistant-memory'] });
          // Voz: en modo conversación habla y vuelve a escuchar; si solo está
          // la auto-lectura activa, lee la respuesta sin reanudar el micrófono.
          if (full.trim() && (voiceMode || autoRead)) {
            void voice.speak(
              full,
              () => {
                if (voiceMode) voice.startListening();
              },
              speakOpts(),
            );
          }
          // Solo limpiamos el turno "en vivo" si quedó persistido (los mensajes
          // guardados lo mostrarán en su lugar). Sin persistencia, lo dejamos
          // visible — de lo contrario el chat "desaparece" de la pantalla.
          if (convId) setTimeout(() => setLive(null), 400);
        },
        onError: (msg) => setLive((l) => (l ? { ...l, streaming: false, error: msg } : l)),
      },
      { voice: voiceMode, mode: reasoning, images: sentImages, attached: hasDocs },
    );
    setBusy(false);
  }

  function toggleVoiceMode() {
    const next = !voiceMode;
    setVoiceMode(next);
    if (next) voice.startListening();
    else {
      voice.stopListening();
      voice.stopSpeaking();
    }
  }

  const persisted = messages.data ?? [];
  const empty = !activeId && !live;

  return (
    <div className="relative flex h-[calc(100vh-88px)] gap-3">
      {/* ───────── Barra lateral (20%): solo chats recientes + menú al pie ───────── */}
      <aside className="relative flex w-1/5 min-w-[190px] shrink-0 flex-col rounded-card border border-line bg-surface">
        {/* Nueva conversación */}
        <div className="p-3 pb-2">
          <button className="btn-primary w-full justify-center !py-2 text-sm" onClick={newConversation}>
            + Nueva conversación
          </button>
        </div>

        {/* Recientes (única sección permanente) */}
        <div className="px-3 pb-1 pt-1">
          <span className="font-mono text-[10px] uppercase tracking-wide text-muted">Recientes</span>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {conversations.isLoading && <Spinner />}
          {conversations.data?.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-muted">Aún no hay conversaciones.</p>
          )}
          {conversations.data?.map((c) => (
            <div
              key={c.id}
              className={`group mb-0.5 flex items-center gap-1 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                activeId === c.id ? 'bg-indigo-soft text-indigo' : 'hover:bg-surface2'
              }`}
            >
              <button className="flex-1 truncate text-left" onClick={() => { setActiveId(c.id); setLive(null); }}>
                {c.title}
              </button>
              <button
                className="opacity-0 group-hover:opacity-100 font-mono text-[11px] text-muted hover:text-rose"
                onClick={() => delConv.mutate(c.id)}
                title="Eliminar"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        {/* Pie "activa": abre hacia arriba el menú de herramientas */}
        <div className="relative border-t border-line">
          {toolsOpen && (
            <div className="absolute bottom-full left-2 right-2 mb-1 max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-2xl">
              {/* Navegación: las páginas que antes vivían en la barra superior */}
              {([
                { to: '/command-center', icon: '🏛', label: 'Command Center' },
                { to: '/boveda', icon: '📚', label: 'Bóveda' },
                { to: '/misiones', icon: '🎯', label: 'Misiones' },
                { to: '/producto', icon: '📦', label: 'Producto' },
                { to: '/finanzas', icon: '💰', label: 'Finanzas' },
                { to: '/config', icon: '🔧', label: 'Configuración' },
              ] as Array<{ to: string; icon: string; label: string }>).map((n) => (
                <button
                  key={n.to}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface2"
                  onClick={() => { navigate(n.to); setToolsOpen(false); }}
                >
                  <span className="w-5 text-center text-base leading-none">{n.icon}</span>
                  {n.label}
                </button>
              ))}
              <div className="my-1 border-t border-line" />
              {([
                { key: 'gbrain', icon: '🧠', label: 'Memoria' },
                { key: 'registro', icon: '📋', label: 'Registro' },
                { key: 'vigias', icon: '👁', label: 'Vigías', badge: unread },
                { key: 'artefactos', icon: '📁', label: 'Artefactos' },
                { key: 'rutinas', icon: '🔁', label: 'Rutinas' },
                { key: 'disco', icon: '🔎', label: 'Buscar en disco' },
                { key: 'deshacer', icon: '↩️', label: 'Deshacer' },
                { key: 'cerebros', icon: '⚙', label: 'Cerebros' },
                ...(pcEnabled.data?.enabled ? [{ key: 'pc' as const, icon: '🖥', label: 'Mi PC' }] : []),
              ] as Array<{ key: NonNullable<typeof drawer>; icon: string; label: string; badge?: number }>).map((t) => (
                <button
                  key={t.key}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors ${
                    drawer === t.key ? 'bg-indigo-soft text-indigo' : 'text-ink hover:bg-surface2'
                  }`}
                  onClick={() => { setDrawer(drawer === t.key ? null : t.key); setToolsOpen(false); }}
                >
                  <span className="w-5 text-center text-base leading-none">{t.icon}</span>
                  {t.label}
                  {t.badge ? (
                    <span className="ml-auto grid h-4 min-w-4 place-items-center rounded-full bg-rose px-1 text-[9px] font-bold text-white">
                      {t.badge}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
          <button
            className="flex w-full items-center gap-2 px-3 py-2.5 text-[11px] hover:bg-surface2"
            onClick={() => setToolsOpen((v) => !v)}
            title="Herramientas de GENESUS"
          >
            <span className="grid h-6 w-6 place-items-center rounded-md bg-indigo-soft font-display text-[11px] font-extrabold text-indigo">G</span>
            <span className="font-semibold">GENESUS</span>
            <span className="ml-auto flex items-center gap-1 font-mono text-teal">
              <span className="h-[6px] w-[6px] animate-pulse rounded-full bg-teal" />activa
              {unread > 0 && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-rose" />}
            </span>
            <span className="ml-1 text-muted">{toolsOpen ? '▾' : '▴'}</span>
          </button>
        </div>
      </aside>

      {/* ───────── Centro: conversación completa + input ───────── */}
      <section className="flex min-w-0 flex-1 flex-col rounded-card border border-line bg-bg">
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {empty && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <h2 className="font-display text-2xl font-extrabold">GENESUS Personal</h2>
              <p className="mt-2 max-w-md text-sm text-muted">
                Tu IA personal con memoria permanente, búsqueda web con fuentes, ejecución de código y
                vigías proactivos. Escribe abajo para empezar.
              </p>
              <button
                className="btn-primary mt-5 !py-2 text-sm"
                onClick={() => void loadBriefing()}
                disabled={briefing.loading}
              >
                {briefing.loading ? 'Preparando tu briefing…' : '📰 Briefing de hoy (noticias en vivo)'}
              </button>
              {briefing.error && <p className="mt-3 text-xs text-rose">{briefing.error}</p>}
              {briefing.text && (
                <div className="mt-4 max-h-[52vh] w-full max-w-2xl overflow-y-auto whitespace-pre-wrap rounded-2xl border border-line bg-surface px-5 py-4 text-left text-sm leading-relaxed">
                  {briefing.text}
                </div>
              )}
            </div>
          )}

          {activeId && messages.isLoading && <Spinner />}

          {persisted.map((m) => (
            <Bubble
              key={m.id}
              role={m.role}
              meta={
                m.role === 'assistant' ? (
                  <div className="mb-1 flex items-center gap-2 font-mono text-[10px] text-muted">
                    {m.meta.department && <span className="text-indigo">{m.meta.department}</span>}
                    {m.meta.grounded && <Pill value="con fuentes" />}
                    {supportsVoice && (
                      <button
                        className="ml-auto rounded px-1 text-sm hover:bg-surface2"
                        title="Leer en voz alta"
                        onClick={() => speakText(m.content)}
                      >
                        🔊
                      </button>
                    )}
                  </div>
                ) : undefined
              }
            >
              {m.content}
              {m.role === 'assistant' && m.meta.citations && <Citations items={m.meta.citations} />}
            </Bubble>
          ))}

          {/* Turno en vivo (streaming) */}
          {live && (
            <>
              <Bubble role="user">{live.question}</Bubble>
              <Bubble
                role="assistant"
                meta={
                  live.department || live.council || live.model || live.unsaved ? (
                    <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted">
                      {live.department && <span className="text-indigo">{live.department}</span>}
                      {live.grounded && <Pill value="con fuentes" />}
                      {live.unsaved && (
                        <span className="rounded-full bg-[#B07F12]/15 px-1.5 py-0.5 text-[#B07F12]" title="La memoria no respondió: esta respuesta no quedó guardada">
                          ⚠ sin guardar
                        </span>
                      )}
                      {live.council?.map((c) => (
                        <span
                          key={c.model}
                          className={`rounded-full px-1.5 py-0.5 ${c.ok ? 'bg-teal/15 text-teal' : 'bg-surface2 text-muted line-through'}`}
                          title={`${c.provider} · ${c.latencyMs} ms`}
                        >
                          {c.provider}
                        </span>
                      ))}
                      {live.model && !live.streaming && <span className="opacity-70">via {live.model}</span>}
                    </div>
                  ) : undefined
                }
              >
                {live.error ? (
                  <span className="text-rose">{live.error}</span>
                ) : live.answer ? (
                  <>
                    {live.answer}
                    {live.streaming && <span className="animate-pulse text-indigo">▋</span>}
                    {live.citations && <Citations items={live.citations} />}
                  </>
                ) : (
                  <span className="text-muted">{live.status ?? 'Pensando…'}</span>
                )}
              </Bubble>
              {live.unsaved && !live.streaming && (
                <p className="text-center text-[11px] text-[#B07F12]">
                  ⚠ No se pudo guardar esta conversación (memoria no disponible). La respuesta se ve pero no
                  quedará en tu historial — revisa tu conexión e inténtalo de nuevo en un momento.
                </p>
              )}
            </>
          )}
        </div>

        {/* Input siempre disponible */}
        <div className="border-t border-line p-3">
          {supportsVoice && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <button
                onClick={toggleVoiceMode}
                className={`btn !py-1.5 text-xs ${voiceMode ? 'bg-teal text-white' : 'btn-ghost'}`}
                title="Conversación de voz manos libres: hablas y GENESUS te responde con voz"
              >
                {voiceMode ? '● Conversación de voz activa' : '🎙️ Modo conversación'}
              </button>
              <label className="flex items-center gap-1 text-[11px] text-muted" title="Lee en voz alta toda respuesta del chat">
                <input
                  type="checkbox"
                  checked={autoRead}
                  onChange={(e) => {
                    setAutoRead(e.target.checked);
                    persistVoice(gender, rate, e.target.checked);
                  }}
                />
                auto-leer
              </label>
              <button
                className="rounded-full px-2 py-1 text-[11px] font-semibold text-muted hover:bg-surface2"
                onClick={() => setVoiceCfg(!voiceCfg)}
                title="Ajustes de voz"
              >
                ⚙ voz
              </button>
              {voiceCfg && (
                <span className="flex items-center gap-2 rounded-full bg-surface2 px-2.5 py-1 text-[11px]">
                  <button
                    className={`rounded-full px-2 py-0.5 font-semibold ${gender === 'f' ? 'bg-indigo text-white' : 'text-muted'}`}
                    onClick={() => { setGender('f'); persistVoice('f', rate, autoRead); }}
                  >
                    ♀ Femenina
                  </button>
                  <button
                    className={`rounded-full px-2 py-0.5 font-semibold ${gender === 'm' ? 'bg-indigo text-white' : 'text-muted'}`}
                    onClick={() => { setGender('m'); persistVoice('m', rate, autoRead); }}
                  >
                    ♂ Masculina
                  </button>
                  <span className="text-muted">vel.</span>
                  <select
                    className="rounded bg-surface px-1 py-0.5"
                    value={rate}
                    onChange={(e) => { const r = Number(e.target.value); setRate(r); persistVoice(gender, r, autoRead); }}
                  >
                    <option value={0.85}>lenta</option>
                    <option value={1}>normal</option>
                    <option value={1.15}>rápida</option>
                    <option value={1.3}>muy rápida</option>
                  </select>
                  <button className="text-indigo hover:underline" onClick={() => speakText('Hola Rodolfo, así sueno con esta configuración de voz.')}>
                    probar
                  </button>
                </span>
              )}
              {voice.listening && (
                <span className="flex items-center gap-1 font-mono text-[11px] text-teal">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-teal" /> escuchando…
                </span>
              )}
              {voice.speaking && (
                <span className="flex items-center gap-2 font-mono text-[11px] text-indigo">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-indigo" /> GENESUS hablando…
                  <button className="underline hover:text-rose" onClick={voice.stopSpeaking}>
                    detener
                  </button>
                </span>
              )}
            </div>
          )}
          {/* Selector de cerebro: Auto (todos) · Local (Ollama) · Concilio (se evalúan entre sí) */}
          <div className="mb-2 flex items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wide text-muted">Cerebro</span>
            <div className="flex gap-0.5 rounded-full bg-surface2 p-0.5">
              {([
                ['auto', 'Auto', 'Usa todos tus cerebros: elige el mejor disponible y encadena respaldos'],
                ['local', 'Local', 'Solo Ollama en tu equipo — offline, sin costo, privado'],
                ['council', 'Concilio', 'Varios cerebros responden, se evalúan entre sí y se entrega la mejor'],
              ] as const).map(([m, label, tip]) => (
                <button
                  key={m}
                  title={tip}
                  onClick={() => changeReasoning(m)}
                  className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-colors ${
                    reasoning === m ? 'bg-indigo text-white' : 'text-muted hover:text-ink'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {/* Adjuntos: imágenes (miniaturas) + documentos (chips) */}
          {(images.length > 0 || docs.length > 0) && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {images.map((img, i) => (
                <div key={`img${i}`} className="relative h-16 w-16 overflow-hidden rounded-lg border border-line">
                  <img src={img.preview} alt="adjunto" className="h-full w-full object-cover" />
                  <button
                    className="absolute right-0.5 top-0.5 grid h-4 w-4 place-items-center rounded-full bg-black/60 text-[10px] text-white"
                    onClick={() => setImages(images.filter((_, j) => j !== i))}
                    title="Quitar"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {docs.map((d, i) => (
                <span key={`doc${i}`} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2 py-1 text-[11px]">
                  <span>{d.loading ? '⏳' : '📄'}</span>
                  <span className="max-w-[140px] truncate">{d.name}</span>
                  <button className="text-muted hover:text-rose" onClick={() => setDocs(docs.filter((_, j) => j !== i))} title="Quitar">✕</button>
                </span>
              ))}
            </div>
          )}
          <div className="relative flex items-end gap-2">
            {/* Inputs ocultos: imagen · archivo · carpeta */}
            <input ref={imgRef} type="file" accept="image/*" multiple className="hidden"
              onChange={(e) => { void addImages(e.target.files); e.target.value = ''; }} />
            <input ref={fileRef} type="file" accept=".docx,.xlsx,.pdf,.pptx,.txt,.md,.csv,.json,.html,.xml,.py,.js,.ts" multiple className="hidden"
              onChange={(e) => { void addDocs(e.target.files); e.target.value = ''; }} />
            <input ref={folderRef} type="file" className="hidden"
              // @ts-expect-error webkitdirectory permite elegir una carpeta completa
              webkitdirectory=""
              onChange={(e) => { void addDocs(e.target.files); e.target.value = ''; }} />

            {/* Menú "+" */}
            {plusOpen && (
              <div className="absolute bottom-full left-0 mb-2 w-40 rounded-xl border border-line bg-surface p-1 shadow-2xl">
                <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] hover:bg-surface2"
                  onClick={() => { setPlusOpen(false); imgRef.current?.click(); }}>🖼 Imagen</button>
                <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] hover:bg-surface2"
                  onClick={() => { setPlusOpen(false); fileRef.current?.click(); }}>📄 Archivo</button>
                <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] hover:bg-surface2"
                  onClick={() => { setPlusOpen(false); folderRef.current?.click(); }}>📁 Carpeta</button>
              </div>
            )}
            <button
              title="Adjuntar imagen, archivo o carpeta"
              onClick={() => setPlusOpen((v) => !v)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-surface2 text-2xl font-light text-ink transition-colors hover:bg-line"
            >
              +
            </button>
            {supportsVoice && (
              <button
                title={voice.listening ? 'Detener dictado' : 'Dictar por voz'}
                onClick={() => (voice.listening ? voice.stopListening() : voice.startListening())}
                className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-lg transition-colors ${
                  voice.listening ? 'bg-teal text-white' : 'bg-surface2 text-ink hover:bg-line'
                }`}
              >
                🎤
              </button>
            )}
            <textarea
              ref={taRef}
              className="input min-h-[44px] resize-none overflow-y-auto"
              style={{ maxHeight: '33vh' }}
              rows={1}
              placeholder="Escribe, habla o adjunta una imagen a GENESUS… (Enter envía, Shift+Enter salto de línea)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="btn-primary !py-2.5" disabled={busy || (!input.trim() && images.length === 0 && docs.length === 0)} onClick={() => void send()}>
              {busy ? '…' : 'Enviar'}
            </button>
          </div>
        </div>
      </section>

      {/* ───────── Panel lateral derecho (colapsable): herramientas ───────── */}
      {drawer && (
        <aside className="absolute right-0 top-0 z-40 flex h-full w-80 shrink-0 flex-col rounded-card border border-line bg-surface shadow-2xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h3 className="font-display text-sm font-bold">
              {drawer === 'vigias'
                ? 'Vigías'
                : drawer === 'registro'
                  ? 'Registro'
                  : drawer === 'gbrain'
                    ? 'Memoria (Obsidian + GBrain)'
                    : drawer === 'artefactos'
                      ? 'Artefactos — documentos generados'
                      : drawer === 'rutinas'
                        ? 'Rutinas programables'
                        : drawer === 'disco'
                          ? 'Buscar en tu disco (semántico)'
                          : drawer === 'deshacer'
                            ? 'Centro de deshacer'
                            : drawer === 'cerebros'
                        ? 'Cerebros — gateway multi-modelo'
                        : drawer === 'pc'
                          ? 'Mi PC — control con GENESUS'
                          : 'Memoria'}
            </h3>
            <button className="text-muted hover:text-ink" onClick={() => setDrawer(null)}>
              ✕
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {drawer === 'memoria' && (
              <>
                <label className="mb-3 flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                  incluir archivadas
                </label>
                {memory.isLoading && <Spinner />}
                {memory.data?.length === 0 && <Empty message="Memoria vacía." />}
                <div className="space-y-2">
                  {memory.data?.map((m) => (
                    <div key={m.id} className="rounded-xl border border-line px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold">{m.title ?? 'Memoria'}</span>
                        {m.status === 'activa' && (
                          <button className="font-mono text-[10px] text-muted hover:text-rose" onClick={() => archive.mutate(m.id)}>
                            archivar
                          </button>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-3 text-[11px] text-muted">{m.content}</p>
                    </div>
                  ))}
                </div>
              </>
            )}

            {drawer === 'registro' && (
              <>
                {questions.isLoading && <Spinner />}
                {questions.data?.length === 0 && <Empty message="Sin preguntas registradas." />}
                <div className="space-y-1.5">
                  {questions.data?.map((q) => (
                    <div key={q.id} className="border-b border-dashed border-line py-1.5 last:border-0">
                      <div className="text-xs">{q.question}</div>
                      <div className="font-mono text-[10px] text-muted">
                        {q.created_at.slice(5, 16).replace('T', ' ')}
                        {q.department_code ? ` · ${q.department_code}` : ''}
                        {q.relevance === 'irrelevante' ? ' · archivada' : ''}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {drawer === 'vigias' && (
              <>
                <p className="mb-2 text-xs text-muted">
                  GENESUS vigila estos temas solo y te avisa cuando hay novedad.
                </p>
                <div className="mb-3 flex gap-1.5">
                  <input
                    className="input text-xs"
                    placeholder="Ej. precio del dólar BCV…"
                    value={newWatcher}
                    onChange={(e) => setNewWatcher(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && newWatcher.trim().length >= 3 && createWatcher.mutate(newWatcher.trim())}
                  />
                  <button
                    className="btn-primary !px-3 !py-1 text-xs"
                    disabled={createWatcher.isPending || newWatcher.trim().length < 3}
                    onClick={() => createWatcher.mutate(newWatcher.trim())}
                  >
                    +
                  </button>
                </div>
                {watchers.data?.map((w) => (
                  <div key={w.id} className="mb-1.5 flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
                    <span className="flex-1 truncate text-xs">{w.query}</span>
                    <span className="font-mono text-[9px] text-muted">c/{Math.round(w.interval_min / 60)}h</span>
                    <button className="font-mono text-[10px] text-muted hover:text-rose" onClick={() => delWatcher.mutate(w.id)}>
                      ✕
                    </button>
                  </div>
                ))}
                <div className="mb-2 mt-3 flex items-center justify-between">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted">Notificaciones</span>
                  <button
                    className="font-mono text-[10px] text-indigo hover:underline disabled:opacity-40"
                    disabled={runWatchers.isPending}
                    onClick={() => runWatchers.mutate()}
                  >
                    {runWatchers.isPending ? 'revisando…' : 'revisar ahora'}
                  </button>
                </div>
                {notifications.data?.length === 0 && <Empty message="Sin novedades." />}
                <div className="space-y-2">
                  {notifications.data?.map((n) => (
                    <div
                      key={n.id}
                      className={`cursor-pointer rounded-xl border px-3 py-2 ${n.read ? 'border-line' : 'border-indigo bg-indigo-soft/40'}`}
                      onClick={() => !n.read && readNotif.mutate(n.id)}
                    >
                      <div className="flex items-center justify-between">
                        <span className="truncate text-xs font-semibold">{n.title}</span>
                        {!n.read && <span className="h-2 w-2 rounded-full bg-indigo" />}
                      </div>
                      <p className="mt-1 line-clamp-4 text-[11px] text-muted">{n.body}</p>
                    </div>
                  ))}
                </div>
              </>
            )}

            {drawer === 'gbrain' && (
              <>
                <p className="mb-2 text-xs text-muted">
                  Sistema de memoria unificado: <b>Obsidian</b> guarda (archivos .md durables) y <b>GBrain</b>
                  recupera (RAG híbrido + grafo). Todo lo importante se archiva aquí automáticamente.
                </p>

                {/* Memorias recientes (almacén Obsidian) */}
                <div className="mb-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-wide text-muted">Memorias</span>
                    <label className="flex items-center gap-1 text-[10px] text-muted">
                      <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
                      archivadas
                    </label>
                  </div>
                  {memory.isLoading && <Spinner />}
                  {memory.data?.length === 0 && <Empty message="Memoria vacía." />}
                  <div className="space-y-1.5">
                    {memory.data?.slice(0, 12).map((m) => (
                      <div key={m.id} className="rounded-lg border border-line px-2.5 py-1.5">
                        <div className="truncate text-[12px] font-semibold">{m.title ?? 'Memoria'}</div>
                        <div className="line-clamp-2 text-[11px] text-muted">{m.content}</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mb-2 border-t border-line pt-2 font-mono text-[10px] uppercase tracking-wide text-muted">Buscar en GBrain</div>

                {gbrainStatus.data && !gbrainStatus.data.available && (
                  <Empty message="GBrain no disponible (revisa GBRAIN_DIR/BUN_BIN)." />
                )}
                {gbrainStatus.data?.available && (
                  <div className="mb-3 rounded-xl border border-line px-3 py-2 font-mono text-[10.5px] text-muted">
                    <div>páginas: <b className="text-ink">{gbrainStatus.data.pages}</b> · fragmentos: <b className="text-ink">{gbrainStatus.data.chunks}</b></div>
                    <div>
                      IA/vector:{' '}
                      {gbrainStatus.data.aiEnabled ? (
                        <span className="text-teal">activo ({gbrainStatus.data.embeddingCoveragePct}%)</span>
                      ) : (
                        <span className="text-[#B07F12]">modo palabra clave (sin llaves)</span>
                      )}
                    </div>
                  </div>
                )}
                <input
                  className="input mb-3 text-xs"
                  placeholder="Buscar en el cerebro independiente…"
                  value={gbrainQuery}
                  onChange={(e) => setGbrainQuery(e.target.value)}
                />
                {gbrainResults.isLoading && <Spinner />}
                {gbrainQuery.length >= 2 && gbrainResults.data?.length === 0 && (
                  <Empty message="Sin coincidencias en GBrain." />
                )}
                <div className="space-y-2">
                  {gbrainResults.data?.map((h) => (
                    <div key={h.slug} className="rounded-xl border border-line px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold">{h.title || h.slug}</span>
                        <span className="font-mono text-[9px] text-teal">{h.score.toFixed(2)}</span>
                      </div>
                      <div className="font-mono text-[10px] text-muted">{h.slug}</div>
                    </div>
                  ))}
                </div>
                {!gbrainStatus.data?.aiEnabled && (
                  <p className="mt-3 text-[10.5px] text-muted">
                    Para la síntesis con IA y búsqueda vectorial de GBrain, configura sus llaves
                    (decisión tuya): <code className="text-indigo">gbrain config set</code>.
                  </p>
                )}
              </>
            )}

            {drawer === 'artefactos' && (
              <>
                <p className="mb-3 text-xs text-muted">
                  Documentos que GENESUS ha creado (Word/Excel/PowerPoint/PDF). Se abren en su app.
                </p>
                {artifacts.isLoading && <Spinner />}
                {artifacts.data?.length === 0 && <Empty message="Aún no hay documentos generados." />}
                <div className="space-y-2">
                  {artifacts.data?.map((a) => (
                    <button
                      key={a.path}
                      onClick={() => void openArtifact(a.path)}
                      className="flex w-full items-center gap-2 rounded-xl border border-line px-3 py-2 text-left hover:bg-surface2"
                      title="Abrir"
                    >
                      <span className="text-base">
                        {a.kind === 'docx' ? '📘' : a.kind === 'xlsx' ? '📗' : a.kind === 'pptx' ? '📙' : a.kind === 'pdf' ? '📕' : '📄'}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-semibold">{a.name}</span>
                        <span className="block font-mono text-[10px] text-muted">
                          {(a.bytes / 1024).toFixed(0)} KB · {new Date(a.modified).toLocaleDateString()}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
                <p className="mt-3 text-[10px] text-muted">Guardados en Documentos\GENESUS.</p>
              </>
            )}

            {drawer === 'rutinas' && (
              <>
                <p className="mb-3 text-xs text-muted">
                  Guarda tareas que GENESUS repite (ej. "organiza mis Descargas por tipo"). Ejecuta a demanda o cada N minutos.
                </p>
                <div className="mb-3 space-y-2 rounded-xl border border-line p-2.5">
                  <input className="input text-xs" placeholder="Nombre de la rutina"
                    value={newRoutine.name} onChange={(e) => setNewRoutine({ ...newRoutine, name: e.target.value })} />
                  <textarea className="input text-xs" rows={2} placeholder="Qué debe hacer (instrucción)"
                    value={newRoutine.instruction} onChange={(e) => setNewRoutine({ ...newRoutine, instruction: e.target.value })} />
                  <div className="flex items-center gap-2">
                    <input className="input w-24 text-xs" placeholder="cada N min"
                      value={newRoutine.every} onChange={(e) => setNewRoutine({ ...newRoutine, every: e.target.value.replace(/\D/g, '') })} />
                    <button className="btn-primary !py-1.5 text-xs"
                      disabled={!newRoutine.name.trim() || !newRoutine.instruction.trim()}
                      onClick={async () => {
                        await createRoutine(newRoutine.name, newRoutine.instruction, newRoutine.every ? Number(newRoutine.every) : undefined);
                        setNewRoutine({ name: '', instruction: '', every: '' });
                        await qc.invalidateQueries({ queryKey: ['routines'] });
                      }}>Guardar</button>
                  </div>
                </div>
                {routines.isLoading && <Spinner />}
                {routines.data?.length === 0 && <Empty message="Sin rutinas todavía." />}
                <div className="space-y-2">
                  {routines.data?.map((r) => (
                    <div key={r.id} className="rounded-xl border border-line px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold">{r.name}</span>
                        <span className="font-mono text-[9px] text-muted">{r.everyMinutes ? `cada ${r.everyMinutes}m` : 'a demanda'}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">{r.instruction}</p>
                      <div className="mt-1.5 flex gap-2">
                        <button className="btn-ghost !py-1 text-[11px]"
                          onClick={async () => { setDiskMsg(''); const res = await runRoutine(r.id); setDiskMsg(res.text?.slice(0, 200) ?? ''); }}>▶ Ejecutar</button>
                        <button className="font-mono text-[10px] text-muted hover:text-rose"
                          onClick={async () => { await deleteRoutine(r.id); await qc.invalidateQueries({ queryKey: ['routines'] }); }}>eliminar</button>
                      </div>
                    </div>
                  ))}
                </div>
                {diskMsg && <p className="mt-2 rounded-lg bg-surface2 px-2.5 py-1.5 text-[11px]">{diskMsg}</p>}
              </>
            )}

            {drawer === 'disco' && (
              <>
                <p className="mb-2 text-xs text-muted">
                  Indexa una carpeta y busca tus archivos por <b>significado</b> (Word/Excel/PDF/texto/código).
                </p>
                <div className="mb-2 flex gap-1.5">
                  <input className="input text-xs" placeholder="C:\\Users\\rodol\\Documents"
                    value={diskFolder} onChange={(e) => setDiskFolder(e.target.value)} />
                  <button className="btn-primary !px-2.5 !py-1.5 text-xs"
                    disabled={!diskFolder.trim()}
                    onClick={async () => {
                      setDiskMsg('Indexando… (puede tardar)');
                      // Barras normales: funcionan de forma fiable en el runtime empaquetado.
                      const r = await diskIndex(diskFolder.trim().replace(/\\/g, '/'));
                      setDiskMsg(r.ok ? `✓ Indexados ${r.indexed} de ${r.scanned} archivos.` : `Error: ${r.error}`);
                      await qc.invalidateQueries({ queryKey: ['disk-status'] });
                    }}>Indexar</button>
                </div>
                <div className="mb-2 font-mono text-[10px] text-muted">
                  {disk.data ? `${disk.data.files} archivos indexados${disk.data.enabled ? '' : ' · faltan embeddings'}` : ''}
                </div>
                <input className="input mb-3 text-xs" placeholder="Buscar por significado…"
                  value={diskQuery} onChange={(e) => setDiskQuery(e.target.value)} />
                {diskResults.isLoading && <Spinner />}
                <div className="space-y-2">
                  {diskResults.data?.map((h) => (
                    <button key={h.path} onClick={() => void openArtifact(h.path)}
                      className="block w-full rounded-xl border border-line px-3 py-2 text-left hover:bg-surface2" title="Abrir">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold">{h.name}</span>
                        <span className="font-mono text-[9px] text-teal">{h.score.toFixed(2)}</span>
                      </div>
                      <div className="line-clamp-2 text-[10.5px] text-muted">{h.snippet}</div>
                    </button>
                  ))}
                </div>
                {diskMsg && <p className="mt-2 rounded-lg bg-surface2 px-2.5 py-1.5 text-[11px]">{diskMsg}</p>}
              </>
            )}

            {drawer === 'deshacer' && (
              <>
                <p className="mb-3 text-xs text-muted">
                  Revierte con un clic lo que GENESUS editó o sobrescribió (usa los respaldos .bak).
                </p>
                {undoList.isLoading && <Spinner />}
                {undoList.data?.length === 0 && <Empty message="Nada que deshacer." />}
                <div className="space-y-2">
                  {undoList.data?.map((u) => (
                    <div key={u.id} className="rounded-xl border border-line px-3 py-2">
                      <div className="truncate text-xs font-semibold">{u.label}</div>
                      <div className="truncate font-mono text-[10px] text-muted">{new Date(u.ts).toLocaleString()}</div>
                      <button className="btn-ghost mt-1.5 !py-1 text-[11px]"
                        onClick={async () => { await doUndo(u.id); await qc.invalidateQueries({ queryKey: ['undo'] }); }}>
                        ↩️ Deshacer
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}

            {drawer === 'cerebros' && (
              <>
                <p className="mb-3 text-xs text-muted">
                  GENESUS razona con varios cerebros. El modo activo es{' '}
                  <b className="text-indigo">{reasoning}</b>. Cámbialo con el selector «Cerebro» bajo el chat.
                </p>
                {brains.isLoading && <Spinner />}
                <div className="space-y-2">
                  {brains.data?.brains.map((b) => (
                    <div key={b.provider} className="rounded-xl border border-line px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold">{b.label ?? b.provider}</span>
                        <span
                          className={`font-mono text-[9px] ${b.available ? 'text-teal' : 'text-muted'}`}
                        >
                          {b.available ? '● disponible' : '○ inactivo'}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between font-mono text-[10px] text-muted">
                        <span className="truncate">{b.model}</span>
                        <span className={b.cost === 'gratis' ? 'text-teal' : 'text-[#B07F12]'}>{b.cost}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 space-y-1.5 text-[10.5px] text-muted">
                  <p><b className="text-ink">Auto</b>: Claude en la nube; si falta llave o se agota el presupuesto, cae a Ollama local.</p>
                  <p><b className="text-ink">Local</b>: solo Ollama — offline, sin costo, tus datos no salen del equipo.</p>
                  <p><b className="text-ink">Concilio</b>: todos los cerebros vivos responden y Claude funde lo mejor de cada uno.</p>
                  <p className="pt-1">Para activar Grok, Gemini o Meta (Llama), pega su llave en <code className="text-indigo">apps/server/.env</code>.</p>
                </div>
              </>
            )}

            {drawer === 'pc' && (
              <>
                <p className="mb-2 text-xs text-muted">
                  Pídele a GENESUS acciones en tu PC y documentos. Lo de <b>solo lectura</b> se ejecuta solo; lo que
                  <b> modifica</b> el sistema pide tu confirmación; lo <b>catastrófico</b> se bloquea.
                  Puede <b>crear</b> Word/Excel/PowerPoint/PDF y <b>leer/analizar</b> tus .docx/.xlsx/.pdf.
                </p>
                <div className="flex gap-1.5">
                  <input
                    className="input text-xs"
                    placeholder="Ej: crea un Word con… · resume este PDF: C:\... · busca archivos duplicados en Descargas"
                    value={pcInput}
                    onChange={(e) => setPcInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void runPcAgent(); }}
                  />
                  <button className="btn-primary !px-3 !py-1.5 text-xs" disabled={pcBusy || !pcInput.trim()} onClick={() => void runPcAgent()}>
                    {pcBusy ? '…' : 'Ir'}
                  </button>
                </div>

                {pcMsg && <p className="mt-2 rounded-lg bg-surface2 px-2.5 py-1.5 text-[11px]">{pcMsg}</p>}

                {pcResult && (
                  <div className="mt-3 space-y-2">
                    <div className="rounded-xl border border-line px-3 py-2 text-xs whitespace-pre-wrap leading-relaxed">
                      {pcResult.text}
                    </div>
                    {pcResult.executed.length > 0 && (
                      <div>
                        <p className="mb-1 font-mono text-[10px] uppercase text-muted">Ejecutado</p>
                        {pcResult.executed.map((a, i) => (
                          <div key={i} className="mb-1 rounded-lg bg-surface2 px-2.5 py-1.5 font-mono text-[10px]">
                            <span className={a.ok ? 'text-teal' : 'text-rose'}>{a.ok ? '✓' : '✗'}</span> {a.tool}: {a.input}
                          </div>
                        ))}
                      </div>
                    )}
                    {pcResult.pending.length > 0 && (
                      <div>
                        <p className="mb-1 font-mono text-[10px] uppercase text-[#B07F12]">Requiere tu confirmación</p>
                        {pcResult.pending.map((p, i) => (
                          <div key={i} className="mb-1.5 rounded-lg border border-[#B07F12]/40 bg-[#B07F12]/10 px-2.5 py-2">
                            <code className="block break-all text-[10.5px]">{p.command}</code>
                            <button
                              className="btn-primary mt-1.5 !px-2.5 !py-1 text-[11px]"
                              onClick={() => void confirmPcCommand(p.command)}
                            >
                              Ejecutar
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <p className="mt-3 text-[10px] text-muted">
                  Todo lo ejecutado queda registrado en tu Bóveda (GENESUS/Acciones-PC.md).
                </p>
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
