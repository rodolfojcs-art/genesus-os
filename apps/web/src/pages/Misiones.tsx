import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, downloadFile, streamGenesusChat } from '../api';
import { Empty, ErrorBox, Panel, Pill, Spinner } from '../components/ui';

interface TaskSpec {
  id: string;
  department_id: string;
  title: string;
  objective: string;
  deliverable: string;
  depends_on: string[];
  model_tier: string;
  est_cost_usd: number;
}
interface Plan {
  mission_title: string;
  summary: string;
  tasks: TaskSpec[];
  est_total_cost_usd: number;
}
interface MissionSummary {
  id: string;
  title: string;
  status: string;
  costUsd: number;
  estCostUsd: number;
  tasks: number;
  createdAt: string;
}
interface ArtifactRef {
  id: string;
  kind: string;
  title: string;
  fileName: string;
}
interface TaskResult {
  task: TaskSpec;
  status: string;
  qaStatus: string;
  retries: number;
  costUsd: number;
  output: string;
}
interface MissionDetail {
  id: string;
  title: string;
  brief: string;
  status: string;
  plan: Plan | null;
  costUsd: number;
  events: Array<{ at: string; event: Record<string, unknown> & { type: string } }>;
  results: TaskResult[];
  synthesis: string;
  artifacts: ArtifactRef[];
  layers: string[][];
  error: string | null;
}

function GenesusChat() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function send() {
    if (!input.trim() || busy) return;
    setBusy(true);
    setError('');
    setOutput('');
    await streamGenesusChat(
      input,
      (delta) => setOutput((prev) => prev + delta),
      () => setBusy(false),
      (msg) => {
        setError(msg);
        setBusy(false);
      },
    );
  }

  return (
    <Panel title="Hablar con GENESUS" hint="Opus · streaming">
      <div className="flex gap-2">
        <input
          className="input"
          placeholder="Pregúntale a GENESUS cómo abordaría tu misión…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
        />
        <button className="btn-primary" disabled={busy} onClick={() => void send()}>
          {busy ? '…' : 'Enviar'}
        </button>
      </div>
      {error && <div className="mt-3"><ErrorBox message={error} /></div>}
      {output && (
        <pre className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl bg-surface2 p-4 font-body text-sm">
          {output}
        </pre>
      )}
    </Panel>
  );
}

function NewMissionForm({ onCreated }: { onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [budget, setBudget] = useState(5);

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/api/missions', {
        method: 'POST',
        body: JSON.stringify({ title, brief, budgetUsd: budget }),
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['missions'] });
      onCreated(data.id);
      setTitle('');
      setBrief('');
    },
  });

  return (
    <Panel title="Nueva misión" hint="GENESUS planifica · tú apruebas">
      <label className="label">Título</label>
      <input
        className="input mb-3"
        placeholder='Ej. "Microturbina eólica de 5 kW para zonas rurales"'
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label className="label">Brief de la misión</label>
      <textarea
        className="input mb-3 min-h-[90px]"
        placeholder="Describe qué quieres crear, analizar o producir…"
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
      />
      <label className="label">Presupuesto de la misión (USD)</label>
      <input
        className="input mb-4 w-32"
        type="number"
        min={1}
        max={500}
        value={budget}
        onChange={(e) => setBudget(Number(e.target.value))}
      />
      {create.isError && (
        <div className="mb-3">
          <ErrorBox message={(create.error as Error).message} />
        </div>
      )}
      <button
        className="btn-primary"
        disabled={create.isPending || title.length < 3 || brief.length < 10}
        onClick={() => create.mutate()}
      >
        {create.isPending ? 'GENESUS está planificando…' : 'Planificar misión'}
      </button>
    </Panel>
  );
}

function MissionDetailView({ id }: { id: string }) {
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['mission', id],
    queryFn: () => api<MissionDetail>(`/api/missions/${id}`),
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'en_ejecucion' || s === 'aprobada' ? 2500 : false;
    },
  });

  const approve = useMutation({
    mutationFn: () => api(`/api/missions/${id}/approve`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['mission', id] });
      void qc.invalidateQueries({ queryKey: ['missions'] });
    },
  });

  const m = detail.data;
  if (detail.isLoading) return <Spinner label="Cargando misión…" />;
  if (!m) return <Empty message="Selecciona una misión." />;

  return (
    <div className="space-y-4">
      <Panel
        title={m.title}
        hint={`costo real $${m.costUsd.toFixed(4)}`}
        actions={<Pill value={m.status} />}
      >
        <p className="mb-3 text-sm text-muted">{m.plan?.summary ?? m.brief}</p>
        {m.error && <ErrorBox message={m.error} />}
        {m.status === 'planificada' && m.plan && (
          <div className="flex items-center gap-4">
            <button
              className="btn-primary"
              disabled={approve.isPending}
              onClick={() => approve.mutate()}
            >
              Aprobar plan (${m.plan.est_total_cost_usd.toFixed(2)} estimado)
            </button>
            <span className="text-xs text-muted">Nada se ejecuta sin tu aprobación.</span>
          </div>
        )}
      </Panel>

      {m.plan && (
        <Panel title="Plan (DAG de tareas)" hint={`${m.plan.tasks.length} tareas · ${m.layers.length} capas`}>
          <div className="space-y-3">
            {m.layers.map((layer, i) => (
              <div key={i} className="flex flex-wrap items-stretch gap-2">
                <span className="self-center font-mono text-[10px] text-muted">capa {i + 1}</span>
                {layer.map((taskId) => {
                  const t = m.plan!.tasks.find((x) => x.id === taskId);
                  const r = m.results.find((x) => x.task.id === taskId);
                  if (!t) return null;
                  return (
                    <div key={taskId} className="min-w-[220px] flex-1 rounded-xl border border-line bg-surface2/60 p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] font-semibold text-indigo">
                          {t.id} · {t.department_id}
                        </span>
                        {r ? <Pill value={r.status} /> : <Pill value="pendiente" />}
                      </div>
                      <div className="mt-1 text-sm font-semibold">{t.title}</div>
                      <div className="mt-0.5 line-clamp-2 text-xs text-muted">{t.deliverable}</div>
                      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted">
                        <span>{t.model_tier}</span>
                        {r && <span>QA: {r.qaStatus} · ${r.costUsd.toFixed(3)}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {m.events.length > 0 && (
        <Panel title="Actividad de la red" hint="eventos del orquestador">
          <div className="max-h-56 space-y-1 overflow-y-auto font-mono text-[12px]">
            {[...m.events].reverse().map((e, i) => (
              <div key={i} className="flex gap-3 border-b border-dashed border-line py-1 last:border-0">
                <span className="text-muted">{e.at.slice(11, 19)}</span>
                <span className="text-indigo">{e.event.type}</span>
                <span className="truncate text-muted">
                  {'taskId' in e.event ? String(e.event.taskId) : ''}
                  {'feedback' in e.event ? ` — ${String(e.event.feedback).slice(0, 80)}` : ''}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {m.artifacts.length > 0 && (
        <Panel title="Entregables" hint="descargables">
          <div className="grid gap-2 md:grid-cols-2">
            {m.artifacts.map((a) => (
              <button
                key={a.id}
                className="flex items-center justify-between rounded-xl border border-line bg-surface2/50 px-4 py-2.5 text-left text-sm hover:border-indigo"
                onClick={() => void downloadFile(`/api/missions/${m.id}/artifacts/${a.id}`, a.fileName)}
              >
                <span className="truncate">{a.title}</span>
                <span className="ml-3 font-mono text-[10px] uppercase text-muted">{a.kind} ↓</span>
              </button>
            ))}
          </div>
        </Panel>
      )}

      {m.synthesis && (
        <Panel title="Síntesis ejecutiva de GENESUS" hint="Opus">
          <pre className="max-h-[480px] overflow-y-auto whitespace-pre-wrap font-body text-sm leading-relaxed">
            {m.synthesis}
          </pre>
        </Panel>
      )}
    </div>
  );
}

export function Misiones() {
  const [selected, setSelected] = useState<string | null>(null);
  const missions = useQuery({
    queryKey: ['missions'],
    queryFn: () => api<MissionSummary[]>('/api/missions'),
    refetchInterval: 8000,
  });

  return (
    <div className="space-y-5">
      <GenesusChat />
      <div className="grid items-start gap-5 lg:grid-cols-[380px,1fr]">
        <div className="space-y-4">
          <NewMissionForm onCreated={setSelected} />
          <Panel title="Misiones" hint={`${missions.data?.length ?? 0} en total`}>
            {missions.data?.length === 0 && <Empty message="Sin misiones todavía." />}
            <div className="space-y-1.5">
              {missions.data?.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSelected(m.id)}
                  className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                    selected === m.id ? 'border-indigo bg-indigo-soft/60' : 'border-line hover:bg-surface2'
                  }`}
                >
                  <Pill value={m.status} />
                  <span className="flex-1 truncate">{m.title}</span>
                </button>
              ))}
            </div>
          </Panel>
        </div>
        <div>
          {selected ? (
            <MissionDetailView id={selected} />
          ) : (
            <Empty message="Crea una misión o selecciona una de la lista para ver su plan, progreso y entregables." />
          )}
        </div>
      </div>
    </div>
  );
}
