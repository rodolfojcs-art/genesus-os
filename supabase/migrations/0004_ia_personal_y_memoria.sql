-- =====================================================================
--  0004 — IA PERSONAL: conversaciones, memoria permanente, vigías
--
--  RECONSTRUIDA DESDE LA BASE VIVA (2026-11-09).
--
--  Las migraciones 0004–0011 nunca quedaron en el repo: el esquema de la
--  IA personal existía SOLO en la base de datos de producción.
--  Si ese proyecto se hubiera borrado, el repo no podía reconstruirlo.
--  Este archivo consolida en uno todo lo que faltaba, extraído con
--  information_schema / pg_catalog de la base real, y cierra el hueco:
--  0001 -> 0002 -> 0003 -> 0004 (este) -> 0012.
--
--  Es IDEMPOTENTE a propósito: se puede correr contra la base que ya
--  tiene estos objetos sin romper ni duplicar nada (así se verificó).
--
--  Cubre: agents.custom · brain_memory.title/status · FTS español ·
--  genesus_conversations · genesus_messages · genesus_watchers ·
--  genesus_notifications · question_log · RLS de todo lo anterior ·
--  search_memories_text() · endurecimiento de consume_budget().
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Departamentos automáticos (AUTO-*)
--    El asistente crea departamentos al vuelo cuando ninguno encaja.
--    `custom` los distingue de los 1.000 agentes sembrados.
-- ---------------------------------------------------------------------
alter table agents add column if not exists custom boolean not null default false;

-- ---------------------------------------------------------------------
-- 2. Memoria permanente: título legible + ciclo de vida
--    Nada se borra nunca: una memoria irrelevante pasa a 'archivada'
--    y el question_log conserva el registro de la pregunta.
-- ---------------------------------------------------------------------
alter table brain_memory add column if not exists title  text;
alter table brain_memory add column if not exists status text not null default 'activa';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'brain_memory_status_check'
  ) then
    alter table brain_memory
      add constraint brain_memory_status_check
      check (status in ('activa', 'archivada'));
  end if;
end $$;

-- Búsqueda de texto en español sobre título + contenido (respaldo de
-- los embeddings: si no hay llave de embeddings, el recall sigue vivo).
create index if not exists idx_brain_memory_fts
  on brain_memory
  using gin (to_tsvector('spanish', coalesce(title, '') || ' ' || content));

-- ---------------------------------------------------------------------
-- 3. Conversaciones persistentes (hilos estilo Claude)
-- ---------------------------------------------------------------------
create table if not exists genesus_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  title      text not null default 'Nueva conversación',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_conv_user
  on genesus_conversations (user_id, updated_at desc);

create table if not exists genesus_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references genesus_conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null default '',
  meta            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists idx_msg_conv
  on genesus_messages (conversation_id, created_at);

-- ---------------------------------------------------------------------
-- 4. Vigías (proactividad) y notificaciones
--    El planificador del server revisa cada 2 min los vigías vencidos.
--    genesus_watchers va ANTES de genesus_notifications por la FK.
-- ---------------------------------------------------------------------
create table if not exists genesus_watchers (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  query        text not null,
  interval_min integer not null default 360,
  status       text not null default 'activo' check (status in ('activo', 'pausado')),
  last_summary text,
  last_checked timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_watchers_user
  on genesus_watchers (user_id, status);

create table if not exists genesus_notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  watcher_id uuid references genesus_watchers(id) on delete set null,
  title      text not null,
  body       text not null,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_notif_user
  on genesus_notifications (user_id, read, created_at desc);

-- ---------------------------------------------------------------------
-- 5. Registro inmutable de preguntas
--    Toda pregunta queda acá, incluso si su memoria se archivó.
--    memory_id apunta a la memoria que generó (ON DELETE SET NULL).
-- ---------------------------------------------------------------------
create table if not exists question_log (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid,
  question           text not null,
  department_code    text,
  department_created boolean not null default false,
  memory_id          uuid references brain_memory(id) on delete set null,
  relevance          text not null default 'relevante'
                     check (relevance in ('relevante', 'irrelevante')),
  created_at         timestamptz not null default now()
);
create index if not exists idx_question_log_user
  on question_log (user_id, created_at desc);
create index if not exists idx_question_log_fts
  on question_log using gin (to_tsvector('spanish', question));

-- ---------------------------------------------------------------------
-- 6. RLS
--
--    Dos planos por tabla:
--      · `authenticated` → cada usuario ve y escribe lo suyo (auth.uid()).
--      · `anon` → SOLO las filas del usuario local fijo
--        00000000-0000-0000-0000-000000000001, que es el que usa la app
--        de escritorio cuando nadie inició sesión.
--
--    OJO (decisión consciente, no descuido): el plano `anon` permite
--    leer y escribir los datos de ese usuario fijo con la sola llave
--    anónima, que viaja dentro del bundle de la app. Es un intercambio
--    aceptable para una app de escritorio de un solo dueño. Si algún día
--    este server queda expuesto a internet (plan de 24/7 en un VPS),
--    HAY QUE quitar las políticas "local" y exigir login real: con la
--    llave anónima cualquiera podría leer toda la memoria.
-- ---------------------------------------------------------------------
alter table genesus_conversations enable row level security;
alter table genesus_messages      enable row level security;
alter table genesus_watchers      enable row level security;
alter table genesus_notifications enable row level security;
alter table question_log          enable row level security;

-- Conversaciones
drop policy if exists "conv propias" on genesus_conversations;
create policy "conv propias" on genesus_conversations
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "conv local" on genesus_conversations;
create policy "conv local" on genesus_conversations
  for all to anon
  using (user_id = '00000000-0000-0000-0000-000000000001'::uuid)
  with check (user_id = '00000000-0000-0000-0000-000000000001'::uuid);

-- Mensajes: heredan el dueño de su conversación
drop policy if exists "msg propios" on genesus_messages;
create policy "msg propios" on genesus_messages
  for all to authenticated
  using (exists (
    select 1 from genesus_conversations c
    where c.id = genesus_messages.conversation_id and c.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from genesus_conversations c
    where c.id = genesus_messages.conversation_id and c.user_id = auth.uid()
  ));

drop policy if exists "msg local" on genesus_messages;
create policy "msg local" on genesus_messages
  for all to anon
  using (exists (
    select 1 from genesus_conversations c
    where c.id = genesus_messages.conversation_id
      and c.user_id = '00000000-0000-0000-0000-000000000001'::uuid
  ))
  with check (exists (
    select 1 from genesus_conversations c
    where c.id = genesus_messages.conversation_id
      and c.user_id = '00000000-0000-0000-0000-000000000001'::uuid
  ));

-- Vigías
drop policy if exists "watchers propios" on genesus_watchers;
create policy "watchers propios" on genesus_watchers
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "watchers local" on genesus_watchers;
create policy "watchers local" on genesus_watchers
  for all to anon
  using (user_id = '00000000-0000-0000-0000-000000000001'::uuid)
  with check (user_id = '00000000-0000-0000-0000-000000000001'::uuid);

-- Notificaciones
drop policy if exists "notif propias" on genesus_notifications;
create policy "notif propias" on genesus_notifications
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "notif local" on genesus_notifications;
create policy "notif local" on genesus_notifications
  for all to anon
  using (user_id = '00000000-0000-0000-0000-000000000001'::uuid)
  with check (user_id = '00000000-0000-0000-0000-000000000001'::uuid);

-- Registro de preguntas (solo se inserta y se lee; nunca se edita)
drop policy if exists "registro propio" on question_log;
create policy "registro propio" on question_log
  for select to authenticated
  using (user_id is null or user_id = auth.uid());

drop policy if exists "registro insert propio" on question_log;
create policy "registro insert propio" on question_log
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "registro local select" on question_log;
create policy "registro local select" on question_log
  for select to anon
  using (user_id = '00000000-0000-0000-0000-000000000001'::uuid);

drop policy if exists "registro local insert" on question_log;
create policy "registro local insert" on question_log
  for insert to anon
  with check (user_id = '00000000-0000-0000-0000-000000000001'::uuid);

-- Memoria permanente: 0002 solo dejó el SELECT de `authenticated`.
-- Faltaban la escritura propia y el plano local completo.
drop policy if exists "memoria insert propia" on brain_memory;
create policy "memoria insert propia" on brain_memory
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "memoria update propia" on brain_memory;
create policy "memoria update propia" on brain_memory
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "memoria local select" on brain_memory;
create policy "memoria local select" on brain_memory
  for select to anon
  using (user_id = '00000000-0000-0000-0000-000000000001'::uuid);

drop policy if exists "memoria local insert" on brain_memory;
create policy "memoria local insert" on brain_memory
  for insert to anon
  with check (user_id = '00000000-0000-0000-0000-000000000001'::uuid);

drop policy if exists "memoria local update" on brain_memory;
create policy "memoria local update" on brain_memory
  for update to anon
  using (user_id = '00000000-0000-0000-0000-000000000001'::uuid)
  with check (user_id = '00000000-0000-0000-0000-000000000001'::uuid);

-- ---------------------------------------------------------------------
-- 7. search_memories_text — recall por palabras, respaldo del vector
--    La invoca apps/server/src/store.ts vía .rpc('search_memories_text').
--    FALTABA POR COMPLETO en el repo: sin esta función el recall de
--    memoria rompe aunque las tablas existan.
--
--    Detalle importante: plainto_tsquery produce AND ('a & b'), que casi
--    nunca acierta en memorias largas. Se convierte a OR ('a | b') para
--    recall amplio y se ordena por ts_rank.
-- ---------------------------------------------------------------------
create or replace function search_memories_text(
  p_query text,
  p_limit integer default 8,
  p_user_id uuid default null
)
returns table (id uuid, title text, content text, rank real)
language plpgsql
stable
as $$
declare
  q tsquery;
begin
  q := nullif(replace(plainto_tsquery('spanish', p_query)::text, ' & ', ' | '), '')::tsquery;
  if q is null then
    return;
  end if;
  return query
    select bm.id, bm.title, bm.content,
           ts_rank(to_tsvector('spanish', coalesce(bm.title, '') || ' ' || bm.content), q) as rank
    from brain_memory bm
    where bm.status = 'activa'
      and (p_user_id is null or bm.user_id is null or bm.user_id = p_user_id)
      and to_tsvector('spanish', coalesce(bm.title, '') || ' ' || bm.content) @@ q
    order by rank desc
    limit p_limit;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. consume_budget endurecida
--    0003 la creó sin SECURITY DEFINER: con RLS activo en cost_budgets,
--    el cliente anónimo no podía consumir presupuesto y el guardarraíl
--    de costo fallaba. `search_path` fijo evita secuestro por search_path.
-- ---------------------------------------------------------------------
create or replace function consume_budget(
  p_cost numeric,
  p_default_limit numeric default 25
)
returns table (allowed boolean, remaining numeric)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_row cost_budgets%rowtype;
begin
  insert into cost_budgets (day, limit_usd, spent_usd)
  values (current_date, p_default_limit, 0)
  on conflict (day) do nothing;

  select * into v_row from cost_budgets where day = current_date for update;

  if v_row.spent_usd + p_cost > v_row.limit_usd then
    return query select false, greatest(v_row.limit_usd - v_row.spent_usd, 0::numeric);
  else
    update cost_budgets set spent_usd = spent_usd + p_cost where day = current_date;
    return query select true, v_row.limit_usd - v_row.spent_usd - p_cost;
  end if;
end;
$$;
