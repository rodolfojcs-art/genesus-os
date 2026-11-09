import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Empty, ErrorBox, Panel, Pill, Spinner } from '../components/ui';

interface MachineStatus {
  state: string;
  orderId: string | null;
  progressPct: number;
  unitsDone: number;
  unitsTarget: number;
}
interface Machine {
  id: string;
  name: string;
  adapter: string;
  conector: string;
  estado: MachineStatus | null;
}
interface Order {
  id: string;
  kind: string;
  qty: number;
  status: string;
  timeline: Array<{ at: string; evento: string; maquina?: string }>;
  created_at?: string;
}

function MachineCard({ machine }: { machine: Machine }) {
  const qc = useQueryClient();
  const [qty, setQty] = useState(50);
  const [error, setError] = useState('');

  const start = useMutation({
    mutationFn: () =>
      api(`/api/machines/${encodeURIComponent(machine.name)}/start`, {
        method: 'POST',
        body: JSON.stringify({ qty }),
      }),
    onSuccess: () => {
      setError('');
      void qc.invalidateQueries({ queryKey: ['machines'] });
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e) => setError((e as Error).message),
  });

  const stop = useMutation({
    mutationFn: () => api(`/api/machines/${encodeURIComponent(machine.name)}/stop`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['machines'] }),
    onError: (e) => setError((e as Error).message),
  });

  const st = machine.estado;
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex items-center justify-between">
        <span className="font-semibold">{machine.name}</span>
        <Pill value={machine.conector} />
      </div>
      {st && (
        <>
          <div className="mt-2 flex justify-between font-mono text-[11px] text-muted">
            <span>estado: {st.state}</span>
            <span>
              {st.unitsDone}/{st.unitsTarget} unidades
            </span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface2">
            <i className="block h-full rounded-full bg-teal transition-all" style={{ width: `${st.progressPct}%` }} />
          </div>
        </>
      )}
      <div className="mt-3 flex items-center gap-2">
        <input
          className="input w-24"
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Number(e.target.value))}
        />
        <button className="btn-primary !py-1.5 text-xs" disabled={start.isPending} onClick={() => start.mutate()}>
          Iniciar orden
        </button>
        <button className="btn-ghost !py-1.5 text-xs" disabled={stop.isPending} onClick={() => stop.mutate()}>
          Detener
        </button>
      </div>
      {error && (
        <div className="mt-2">
          <ErrorBox message={error} />
        </div>
      )}
    </div>
  );
}

export function Fabrica() {
  const machines = useQuery({
    queryKey: ['machines'],
    queryFn: () => api<Machine[]>('/api/machines'),
    refetchInterval: 4000,
  });
  const orders = useQuery({
    queryKey: ['orders'],
    queryFn: () => api<Order[]>('/api/orders'),
    refetchInterval: 8000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-extrabold">Fábrica</h1>
        <p className="text-sm text-muted">
          Órdenes de producción y estado de máquinas vía adaptadores. El panel de conectores es
          honesto: <b className="text-ink">simulado · conectado · sin configurar</b> — nunca se
          promete control físico inexistente.
        </p>
      </div>

      <Panel title="Máquinas" hint="adaptadores MachineAdapter">
        {machines.isLoading && <Spinner />}
        {machines.data?.length === 0 && <Empty message="Sin máquinas registradas. Corre pnpm seed." />}
        <div className="grid gap-4 md:grid-cols-2">
          {machines.data?.map((m) => <MachineCard key={m.name} machine={m} />)}
        </div>
      </Panel>

      <Panel title="Conectores disponibles" hint="capa de integración v1">
        <div className="grid gap-3 md:grid-cols-3">
          {(
            [
              ['simulator', 'simulado', 'Adaptador funcional incluido: simula avance de producción en tiempo real.'],
              ['mqtt', 'sin configurar', 'Stub documentado. Requiere broker MQTT y topics de la planta.'],
              ['opcua', 'sin configurar', 'Stub documentado. Requiere endpoint OPC-UA y node IDs.'],
            ] as const
          ).map(([kind, state, desc]) => (
            <div key={kind} className="rounded-xl border border-line p-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-semibold">{kind}</span>
                <Pill value={state} />
              </div>
              <p className="mt-2 text-xs text-muted">{desc}</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Órdenes" hint={`${orders.data?.length ?? 0} registradas`}>
        {orders.data?.length === 0 && <Empty message="Sin órdenes. Inicia una desde una máquina." />}
        {orders.data && orders.data.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10.5px] uppercase text-muted">
                <th className="pb-2">Tipo</th>
                <th className="pb-2">Cantidad</th>
                <th className="pb-2">Estado</th>
                <th className="pb-2">Última actividad</th>
              </tr>
            </thead>
            <tbody>
              {orders.data.map((o) => (
                <tr key={o.id} className="border-b border-dashed border-line last:border-0">
                  <td className="py-2 font-mono text-xs">{o.kind}</td>
                  <td className="py-2 tabular-nums">{o.qty}</td>
                  <td className="py-2">
                    <Pill value={o.status} />
                  </td>
                  <td className="py-2 text-xs text-muted">
                    {o.timeline?.at(-1)?.evento ?? '—'}
                    {o.timeline?.at(-1)?.maquina ? ` · ${o.timeline.at(-1)?.maquina}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
