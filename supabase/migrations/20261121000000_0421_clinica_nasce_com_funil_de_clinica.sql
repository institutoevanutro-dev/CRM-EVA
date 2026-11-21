-- ---- clínica nasce com funil e etiquetas de clínica (migration 0421) ----
-- Auditoria de 17/11, itens 175 e 180. O fork é de clínica, mas toda
-- organização nova nascia com o funil de loja "Pedidos" (Carrinho abandonado,
-- Em separação, Enviado...) e as etiquetas de loja (troca, devolução,
-- pós-venda). E o onboarding conecta o telefone ANTES de montar o quadro: cada
-- paciente que escrevia nesse intervalo virava cartão em "Carrinho abandonado"
-- e o passo do quadro recusava a troca ("já tem N clientes").
--
-- Três partes, todas idempotentes:
--   1. o gatilho de organização nova semeia o quadro "Agendamentos" (o mesmo
--      pacote de clínica do onboarding, lib/onboarding/pacotes-de-funil.ts) e
--      as etiquetas de clínica;
--   2. a troca do quadro no onboarding leva os cartões abertos para a primeira
--      coluna nova em vez de recusar; só recusa se houver cartão em coluna de
--      ganho/perda (isso é decisão de alguém, não chegada);
--   3. instalação existente: "Pedidos" INTOCADO (as 8 colunas originais, nenhum
--      cartão, nenhuma fonte de webhook) vira "Agendamentos" se for o padrão e
--      é arquivado se não for; a lista de etiquetas de loja intocada vira a de
--      clínica. Quadro ou lista que alguém mexeu fica como está.

create or replace function public.fn_seed_default_pipeline_for_org() returns trigger
  language plpgsql
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_pipeline_id uuid;
  v_position numeric := 1000;
  r record;
begin
  insert into public.crm_pipelines (organization_id, name, slug, is_default, position, vocabulary)
  values (new.id, 'Agendamentos', 'agendamentos', true, 1000,
          jsonb_build_object('lead', 'Paciente', 'lead_plural', 'Pacientes',
                             'deal', 'Atendimento', 'deal_plural', 'Atendimentos',
                             'won', 'Consulta marcada', 'lost', 'Não vai marcar',
                             'stage', 'Etapa', 'stage_plural', 'Etapas'))
  returning id into v_pipeline_id;

  for r in
    select * from (values
      ('Novo contato',       'novo-contato',       false, false, 'new'),
      ('Já respondi',        'ja-respondi',        false, false, 'contacted'),
      ('Entendendo o caso',  'entendendo-o-caso',  false, false, 'qualifying'),
      ('Quer agendar',       'quer-agendar',       false, false, 'qualified'),
      ('Escolhendo horário', 'escolhendo-horario', false, false, 'negotiating'),
      ('Consulta marcada',   'consulta-marcada',   true,  false, 'won'),
      ('Não vai marcar',     'nao-vai-marcar',     false, true,  'lost')
    ) as t(stage_name, stage_slug, won, lost, hint)
  loop
    insert into public.crm_stages
      (organization_id, pipeline_id, name, slug, position, is_won, is_lost, agent_stage_hint)
    values (new.id, v_pipeline_id, r.stage_name, r.stage_slug, v_position, r.won, r.lost, r.hint);
    v_position := v_position + 1000;
  end loop;

  update public.organizations
     set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(
           'canonical_conversation_tags',
           jsonb_build_array('dúvida', 'agendamento', 'remarcação', 'orçamento',
                             'retorno', 'reclamação', 'elogio', 'urgente'))
   where id = new.id
     and not (coalesce(settings, '{}'::jsonb) ? 'canonical_conversation_tags');

  return new;
end$$;

create or replace function public.fn_aplicar_quadro_do_onboarding(
  p_organization_id uuid,
  p_pipeline_id uuid,
  p_nome text,
  p_slug text,
  p_etapas jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'pg_temp'
as $$
declare
  v_decididos bigint;
  v_fontes bigint;
  v_criadas bigint;
  v_antigas uuid[];
  v_primeira uuid;
begin
  perform 1 from public.crm_pipelines
   where id = p_pipeline_id and organization_id = p_organization_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'funil_nao_encontrado');
  end if;

  -- Cartão que chegou enquanto o onboarding corria vai para a primeira coluna
  -- nova (0421). Cartão em coluna de ganho/perda é decisão de alguém: recusa.
  select count(*) into v_decididos
    from public.crm_leads l
    join public.crm_stages s on s.id = l.stage_id
   where l.pipeline_id = p_pipeline_id
     and l.organization_id = p_organization_id
     and (s.is_won or s.is_lost);

  if v_decididos > 0 then
    return jsonb_build_object('ok', false, 'motivo', 'funil_com_negocios', 'quantos', v_decididos);
  end if;

  -- ON DELETE CASCADE: sem esta recusa, trocar as colunas apaga a fonte inteira.
  select count(*) into v_fontes
    from public.webhook_sources w
    join public.crm_stages s on s.id = w.default_stage_id
   where s.pipeline_id = p_pipeline_id;

  if v_fontes > 0 then
    return jsonb_build_object('ok', false, 'motivo', 'etapa_em_uso_por_webhook', 'quantos', v_fontes);
  end if;

  -- As antigas saem do caminho (slug e índices únicos parciais de ganho, perda
  -- e passo da IA) antes de as novas entrarem; os cartões mudam; as antigas saem.
  select array_agg(id) into v_antigas
    from public.crm_stages
   where pipeline_id = p_pipeline_id and organization_id = p_organization_id;

  update public.crm_stages
     set is_archived = true,
         slug = slug || '__troca_' || left(id::text, 8)
   where id = any(coalesce(v_antigas, '{}'));

  insert into public.crm_stages
    (organization_id, pipeline_id, name, slug, position, is_won, is_lost, agent_stage_hint)
  select p_organization_id,
         p_pipeline_id,
         e->>'nome',
         e->>'slug',
         (e->>'position')::numeric,
         coalesce((e->>'is_won')::boolean, false),
         coalesce((e->>'is_lost')::boolean, false),
         nullif(e->>'agent_stage_hint', '')
    from jsonb_array_elements(p_etapas) as e;
  get diagnostics v_criadas = row_count;

  select id into v_primeira
    from public.crm_stages
   where pipeline_id = p_pipeline_id
     and organization_id = p_organization_id
     and not is_archived and not is_won and not is_lost
   order by position
   limit 1;

  if v_primeira is null then
    raise exception 'quadro sem coluna aberta';
  end if;

  update public.crm_leads
     set stage_id = v_primeira
   where organization_id = p_organization_id
     and stage_id = any(coalesce(v_antigas, '{}'));

  delete from public.crm_stages where id = any(coalesce(v_antigas, '{}'));

  update public.crm_pipelines
     set name = p_nome,
         slug = p_slug,
         updated_at = now()
   where id = p_pipeline_id
     and organization_id = p_organization_id;

  return jsonb_build_object('ok', true, 'etapas', v_criadas);
end$$;

revoke execute on function public.fn_aplicar_quadro_do_onboarding(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.fn_aplicar_quadro_do_onboarding(uuid, uuid, text, text, jsonb)
  to service_role;

-- Instalação existente: só o "Pedidos" que ninguém tocou.
do $pedidos$
declare
  r record;
begin
  for r in
    select p.id, p.organization_id, p.is_default
      from public.crm_pipelines p
     where p.slug = 'pedidos'
       and p.name = 'Pedidos'
       and not p.is_archived
       and not exists (select 1 from public.crm_leads l where l.pipeline_id = p.id)
       and not exists (select 1 from public.webhook_sources w
                         join public.crm_stages s on s.id = w.default_stage_id
                        where s.pipeline_id = p.id)
       and (select array_agg(s.slug order by s.slug) from public.crm_stages s
             where s.pipeline_id = p.id)
           = array['aguardando_pagamento','cancelado','carrinho_abandonado','em_separacao',
                   'entregue','enviado','pago','pos_venda']
  loop
    if not r.is_default then
      update public.crm_pipelines set is_archived = true, updated_at = now() where id = r.id;
      continue;
    end if;
    if exists (select 1 from public.crm_pipelines o
                where o.organization_id = r.organization_id and o.slug = 'agendamentos') then
      continue;
    end if;

    delete from public.crm_stages where pipeline_id = r.id;

    insert into public.crm_stages
      (organization_id, pipeline_id, name, slug, position, is_won, is_lost, agent_stage_hint)
    select r.organization_id, r.id, t.nome, t.slug, t.pos, t.won, t.lost, t.hint
      from (values
        ('Novo contato',       'novo-contato',       1000, false, false, 'new'),
        ('Já respondi',        'ja-respondi',        2000, false, false, 'contacted'),
        ('Entendendo o caso',  'entendendo-o-caso',  3000, false, false, 'qualifying'),
        ('Quer agendar',       'quer-agendar',       4000, false, false, 'qualified'),
        ('Escolhendo horário', 'escolhendo-horario', 5000, false, false, 'negotiating'),
        ('Consulta marcada',   'consulta-marcada',   6000, true,  false, 'won'),
        ('Não vai marcar',     'nao-vai-marcar',     7000, false, true,  'lost')
      ) as t(nome, slug, pos, won, lost, hint);

    update public.crm_pipelines
       set name = 'Agendamentos',
           slug = 'agendamentos',
           vocabulary = jsonb_build_object('lead', 'Paciente', 'lead_plural', 'Pacientes',
                                 'deal', 'Atendimento', 'deal_plural', 'Atendimentos',
                                 'won', 'Consulta marcada', 'lost', 'Não vai marcar',
                                 'stage', 'Etapa', 'stage_plural', 'Etapas'),
           updated_at = now()
     where id = r.id;
  end loop;
end $pedidos$;

-- Etiquetas: só a lista de loja intocada (mesmos 8 itens, qualquer ordem).
update public.organizations
   set settings = jsonb_set(settings, '{canonical_conversation_tags}',
         jsonb_build_array('dúvida', 'agendamento', 'remarcação', 'orçamento',
                           'retorno', 'reclamação', 'elogio', 'urgente'))
 where jsonb_typeof(settings -> 'canonical_conversation_tags') = 'array'
   and (select array_agg(x order by x)
          from jsonb_array_elements_text(settings -> 'canonical_conversation_tags') x)
       = (select array_agg(x order by x) from unnest(array[
            'dúvida', 'reclamação', 'troca', 'devolução',
            'elogio', 'orçamento', 'pós-venda', 'urgente']) x);
-- ---- fim: clínica nasce com funil e etiquetas de clínica (migration 0421) ----
