import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Empty, ErrorBox, Panel, Pill, Spinner } from '../components/ui';

interface AgentSummary {
  code: string;
  divisionCode: string;
  specialty: string;
  description: string;
  modelTier: string;
  status: string;
}
interface AgentDetail extends AgentSummary {
  systemPrompt: string;
  subagents: Array<{ code: string; role: string; modelTier: string }>;
}
interface SearchResult {
  total: number;
  page: number;
  pageSize: number;
  items: AgentSummary[];
}
interface Division {
  code: string;
  name: string;
  color: string;
}

const DIVISION_COLORS: Record<string, string> = {
  ENRG: '#FFC040', ELEC: '#7B68FF', SCI: '#00D4A0', COMP: '#7B68FF', DSGN: '#F06292',
  MFG: '#FFC040', SUPL: '#00D4A0', COMM: '#F06292', FIN: '#FFC040', CORP: '#7B68FF',
};

function AgentDrawer({ code, onClose }: { code: string; onClose: () => void }) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['agent', code],
    queryFn: () => api<AgentDetail>(`/api/agents/${code}`),
  });
  const [prompt, setPrompt] = useState<string | null>(null);
  const [testPrompt, setTestPrompt] = useState('');
  const [testOutput, setTestOutput] = useState('');

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api(`/api/agents/${code}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent', code] });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const test = useMutation({
    mutationFn: () =>
      api<{ text: string; costUsd: number; model: string }>(`/api/agents/${code}/test`, {
        method: 'POST',
        body: JSON.stringify({ prompt: testPrompt }),
      }),
    onSuccess: (r) => setTestOutput(`[${r.model} · $${r.costUsd.toFixed(4)}]\n\n${r.text}`),
    onError: (e) => setTestOutput(`Error: ${(e as Error).message}`),
  });

  const a = detail.data;

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-ink/35 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {detail.isLoading && <Spinner />}
        {a && (
          <>
            <div className="mb-4 flex items-start justify-between">
              <div>
                <div className="font-mono text-sm font-semibold text-indigo">{a.code}</div>
                <h3 className="font-display text-lg font-extrabold">{a.specialty}</h3>
                <p className="text-xs text-muted">{a.description}</p>
              </div>
              <div className="flex items-center gap-2">
                <Pill value={a.status} />
                <button className="btn-ghost !px-3 !py-1" onClick={onClose}>
                  ✕
                </button>
              </div>
            </div>

            <div className="mb-4 flex gap-2">
              <button
                className="btn-ghost text-xs"
                onClick={() => save.mutate({ status: a.status === 'activo' ? 'inactivo' : 'activo' })}
              >
                {a.status === 'activo' ? 'Desactivar agente' : 'Activar agente'}
              </button>
            </div>

            <label className="label">System prompt (editable)</label>
            <textarea
              className="input mb-2 min-h-[180px] font-mono text-xs"
              value={prompt ?? a.systemPrompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <button
              className="btn-primary !py-1.5 text-xs"
              disabled={save.isPending || prompt === null || prompt === a.systemPrompt}
              onClick={() => prompt && save.mutate({ systemPrompt: prompt })}
            >
              Guardar prompt
            </button>

            <div className="mt-5 border-t border-line pt-4">
              <label className="label">Prueba individual (Sonnet, consume presupuesto)</label>
              <div className="flex gap-2">
                <input
                  className="input"
                  placeholder="Instrucción de prueba para este agente…"
                  value={testPrompt}
                  onChange={(e) => setTestPrompt(e.target.value)}
                />
                <button
                  className="btn-primary"
                  disabled={test.isPending || !testPrompt}
                  onClick={() => test.mutate()}
                >
                  {test.isPending ? '…' : 'Probar'}
                </button>
              </div>
              {testOutput && (
                <pre className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl bg-surface2 p-3 font-body text-xs">
                  {testOutput}
                </pre>
              )}
            </div>

            <div className="mt-5 border-t border-line pt-4">
              <label className="label">10 subagentes</label>
              <div className="divide-y divide-dashed divide-line">
                {a.subagents.map((s) => (
                  <div key={s.code} className="flex items-center gap-3 py-1.5 text-sm">
                    <span className="font-mono text-[11px] text-indigo">{s.code}</span>
                    <span className="flex-1">{s.role}</span>
                    <span
                      className={`rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold ${
                        s.modelTier === 'sonnet' ? 'bg-indigo-soft text-indigo' : 'bg-teal-soft text-[#089673]'
                      }`}
                    >
                      {s.modelTier.toUpperCase()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function Admin() {
  const [params, setParams] = useSearchParams();
  const division = params.get('division') ?? '';
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);

  const divisions = useQuery({ queryKey: ['divisions'], queryFn: () => api<Division[]>('/api/divisions') });
  const agents = useQuery({
    queryKey: ['agents', q, division, page],
    queryFn: () =>
      api<SearchResult>(
        `/api/agents?q=${encodeURIComponent(q)}&division=${division}&page=${page}&pageSize=24`,
      ),
  });

  const totalPages = agents.data ? Math.max(1, Math.ceil(agents.data.total / agents.data.pageSize)) : 1;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl font-extrabold">Administración de la red</h1>
        <p className="text-sm text-muted">
          Buscador de los 1,000 agentes: edición de prompts, activación y prueba individual.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs"
          placeholder="Buscar por código o especialidad…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <select
          className="input w-auto"
          value={division}
          onChange={(e) => {
            setParams(e.target.value ? { division: e.target.value } : {});
            setPage(1);
          }}
        >
          <option value="">Todas las divisiones</option>
          {divisions.data?.map((d) => (
            <option key={d.code} value={d.code}>
              {d.code} — {d.name}
            </option>
          ))}
        </select>
        <span className="ml-auto font-mono text-[11px] text-muted">
          {agents.data?.total.toLocaleString('es') ?? '…'} agentes encontrados
        </span>
      </div>

      {agents.isLoading && <Spinner />}
      {agents.isError && <ErrorBox message={(agents.error as Error).message} />}
      {agents.data?.items.length === 0 && <Empty message="Sin resultados." />}

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-4">
        {agents.data?.items.map((a) => (
          <button
            key={a.code}
            onClick={() => setSelected(a.code)}
            className="rounded-xl border border-line bg-surface p-3 text-left transition-all hover:-translate-y-0.5 hover:border-indigo"
          >
            <div className="flex items-center justify-between">
              <span
                className="font-mono text-[11.5px] font-semibold"
                style={{ color: DIVISION_COLORS[a.divisionCode] ?? 'var(--indigo)' }}
              >
                {a.code}
              </span>
              <span
                className={`h-2 w-2 rounded-full ${a.status === 'activo' ? 'bg-teal' : 'bg-line2'}`}
              />
            </div>
            <div className="mt-1 line-clamp-2 min-h-[34px] text-xs font-semibold">{a.specialty}</div>
            <div className="mt-1 font-mono text-[10px] text-muted">{a.modelTier} · 10 subagentes</div>
          </button>
        ))}
      </div>

      <div className="flex items-center justify-center gap-3 font-mono text-xs text-muted">
        <button className="btn-ghost !py-1 text-xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          ← Anterior
        </button>
        <span>
          página {page} / {totalPages}
        </span>
        <button
          className="btn-ghost !py-1 text-xs"
          disabled={page >= totalPages}
          onClick={() => setPage(page + 1)}
        >
          Siguiente →
        </button>
      </div>

      {selected && <AgentDrawer code={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
