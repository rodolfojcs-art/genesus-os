-- GENESUS OS — Migración 0003: funciones RPC

-- ---------------------------------------------------------------------------
-- match_memories: recuperación semántica de Genesus BRAIN (pgvector, coseno)
-- ---------------------------------------------------------------------------
create or replace function match_memories(
  query_embedding vector(1536),
  match_threshold float default 0.78,
  match_count int default 10,
  p_user_id uuid default null
)
returns table (id uuid, content text, scope text, similarity float)
language sql
stable
as $$
  select
    bm.id,
    bm.content,
    bm.scope,
    1 - (bm.embedding <=> query_embedding) as similarity
  from brain_memory bm
  where bm.embedding is not null
    and (bm.expires_at is null or bm.expires_at > now())
    and (p_user_id is null or bm.user_id is null or bm.user_id = p_user_id)
    and 1 - (bm.embedding <=> query_embedding) > match_threshold
  order by bm.embedding <=> query_embedding
  limit match_count;
$$;

-- ---------------------------------------------------------------------------
-- consume_budget: corte duro de presupuesto diario, atómico (FOR UPDATE).
-- Si el gasto no cabe, allowed=false y NO se registra — la misión pasa a
-- `pausada_por_presupuesto` en el server, nunca falla en silencio.
-- ---------------------------------------------------------------------------
create or replace function consume_budget(
  p_cost numeric,
  p_default_limit numeric default 25
)
returns table (allowed boolean, remaining numeric)
language plpgsql
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
