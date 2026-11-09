import { DEMO_CLIENTS, DEMO_MACHINES, DEMO_PRODUCTS, DEMO_SUPPLIERS } from '@genesus/agents';
import { SimulatorAdapter, createAdapter, type MachineAdapter } from '@genesus/core';
import { supabase } from './supabase.js';

/**
 * Acceso a datos de fábrica/CRM. Con Supabase configurado usa las tablas reales;
 * sin Supabase opera sobre un almacén en memoria sembrado con los datos demo
 * (el estado se reporta como "demo" en /api/health — honestidad ante todo).
 */

type Row = Record<string, unknown> & { id: string };

function withIds<T extends object>(rows: readonly T[]): Row[] {
  return rows.map((r) => ({ ...r, id: crypto.randomUUID() }) as Row);
}

const memory: Record<string, Row[]> = {
  suppliers: withIds(DEMO_SUPPLIERS),
  clients: withIds(DEMO_CLIENTS),
  products: withIds(DEMO_PRODUCTS),
  machines: withIds(DEMO_MACHINES),
  orders: [],
  bom_items: [],
};

export async function listRows(table: string): Promise<Row[]> {
  const sb = supabase();
  if (sb) {
    const { data, error } = await sb.from(table).select('*').limit(500);
    if (error) throw new Error(`Error leyendo ${table}: ${error.message}`);
    return (data ?? []) as Row[];
  }
  return memory[table] ?? [];
}

export async function insertRow(table: string, row: Record<string, unknown>): Promise<Row> {
  const sb = supabase();
  if (sb) {
    const { data, error } = await sb.from(table).insert(row).select().single();
    if (error) throw new Error(`Error insertando en ${table}: ${error.message}`);
    return data as Row;
  }
  const withId = { ...row, id: crypto.randomUUID() } as Row;
  (memory[table] ??= []).push(withId);
  return withId;
}

export async function updateRow(
  table: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<Row | null> {
  const sb = supabase();
  if (sb) {
    const { data, error } = await sb.from(table).update(patch).eq('id', id).select().single();
    if (error) throw new Error(`Error actualizando ${table}: ${error.message}`);
    return data as Row;
  }
  const rows = memory[table] ?? [];
  const idx = rows.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  rows[idx] = { ...rows[idx], ...patch } as Row;
  return rows[idx]!;
}

// --------------------------------------------------------------------------
// Runtime de máquinas: una instancia de adaptador por máquina registrada.
// --------------------------------------------------------------------------
const adapters = new Map<string, MachineAdapter>();

export async function machineAdapter(machineName: string): Promise<MachineAdapter | null> {
  const existing = adapters.get(machineName);
  if (existing) return existing;
  const machines = await listRows('machines');
  const row = machines.find((m) => m.name === machineName);
  if (!row) return null;
  const kind = String(row.adapter ?? 'simulator') as 'simulator' | 'mqtt' | 'opcua';
  const adapter =
    kind === 'simulator'
      ? new SimulatorAdapter(
          machineName,
          Number((row.config as Record<string, unknown> | null)?.unidades_por_minuto ?? 12),
        )
      : createAdapter(kind, machineName);
  adapters.set(machineName, adapter);
  return adapter;
}
