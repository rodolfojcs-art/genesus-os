import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Empty, ErrorBox, Panel, Pill, Spinner } from '../components/ui';

interface Supplier {
  id: string;
  name: string;
  country: string;
  categories: string[];
  rating: number | null;
  status: string;
}
interface Client {
  id: string;
  name: string;
  segment: string;
  country: string;
  status: string;
}

function AddForm({
  table,
  fields,
  onDone,
}: {
  table: 'suppliers' | 'clients';
  fields: Array<{ key: string; label: string }>;
  onDone: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const create = useMutation({
    mutationFn: () =>
      api(`/api/${table}`, {
        method: 'POST',
        body: JSON.stringify(
          table === 'suppliers'
            ? { ...values, categories: (values.categories ?? '').split(',').map((s) => s.trim()).filter(Boolean), status: 'activo' }
            : { ...values, status: 'activo' },
        ),
      }),
    onSuccess: () => {
      setValues({});
      onDone();
    },
  });

  return (
    <div className="mt-4 rounded-xl border border-dashed border-line2 p-4">
      <div className="grid gap-2 md:grid-cols-2">
        {fields.map((f) => (
          <input
            key={f.key}
            className="input"
            placeholder={f.label}
            value={values[f.key] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        ))}
      </div>
      {create.isError && (
        <div className="mt-2">
          <ErrorBox message={(create.error as Error).message} />
        </div>
      )}
      <button
        className="btn-primary mt-3 !py-1.5 text-xs"
        disabled={create.isPending || !values.name}
        onClick={() => create.mutate()}
      >
        Agregar
      </button>
    </div>
  );
}

export function Crm() {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: ['suppliers'], queryFn: () => api<Supplier[]>('/api/suppliers') });
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => api<Client[]>('/api/clients') });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-extrabold">Proveedores y Clientes</h1>
        <p className="text-sm text-muted">
          CRM ligero. El departamento SUPL puede proponer proveedores candidatos vía misión; tú los
          confirmas antes de guardarlos.
        </p>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Panel title="Proveedores" hint={`${suppliers.data?.length ?? 0} registrados`}>
          {suppliers.isLoading && <Spinner />}
          {suppliers.data?.length === 0 && <Empty message="Sin proveedores." />}
          <div className="max-h-[420px] space-y-2 overflow-y-auto">
            {suppliers.data?.map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-xl border border-line px-3.5 py-2.5">
                <div className="flex-1">
                  <div className="text-sm font-semibold">{s.name}</div>
                  <div className="font-mono text-[10.5px] text-muted">
                    {s.country} · {(s.categories ?? []).join(', ')}
                  </div>
                </div>
                {s.rating != null && (
                  <span className="font-mono text-xs text-gold">★ {Number(s.rating).toFixed(1)}</span>
                )}
                <Pill value={s.status} />
              </div>
            ))}
          </div>
          <AddForm
            table="suppliers"
            fields={[
              { key: 'name', label: 'Nombre' },
              { key: 'country', label: 'País' },
              { key: 'categories', label: 'Categorías (separadas por coma)' },
            ]}
            onDone={() => void qc.invalidateQueries({ queryKey: ['suppliers'] })}
          />
        </Panel>

        <Panel title="Clientes" hint={`${clients.data?.length ?? 0} registrados`}>
          {clients.isLoading && <Spinner />}
          {clients.data?.length === 0 && <Empty message="Sin clientes." />}
          <div className="max-h-[420px] space-y-2 overflow-y-auto">
            {clients.data?.map((c) => (
              <div key={c.id} className="flex items-center gap-3 rounded-xl border border-line px-3.5 py-2.5">
                <div className="flex-1">
                  <div className="text-sm font-semibold">{c.name}</div>
                  <div className="font-mono text-[10.5px] text-muted">
                    {c.segment} · {c.country}
                  </div>
                </div>
                <Pill value={c.status} />
              </div>
            ))}
          </div>
          <AddForm
            table="clients"
            fields={[
              { key: 'name', label: 'Nombre' },
              { key: 'segment', label: 'Segmento' },
              { key: 'country', label: 'País' },
            ]}
            onDone={() => void qc.invalidateQueries({ queryKey: ['clients'] })}
          />
        </Panel>
      </div>
    </div>
  );
}
