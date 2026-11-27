-- 0439: "Levar para outro funil" reutiliza a cópia aberta do mesmo negócio.
--
-- Portado do projeto original (DeskcommCRM PR #5268, de yunshu0909; migration
-- 9492 de lá, issue #5229).
--
-- ─── O caso ──────────────────────────────────────────────────────────────────
--
-- A rota `POST /api/v1/leads/[id]/clone` fazia DUAS escritas sem transação:
-- criava o clone no destino e depois encerrava a origem. Duas abas, um duplo
-- clique, ou um segundo "Levar" depois de a primeira tentativa cair entre as
-- duas escritas, criavam um SEGUNDO card do mesmo negócio no funil de destino.
--
-- ─── O conserto ──────────────────────────────────────────────────────────────
--
-- `fn_levar_negocio_para_funil` trava a origem (`for no key update`), procura a
-- cópia ABERTA dela no destino (`source_metadata.clonado_de.lead_id`) e:
--   * se existe, devolve essa cópia (e encerra a origem, se ela ainda está
--     aberta e o fechamento foi pedido);
--   * se não existe, cria o clone, grava `clonado_de` / `movido_para` e encerra
--     a origem — tudo na mesma transação. Qualquer recusa desfaz tudo.
-- A segunda chamada concorrente espera a trava e enxerga o commit da primeira.
--
-- ⚠️ Diferença deliberada do upstream: lá a função é chamada pelo cliente de
-- serviço, com as claims da sessão reaplicadas dentro dela, porque o upstream
-- proíbe a sessão de gravar `clonado_de` (migration 9389 de lá). Este fork não
-- tem essa guarda e a rota já gravava pela SESSÃO; então a função é
-- `security invoker` e EXECUTE vai para `authenticated`: as policies de
-- `crm_leads` decidem exatamente como no INSERT de antes. Não dá à sessão
-- nada que ela já não pudesse fazer pela REST.
--
-- NENHUM DADO EXISTENTE MUDA: só um índice (não único) e uma função.

create index if not exists crm_leads_clone_aberto_no_funil_idx
  on public.crm_leads (organization_id, pipeline_id, (source_metadata->'clonado_de'->>'lead_id'), created_at, id)
  where status = 'open' and source_metadata ? 'clonado_de';

create or replace function public.fn_levar_negocio_para_funil(
  p_org uuid,
  p_origem uuid,
  p_destino uuid,
  p_linha jsonb,
  p_fechamento jsonb,
  p_origem_atualizada_em timestamptz
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_origem public.crm_leads%rowtype;
  v_clone public.crm_leads%rowtype;
  v_linha public.crm_leads%rowtype;
  v_consulta boolean := p_linha is null and p_fechamento is null;
  v_criou boolean := false;
  v_fechou boolean := false;
begin
  -- A consulta inicial é só leitura. Toda decisão que escreve repete a busca
  -- depois de travar a mesma origem: a segunda transação vê o commit da primeira.
  if v_consulta then
    select * into v_origem from public.crm_leads
     where id = p_origem and organization_id = p_org;
  else
    select * into v_origem from public.crm_leads
     where id = p_origem and organization_id = p_org for no key update;
  end if;

  if v_origem.id is null then
    raise exception 'clone_origem_nao_encontrada' using errcode = 'PT404';
  end if;
  if v_origem.pipeline_id = p_destino or not exists (
    select 1 from public.crm_pipelines
     where id = p_destino and organization_id = p_org and not is_archived
  ) then
    raise exception 'clone_origem_ou_destino_mudou' using errcode = 'PT409';
  end if;

  select * into v_clone from public.crm_leads
   where organization_id = p_org
     and pipeline_id = p_destino
     and status = 'open'
     and source_metadata ? 'clonado_de'
     and source_metadata->'clonado_de'->>'lead_id' = p_origem::text
   order by created_at, id
   limit 1;

  if v_consulta and v_clone.id is null then
    return null;
  end if;
  if v_clone.id is null and p_linha is null then
    raise exception 'clone_destino_mudou' using errcode = 'PT409';
  end if;

  if v_clone.id is null then
    if v_origem.updated_at is distinct from p_origem_atualizada_em
       or (v_origem.status = 'open') <> (p_fechamento is not null) then
      raise exception 'clone_origem_mudou' using errcode = 'PT409';
    end if;
    v_linha := jsonb_populate_record(null::public.crm_leads, p_linha);
    if not exists (
      select 1 from public.crm_stages
       where id = v_linha.stage_id and organization_id = p_org and pipeline_id = p_destino
         and not is_archived and not is_won and not is_lost
    ) then
      raise exception 'clone_etapa_mudou' using errcode = 'PT409';
    end if;

    -- `clonado_de` é do SERVIDOR: aponta para a origem travada, nunca para o
    -- que veio no payload. O resto de `source_metadata` (inclusive um
    -- `movido_para` herdado da origem) segue como sempre seguiu.
    insert into public.crm_leads (
      organization_id, pipeline_id, stage_id, title, description, contact_id, value_cents,
      currency, owner_user_id, owner_agent_id, owner_kind, assigned_at, expected_close_date,
      tags, source, source_metadata, external_id, custom_fields, position_in_stage,
      created_by_user_id
    ) values (
      p_org, p_destino, v_linha.stage_id, v_linha.title, v_linha.description, v_linha.contact_id,
      v_linha.value_cents, coalesce(v_linha.currency, 'BRL'), v_linha.owner_user_id,
      v_linha.owner_agent_id, v_linha.owner_kind, v_linha.assigned_at, v_linha.expected_close_date,
      coalesce(v_linha.tags, '{}'), coalesce(v_linha.source, 'manual'),
      (coalesce(v_linha.source_metadata, '{}'::jsonb) - 'clonado_de')
        || jsonb_build_object('clonado_de', jsonb_build_object(
             'lead_id', p_origem, 'pipeline_id', v_origem.pipeline_id)),
      v_linha.external_id, coalesce(v_linha.custom_fields, '{}'::jsonb),
      v_linha.position_in_stage, v_linha.created_by_user_id
    ) returning * into v_clone;
    v_criou := true;
  end if;

  if v_origem.status = 'open' and p_fechamento is not null then
    if v_origem.updated_at is distinct from p_origem_atualizada_em then
      raise exception 'clone_origem_mudou' using errcode = 'PT409';
    end if;
    v_linha := jsonb_populate_record(null::public.crm_leads, p_fechamento);
    if not exists (
      select 1 from public.crm_stages
       where id = v_linha.stage_id and organization_id = p_org and pipeline_id = v_origem.pipeline_id
         and is_lost and not is_archived
    ) then
      raise exception 'clone_fechamento_mudou' using errcode = 'PT409';
    end if;
    update public.crm_leads
       set stage_id = v_linha.stage_id, position_in_stage = v_linha.position_in_stage,
           lost_reason = v_linha.lost_reason, updated_at = coalesce(v_linha.updated_at, now())
     where id = p_origem and organization_id = p_org
     returning * into v_origem;
    if not found then
      raise exception 'clone_fora_do_escopo' using errcode = 'PT403';
    end if;
    v_fechou := true;
  end if;

  if v_criou or v_fechou then
    update public.crm_leads
       set source_metadata = source_metadata || jsonb_build_object('movido_para', jsonb_build_object(
         'lead_id', v_clone.id, 'pipeline_id', v_clone.pipeline_id, 'stage_id', v_clone.stage_id
       )), updated_at = now()
     where id = p_origem and organization_id = p_org
     returning * into strict v_origem;
  end if;

  return jsonb_build_object('clone', to_jsonb(v_clone), 'origem', to_jsonb(v_origem),
                            'criou', v_criou, 'fechou', v_fechou);
end;
$$;

revoke execute on function public.fn_levar_negocio_para_funil(uuid, uuid, uuid, jsonb, jsonb, timestamptz)
  from public, anon;
grant execute on function public.fn_levar_negocio_para_funil(uuid, uuid, uuid, jsonb, jsonb, timestamptz)
  to authenticated, service_role;

notify pgrst, 'reload schema';
