-- 0430 — Motivo de perda com categoria e a etapa de onde o negócio saiu.
-- Porte de melgarafael/DeskcommCRM#1717 (migration 0426 de lá, issue #1537).
--
--  1. `crm_leads.lost_from_stage_id`: em que etapa ABERTA o negócio foi perdido,
--     para o relatório "Perdas" responder "por preço NA ETAPA de proposta". Nasce
--     `null` em toda linha (derivar retroativamente seria inventar dado); FK
--     `on delete set null`.
--  2. `fn_crm_lead_close_on_stage` grava essa origem na transição para `lost`
--     (o MESMO gatilho que já deriva status/closed_at da etapa) e a limpa quando
--     o negócio reabre.
--  3. `fn_validate_lost_reason_required` compara o RÓTULO quando o item de
--     `settings.lost_reasons` é `{ label, categoria }`. Texto puro continua
--     valendo; nenhum funil é migrado. O canônico do fork (com
--     `opted_out_of_messages`, 0310) fica igual.
--
-- Aditiva e idempotente. Duas FKs de `crm_leads` para `crm_stages` a partir
-- daqui: embed do PostgREST entre as duas tabelas precisa nomear a FK
-- (`crm_stages!crm_leads_stage_id_fkey(...)`), vigiado por
-- tests/unit/embed-etapa-do-lead-nomeia-a-fk.test.ts.

alter table public.crm_leads
  add column if not exists lost_from_stage_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'fk_crm_leads_lost_from_stage'
       and conrelid = 'public.crm_leads'::regclass
  ) then
    alter table public.crm_leads
      add constraint fk_crm_leads_lost_from_stage
      foreign key (lost_from_stage_id)
      references public.crm_stages(id)
      on delete set null;
  end if;
end $$;

comment on column public.crm_leads.lost_from_stage_id is
  'Etapa aberta de onde o negócio saiu quando foi perdido (gravada por fn_crm_lead_close_on_stage). Migration 0430.';

create or replace function public.fn_crm_lead_close_on_stage() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_is_won  boolean;
  v_is_lost boolean;
begin
  if tg_op = 'UPDATE'
     and new.stage_id is not distinct from old.stage_id
     and new.status   is not distinct from old.status then
    return new;
  end if;

  select is_won, is_lost into v_is_won, v_is_lost
    from public.crm_stages where id = new.stage_id;

  if v_is_won then
    new.status := 'won';
    new.closed_at := coalesce(new.closed_at, now());
  elsif v_is_lost then
    new.status := 'lost';
    new.closed_at := coalesce(new.closed_at, now());
    -- A etapa ABERTA que o negócio deixou (0430). Só na transição: o card já
    -- perdido movido entre etapas de perda mantém a origem verdadeira.
    if tg_op = 'UPDATE' and old.status is distinct from 'lost' then
      new.lost_from_stage_id := coalesce(new.lost_from_stage_id, old.stage_id);
    end if;
  else
    if tg_op = 'UPDATE' and old.status in ('won','lost') then
      new.status := 'open';
      new.closed_at := null;
      -- Reabriu: a origem da perda passada não vale para o negócio aberto.
      new.lost_from_stage_id := null;
    end if;
  end if;
  return new;
end$$;

create or replace function public.fn_validate_lost_reason_required() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_canonical text[] := array['requested_by_customer','price','no_response','product_unavailable',
                              'cancelled_by_store','cancelled_by_customer','payment_failed','other',
                              'opted_out_of_messages'];
  v_pipeline_extra text[];
begin
  if new.status = 'lost' then
    if new.lost_reason is null or length(new.lost_reason) = 0 then
      raise exception 'lost_reason_required' using errcode = '22023';
    end if;

    -- `lost_reasons` aceita texto puro E `{ label, categoria }` (0430): o que
    -- se compara é o RÓTULO nos dois formatos.
    select coalesce(
      array(
        select case when jsonb_typeof(e) = 'object'
                    then nullif(e ->> 'label', '')
                    else nullif(e #>> '{}', '') end
          from jsonb_array_elements(settings->'lost_reasons') as t(e)
      ), '{}'::text[]
    ) into v_pipeline_extra
    from public.crm_pipelines where id = new.pipeline_id;

    if not (new.lost_reason = any (v_canonical) or new.lost_reason = any (v_pipeline_extra)) then
      raise exception 'lost_reason_invalid: %', new.lost_reason using errcode = '22023';
    end if;
  end if;
  return new;
end$$;

-- Funções de gatilho: o EXECUTE não é conferido no disparo; só fecha a RPC.
revoke execute on function public.fn_validate_lost_reason_required() from public, anon;
grant execute on function public.fn_validate_lost_reason_required() to authenticated, service_role;
