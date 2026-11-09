import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { renderMarkdown } from '../lib/markdown';
import { Empty, Panel, Spinner } from '../components/ui';

interface TreeNode {
  name: string;
  path: string;
  type: 'folder' | 'note';
  children?: TreeNode[];
}
interface NoteContent {
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, string>;
  links: string[];
  backlinks: Array<{ path: string; title: string }>;
}
interface SearchHit {
  path: string;
  title: string;
  snippet: string;
}
interface GraphData {
  nodes: Array<{ id: string; title: string; group: string }>;
  edges: Array<{ source: string; target: string }>;
}

const GROUP_COLOR: Record<string, string> = {
  Memoria: '#00D4A0',
  Archivo: '#6B6A85',
  Notas: '#7B68FF',
};

function FolderTree({
  node,
  depth,
  onOpen,
  current,
}: {
  node: TreeNode;
  depth: number;
  onOpen: (path: string) => void;
  current: string | null;
}) {
  const [open, setOpen] = useState(depth < 2);
  if (node.type === 'note') {
    return (
      <button
        onClick={() => onOpen(node.path)}
        className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[13px] transition-colors ${
          current === node.path ? 'bg-indigo-soft text-indigo' : 'hover:bg-surface2'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        <span className="text-muted">¶</span>
        <span className="truncate">{node.name}</span>
      </button>
    );
  }
  return (
    <div>
      {node.path !== '' && (
        <button
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[13px] font-semibold hover:bg-surface2"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <span className="text-muted">{open ? '▾' : '▸'}</span>
          <span className="truncate">{node.name}</span>
        </button>
      )}
      {open &&
        node.children?.map((c) => (
          <FolderTree key={c.path} node={c} depth={node.path === '' ? depth : depth + 1} onOpen={onOpen} current={current} />
        ))}
    </div>
  );
}

function GraphView({ onOpen }: { onOpen: (path: string) => void }) {
  const graph = useQuery({ queryKey: ['vault-graph'], queryFn: () => api<GraphData>('/api/vault/graph') });
  const layout = useMemo(() => {
    const nodes = graph.data?.nodes ?? [];
    const R = 230;
    const cx = 300;
    const cy = 230;
    const pos = new Map<string, { x: number; y: number }>();
    nodes.forEach((n, i) => {
      const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      pos.set(n.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    });
    return pos;
  }, [graph.data]);

  if (graph.isLoading) return <Spinner />;
  if (!graph.data || graph.data.nodes.length === 0)
    return <Empty message="Aún no hay notas en la bóveda para graficar." />;

  return (
    <svg viewBox="0 0 600 460" className="w-full">
      {graph.data.edges.map((e, i) => {
        const a = layout.get(e.source);
        const b = layout.get(e.target);
        if (!a || !b) return null;
        return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#D9D6EA" strokeWidth={1} />;
      })}
      {graph.data.nodes.map((n) => {
        const p = layout.get(n.id);
        if (!p) return null;
        return (
          <g key={n.id} className="cursor-pointer" onClick={() => onOpen(n.id)}>
            <circle cx={p.x} cy={p.y} r={7} fill={GROUP_COLOR[n.group] ?? '#7B68FF'} />
            <text x={p.x} y={p.y - 11} textAnchor="middle" fontSize={9} fill="#6B6A85" fontFamily="JetBrains Mono">
              {n.title.length > 18 ? n.title.slice(0, 18) + '…' : n.title}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Boveda() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'nota' | 'grafo'>('nota');
  const previewRef = useRef<HTMLDivElement>(null);

  const tree = useQuery({ queryKey: ['vault-tree'], queryFn: () => api<TreeNode>('/api/vault/tree') });
  const note = useQuery({
    queryKey: ['vault-note', current],
    queryFn: () => api<NoteContent>(`/api/vault/note?path=${encodeURIComponent(current!)}`),
    enabled: Boolean(current),
  });
  const results = useQuery({
    queryKey: ['vault-search', search],
    queryFn: () => api<SearchHit[]>(`/api/vault/search?q=${encodeURIComponent(search)}`),
    enabled: search.length >= 2,
  });

  const save = useMutation({
    mutationFn: () =>
      api<NoteContent>('/api/vault/note', {
        method: 'POST',
        body: JSON.stringify({ path: current, content: draft }),
      }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['vault-note', current] });
      void qc.invalidateQueries({ queryKey: ['vault-graph'] });
    },
  });

  const create = useMutation({
    mutationFn: (title: string) =>
      api<NoteContent>('/api/vault/create', {
        method: 'POST',
        body: JSON.stringify({ folder: 'GENESUS/Notas', title }),
      }),
    onSuccess: (n) => {
      void qc.invalidateQueries({ queryKey: ['vault-tree'] });
      openNote(n.path);
    },
  });

  const archive = useMutation({
    mutationFn: (path: string) => api('/api/vault/archive', { method: 'POST', body: JSON.stringify({ path }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vault-tree'] });
      setCurrent(null);
    },
  });

  function openNote(path: string) {
    setCurrent(path);
    setEditing(false);
    setView('nota');
    setSearch('');
  }

  async function followWikilink(target: string) {
    const res = await api<{ path: string | null }>(`/api/vault/resolve?title=${encodeURIComponent(target)}`);
    if (res.path) openNote(res.path);
    else create.mutate(target);
  }

  // Click en [[wikilinks]] del preview
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains('wikilink')) {
        e.preventDefault();
        void followWikilink(t.dataset.wikilink ?? '');
      }
    };
    el.addEventListener('click', handler);
    return () => el.removeEventListener('click', handler);
  }, [note.data]);

  return (
    <div className="flex h-[calc(100vh-88px)] flex-col gap-3">
      <div className="flex shrink-0 items-end justify-between">
        <div>
          <h1 className="font-display text-xl font-extrabold">Bóveda</h1>
          <p className="text-xs text-muted">
            Tu conocimiento permanente, clon de Obsidian dentro de GENESUS — todo en tu servidor local.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className={`btn ${view === 'grafo' ? 'bg-indigo text-white' : 'btn-ghost'}`}
            onClick={() => setView(view === 'grafo' ? 'nota' : 'grafo')}
          >
            {view === 'grafo' ? 'Ver nota' : 'Grafo'}
          </button>
          <button
            className="btn-primary"
            onClick={() => {
              const title = window.prompt('Título de la nueva nota:');
              if (title) create.mutate(title);
            }}
          >
            + Nota
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* Izquierda 20%: árbol + búsqueda */}
        <div className="flex w-1/5 min-w-[200px] shrink-0 flex-col overflow-y-auto">
        <Panel title="Notas" hint="GENESUS Vault">
          <input
            className="input mb-3"
            placeholder="Buscar en la bóveda…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search.length >= 2 ? (
            <div className="space-y-1">
              {results.isLoading && <Spinner />}
              {results.data?.length === 0 && <Empty message="Sin coincidencias." />}
              {results.data?.map((h) => (
                <button
                  key={h.path}
                  onClick={() => openNote(h.path)}
                  className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-surface2"
                >
                  <div className="truncate text-[13px] font-semibold">{h.title}</div>
                  <div className="truncate font-mono text-[10px] text-muted">…{h.snippet}…</div>
                </button>
              ))}
            </div>
          ) : tree.isLoading ? (
            <Spinner />
          ) : (
            <div className="max-h-[560px] overflow-y-auto">
              {tree.data && <FolderTree node={tree.data} depth={0} onOpen={openNote} current={current} />}
            </div>
          )}
        </Panel>
        </div>

        {/* Derecha 80%: editor/grafo + conexiones */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
        {/* Editor / preview / grafo */}
        {view === 'grafo' ? (
          <Panel title="Grafo de conexiones" hint="enlaces [[wiki]] entre notas">
            <GraphView onOpen={openNote} />
          </Panel>
        ) : (
          <Panel
            title={note.data?.title ?? 'Selecciona una nota'}
            hint={current ?? ''}
            actions={
              current && (
                <div className="flex gap-2">
                  {editing ? (
                    <button className="btn-primary !py-1 text-xs" disabled={save.isPending} onClick={() => save.mutate()}>
                      Guardar
                    </button>
                  ) : (
                    <button
                      className="btn-ghost !py-1 text-xs"
                      onClick={() => {
                        setDraft(buildRaw(note.data));
                        setEditing(true);
                      }}
                    >
                      Editar
                    </button>
                  )}
                  <button
                    className="font-mono text-[10px] text-muted hover:text-rose"
                    onClick={() => current && archive.mutate(current)}
                  >
                    archivar
                  </button>
                </div>
              )
            }
          >
            {!current && <Empty message="Abre una nota del árbol o crea una nueva. Usa [[Nombre]] para enlazar ideas." />}
            {current && note.isLoading && <Spinner />}
            {current && note.data && !editing && (
              <div
                ref={previewRef}
                className="vault-prose max-h-[600px] overflow-y-auto"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(note.data.content) }}
              />
            )}
            {current && editing && (
              <textarea
                className="input min-h-[560px] font-mono text-[13px] leading-relaxed"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            )}
          </Panel>
        )}

        {/* Backlinks + enlaces salientes */}
        <Panel title="Conexiones" hint="backlinks">
          {!note.data && <Empty message="—" />}
          {note.data && (
            <>
              <div className="mb-3">
                <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
                  Enlazada desde ({note.data.backlinks.length})
                </div>
                {note.data.backlinks.length === 0 && <p className="text-xs text-muted">Ninguna nota enlaza aquí.</p>}
                {note.data.backlinks.map((b) => (
                  <button
                    key={b.path}
                    onClick={() => openNote(b.path)}
                    className="block w-full truncate rounded-lg px-2 py-1 text-left text-[13px] text-teal hover:bg-surface2"
                  >
                    ← {b.title}
                  </button>
                ))}
              </div>
              <div>
                <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted">
                  Enlaza a ({note.data.links.length})
                </div>
                {note.data.links.length === 0 && <p className="text-xs text-muted">Sin enlaces salientes.</p>}
                {note.data.links.map((l) => (
                  <button
                    key={l}
                    onClick={() => void followWikilink(l)}
                    className="block w-full truncate rounded-lg px-2 py-1 text-left text-[13px] text-indigo hover:bg-surface2"
                  >
                    → {l}
                  </button>
                ))}
              </div>
            </>
          )}
        </Panel>
        </div>
      </div>
    </div>
  );
}

/** Reconstruye el .md con frontmatter para editar. */
function buildRaw(note?: NoteContent): string {
  if (!note) return '';
  const fm = Object.entries(note.frontmatter);
  const head = fm.length ? `---\n${fm.map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n` : '';
  return head + note.content;
}
