/**
 * Seed de GENESUS OS — `pnpm seed`
 *
 * Con SUPABASE_URL + SUPABASE_SERVICE_KEY definidos inserta el registro completo
 * en la base de datos (10 divisiones, 1.000 agentes, 10.000 subagentes + datos
 * demo). Sin credenciales, genera supabase/seed.generated.json para inspección
 * local y termina con instrucciones.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { generateNetwork } from './generator.js';
import { DEMO_CLIENTS, DEMO_MACHINES, DEMO_PRODUCTS, DEMO_SUPPLIERS } from './demoData.js';

const CHUNK = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

async function upsertChunked(
  supabase: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
): Promise<void> {
  for (const [idx, part] of chunks(rows, CHUNK).entries()) {
    const { error } = await supabase.from(table).upsert(part, { onConflict });
    if (error) {
      throw new Error(`Error insertando en ${table} (lote ${idx + 1}): ${error.message}`);
    }
    process.stdout.write(`\r  ${table}: ${Math.min((idx + 1) * CHUNK, rows.length)}/${rows.length}`);
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  console.log('GENESUS OS — generando red de agentes…');
  const net = generateNetwork();
  console.log(`  divisiones: ${net.divisions.length}`);
  console.log(`  agentes:    ${net.agents.length}`);
  console.log(`  subagentes: ${net.subagents.length}`);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    const here = dirname(fileURLToPath(import.meta.url));
    const outPath = resolve(here, '../../../supabase/seed.generated.json');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          counts: {
            divisions: net.divisions.length,
            agents: net.agents.length,
            subagents: net.subagents.length,
          },
          divisions: net.divisions,
          agents: net.agents,
          subagents: net.subagents,
          demo: {
            suppliers: DEMO_SUPPLIERS,
            clients: DEMO_CLIENTS,
            products: DEMO_PRODUCTS,
            machines: DEMO_MACHINES,
          },
        },
        null,
        2,
      ),
    );
    console.log(`\nSin SUPABASE_URL/SUPABASE_SERVICE_KEY: red generada en ${outPath}`);
    console.log('Define las variables en .env y vuelve a ejecutar `pnpm seed` para poblar la base.');
    return;
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  console.log('\nInsertando divisiones…');
  await upsertChunked(
    supabase,
    'divisions',
    net.divisions.map((d) => ({
      code: d.code,
      name: d.name,
      color: d.color,
      description: `${d.description} · ${d.director}`,
    })),
    'code',
  );

  const { data: divRows, error: divErr } = await supabase.from('divisions').select('id, code');
  if (divErr || !divRows) throw new Error(`No se pudieron leer divisiones: ${divErr?.message}`);
  const divisionIdByCode = new Map(divRows.map((d) => [d.code as string, d.id as string]));

  console.log('Insertando agentes…');
  await upsertChunked(
    supabase,
    'agents',
    net.agents.map((a) => ({
      division_id: divisionIdByCode.get(a.divisionCode),
      code: a.code,
      name: a.name,
      specialty: a.specialty,
      system_prompt: a.systemPrompt,
      model_tier: a.modelTier,
      status: a.status,
    })),
    'code',
  );

  const { data: agentRows, error: agErr } = await supabase
    .from('agents')
    .select('id, code')
    .range(0, 1999);
  if (agErr || !agentRows) throw new Error(`No se pudieron leer agentes: ${agErr?.message}`);
  const agentIdByCode = new Map(agentRows.map((a) => [a.code as string, a.id as string]));

  console.log('Insertando subagentes…');
  await upsertChunked(
    supabase,
    'subagents',
    net.subagents.map((s) => ({
      agent_id: agentIdByCode.get(s.agentCode),
      code: s.code,
      role: s.role,
      model_tier: s.modelTier,
      system_prompt: s.systemPrompt,
    })),
    'code',
  );

  console.log('Insertando datos demo (proveedores, clientes, productos, máquinas)…');
  await upsertChunked(supabase, 'suppliers', DEMO_SUPPLIERS.map((s) => ({ ...s, categories: [...s.categories] })), 'name');
  await upsertChunked(supabase, 'clients', DEMO_CLIENTS.map((c) => ({ ...c })), 'name');
  await upsertChunked(supabase, 'products', DEMO_PRODUCTS.map((p) => ({ ...p })), 'sku');
  await upsertChunked(supabase, 'machines', DEMO_MACHINES.map((m) => ({ ...m })), 'name');

  // Verificación — criterio Fase 1: counts exactos
  const agentsCount = await supabase.from('agents').select('*', { count: 'exact', head: true });
  const subsCount = await supabase.from('subagents').select('*', { count: 'exact', head: true });
  console.log('\n=== VERIFICACIÓN ===');
  console.log(`agents:    ${agentsCount.count} (esperado 1000)`);
  console.log(`subagents: ${subsCount.count} (esperado 10000)`);
  if (agentsCount.count !== 1000 || subsCount.count !== 10000) {
    process.exitCode = 1;
    console.error('FALLO: los conteos no coinciden con el criterio de la Fase 1.');
  } else {
    console.log('OK: registro completo verificado.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
