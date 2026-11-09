import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Empty, ErrorBox, Panel, Pill, Spinner } from '../components/ui';

interface Product {
  id: string;
  name: string;
  sku: string;
  status: string;
  specs: Record<string, unknown>;
}
interface MissionSummary {
  id: string;
  title: string;
  status: string;
}

const PIPELINE = ['idea', 'diseño', 'prototipo', 'produccion'] as const;

export function Producto() {
  const qc = useQueryClient();
  const products = useQuery({ queryKey: ['products'], queryFn: () => api<Product[]>('/api/products') });
  const missions = useQuery({
    queryKey: ['missions'],
    queryFn: () => api<MissionSummary[]>('/api/missions'),
  });

  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [missionId, setMissionId] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api<Product>('/api/products', {
        method: 'POST',
        body: JSON.stringify({
          name,
          sku,
          status: 'diseño',
          specs: missionId ? { origen_mision: missionId } : {},
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['products'] });
      setName('');
      setSku('');
      setMissionId('');
    },
  });

  const advance = useMutation({
    mutationFn: (p: Product) => {
      const idx = PIPELINE.indexOf(p.status as (typeof PIPELINE)[number]);
      const next = PIPELINE[Math.min(idx + 1, PIPELINE.length - 1)];
      return api(`/api/products/${p.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['products'] }),
  });

  const completedMissions = missions.data?.filter((m) => m.status === 'completada') ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-extrabold">Estudio de Producto</h1>
        <p className="text-sm text-muted">
          Pipeline idea → diseño → specs → BOM → producción. Los artefactos de misiones completadas
          se convierten en productos con un clic.
        </p>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[360px,1fr]">
        <Panel title="Nuevo producto" hint="desde cero o desde una misión">
          <label className="label">Nombre</label>
          <input className="input mb-3" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="label">SKU</label>
          <input className="input mb-3" value={sku} onChange={(e) => setSku(e.target.value)} />
          <label className="label">Origen (misión completada, opcional)</label>
          <select className="input mb-4" value={missionId} onChange={(e) => setMissionId(e.target.value)}>
            <option value="">— sin misión de origen —</option>
            {completedMissions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
          {create.isError && (
            <div className="mb-3">
              <ErrorBox message={(create.error as Error).message} />
            </div>
          )}
          <button
            className="btn-primary"
            disabled={create.isPending || !name || !sku}
            onClick={() => create.mutate()}
          >
            Crear producto
          </button>
        </Panel>

        <Panel title="Portafolio" hint={`${products.data?.length ?? 0} productos`}>
          {products.isLoading && <Spinner />}
          {products.data?.length === 0 && <Empty message="Sin productos. Crea el primero." />}
          <div className="space-y-3">
            {products.data?.map((p) => (
              <div key={p.id} className="rounded-xl border border-line p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-semibold">{p.name}</span>
                    <span className="ml-2 font-mono text-[11px] text-muted">{p.sku}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill value={p.status} />
                    {p.status !== 'produccion' && (
                      <button className="btn-ghost !px-3 !py-1 text-xs" onClick={() => advance.mutate(p)}>
                        Avanzar etapa →
                      </button>
                    )}
                  </div>
                </div>
                {/* Pipeline visual */}
                <div className="mt-3 flex items-center gap-1">
                  {PIPELINE.map((stage, i) => {
                    const idx = PIPELINE.indexOf(p.status as (typeof PIPELINE)[number]);
                    const active = i <= (idx === -1 ? 0 : idx);
                    return (
                      <div key={stage} className="flex flex-1 items-center gap-1">
                        <span
                          className={`h-1.5 flex-1 rounded-full ${active ? 'bg-indigo' : 'bg-surface2'}`}
                        />
                        <span className={`font-mono text-[9px] ${active ? 'text-indigo' : 'text-muted'}`}>
                          {stage}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {Object.keys(p.specs ?? {}).length > 0 && (
                  <pre className="mt-3 overflow-x-auto rounded-lg bg-surface2 p-3 font-mono text-[11px] text-muted">
                    {JSON.stringify(p.specs, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
