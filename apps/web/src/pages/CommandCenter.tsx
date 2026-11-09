import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Empty, Kpi, Panel, Pill, Spinner } from '../components/ui';

interface Health {
  red: { divisions: number; agents: number; subagents: number };
  presupuesto: { limiteDiarioUsd: number; restanteUsd: number };
}
interface Division {
  code: string;
  name: string;
  color: string;
  description: string;
  agentes: number;
  subagentes: number;
}
interface MissionSummary {
  id: string;
  title: string;
  status: string;
  costUsd: number;
  tasks: number;
  createdAt: string;
}
interface Costs {
  gastadoHoyUsd: number;
  limiteUsd: number;
  llamadasHoy: number;
  porModelo: Array<{ model: string; llamadas: number; costUsd: number }>;
}

export function CommandCenter() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => api<Health>('/api/health') });
  const divisions = useQuery({
    queryKey: ['divisions'],
    queryFn: () => api<Division[]>('/api/divisions'),
  });
  const missions = useQuery({
    queryKey: ['missions'],
    queryFn: () => api<MissionSummary[]>('/api/missions'),
    refetchInterval: 10_000,
  });
  const costs = useQuery({
    queryKey: ['costs'],
    queryFn: () => api<Costs>('/api/costs/summary'),
    refetchInterval: 10_000,
  });

  const totalCalls = costs.data?.porModelo.reduce((s, m) => s + m.llamadas, 0) ?? 0;

  return (
    <div className="space-y-7">
      <div>
        <div className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-indigo">
          Genesus Technology LLC · genesustech.com
        </div>
        <h1 className="font-display text-4xl font-extrabold leading-tight">
          Una red de{' '}
          <span className="bg-gradient-to-r from-indigo to-teal bg-clip-text text-transparent">
            1,000 agentes
          </span>{' '}
          operando en español.
        </h1>
        <p className="mt-2 max-w-2xl text-muted">
          GENESUS descompone cada misión, activa los departamentos correctos y entrega artefactos
          terminados. Routing permanente: Opus para estrategia, Sonnet para producción, Haiku para QA.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi
          label="Agentes registrados"
          value={health.data?.red.agents.toLocaleString('es') ?? '—'}
          sub="en 10 divisiones"
          accent="var(--indigo)"
        />
        <Kpi
          label="Subagentes"
          value={health.data?.red.subagents.toLocaleString('es') ?? '—'}
          sub="10 por departamento"
          accent="var(--teal)"
        />
        <Kpi
          label="Misiones"
          value={missions.data?.length ?? '—'}
          sub={`${missions.data?.filter((m) => m.status === 'completada').length ?? 0} completadas`}
          accent="var(--gold)"
        />
        <Kpi
          label="Costo del día"
          value={`$${(costs.data?.gastadoHoyUsd ?? 0).toFixed(2)}`}
          sub={`límite $${(costs.data?.limiteUsd ?? 0).toFixed(0)} · ${costs.data?.llamadasHoy ?? 0} llamadas`}
          accent="var(--rose)"
        />
      </div>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-lg font-bold">Divisiones</h2>
          <span className="font-mono text-[11px] text-muted">
            10 divisiones · 100 agentes c/u · clic para explorar
          </span>
        </div>
        {divisions.isLoading && <Spinner />}
        <div className="grid grid-cols-2 gap-3.5 md:grid-cols-3 lg:grid-cols-5">
          {divisions.data?.map((d) => (
            <Link
              key={d.code}
              to={`/admin?division=${d.code}`}
              className="panel group p-4 transition-transform hover:-translate-y-0.5"
            >
              <div className="mb-2 flex items-center justify-between">
                <span
                  className="grid h-9 w-9 place-items-center rounded-xl font-display text-sm font-extrabold"
                  style={{ background: `${d.color}20`, color: d.color }}
                >
                  {d.code.slice(0, 2)}
                </span>
                <span className="font-mono text-[10px] text-teal">operativa</span>
              </div>
              <div className="font-display text-[15px] font-bold">{d.code}</div>
              <div className="mt-0.5 line-clamp-2 min-h-[34px] text-xs text-muted">{d.name}</div>
              <div className="mt-2 flex justify-between font-mono text-[10.5px] text-muted">
                <span>
                  agentes <b className="text-ink">{d.agentes}</b>
                </span>
                <span>
                  subs <b className="text-ink">{d.subagentes.toLocaleString('es')}</b>
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-[1.55fr,1fr]">
        <Panel title="Misiones recientes" hint="actualiza cada 10 s">
          {missions.isLoading && <Spinner />}
          {missions.data?.length === 0 && (
            <Empty message="Aún no hay misiones. Crea la primera desde el módulo Misiones." />
          )}
          <div className="divide-y divide-dashed divide-line">
            {missions.data?.slice(0, 8).map((m) => (
              <Link
                key={m.id}
                to="/misiones"
                className="flex items-center gap-3 py-2.5 hover:bg-surface2/50"
              >
                <Pill value={m.status} />
                <span className="flex-1 truncate text-sm">{m.title}</span>
                <span className="font-mono text-[10.5px] text-muted">
                  {m.tasks} tareas · ${m.costUsd.toFixed(3)}
                </span>
              </Link>
            ))}
          </div>
        </Panel>

        <Panel title="Routing por modelo" hint="hoy">
          {totalCalls === 0 && <Empty message="Sin llamadas registradas hoy." />}
          <div className="space-y-4">
            {costs.data?.porModelo.map((m) => {
              const pct = totalCalls ? Math.round((m.llamadas / totalCalls) * 100) : 0;
              const color = m.model.includes('opus')
                ? 'var(--gold)'
                : m.model.includes('sonnet')
                  ? 'var(--indigo)'
                  : 'var(--teal)';
              return (
                <div key={m.model}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="text-sm font-bold">
                      {m.model}
                      <span className="ml-2 font-mono text-[10px] font-medium text-muted">
                        {m.llamadas} llamadas · ${m.costUsd.toFixed(4)}
                      </span>
                    </span>
                    <span className="font-mono text-xs font-semibold tabular-nums">{pct}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-surface2">
                    <i className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-muted">
            Regla permanente: nunca Opus para lo que Sonnet resuelve; nunca Sonnet para lo que Haiku
            resuelve.
          </p>
        </Panel>
      </div>
    </div>
  );
}
