-- GENESUS OS — Migración 0002: Row Level Security
--
-- Modelo de acceso v1:
--  * Toda ESCRITURA pasa por apps/server con SUPABASE_SERVICE_KEY (service_role
--    ignora RLS). El frontend nunca escribe directo.
--  * Los usuarios autenticados pueden LEER el catálogo (red de agentes, fábrica,
--    CRM) y SOLO sus propias misiones/tareas/artefactos.

alter table divisions    enable row level security;
alter table agents       enable row level security;
alter table subagents    enable row level security;
alter table missions     enable row level security;
alter table tasks        enable row level security;
alter table runs         enable row level security;
alter table artifacts    enable row level security;
alter table brain_memory enable row level security;
alter table suppliers    enable row level security;
alter table clients      enable row level security;
alter table products     enable row level security;
alter table bom_items    enable row level security;
alter table orders       enable row level security;
alter table machines     enable row level security;
alter table cost_budgets enable row level security;

-- Catálogo: lectura para cualquier usuario autenticado
create policy "lectura autenticada" on divisions    for select to authenticated using (true);
create policy "lectura autenticada" on agents       for select to authenticated using (true);
create policy "lectura autenticada" on subagents    for select to authenticated using (true);
create policy "lectura autenticada" on suppliers    for select to authenticated using (true);
create policy "lectura autenticada" on clients      for select to authenticated using (true);
create policy "lectura autenticada" on products     for select to authenticated using (true);
create policy "lectura autenticada" on bom_items    for select to authenticated using (true);
create policy "lectura autenticada" on orders       for select to authenticated using (true);
create policy "lectura autenticada" on machines     for select to authenticated using (true);
create policy "lectura autenticada" on cost_budgets for select to authenticated using (true);

-- Misiones: cada usuario ve solo las suyas
create policy "misiones propias" on missions
  for select to authenticated
  using (user_id = auth.uid());

create policy "tareas de misiones propias" on tasks
  for select to authenticated
  using (exists (select 1 from missions m where m.id = tasks.mission_id and m.user_id = auth.uid()));

create policy "artefactos de misiones propias" on artifacts
  for select to authenticated
  using (exists (select 1 from missions m where m.id = artifacts.mission_id and m.user_id = auth.uid()));

create policy "runs de misiones propias" on runs
  for select to authenticated
  using (
    runs.task_id is null
    or exists (
      select 1
      from tasks t
      join missions m on m.id = t.mission_id
      where t.id = runs.task_id and m.user_id = auth.uid()
    )
  );

-- BRAIN: memoria propia o global
create policy "memoria propia o global" on brain_memory
  for select to authenticated
  using (user_id is null or user_id = auth.uid());
