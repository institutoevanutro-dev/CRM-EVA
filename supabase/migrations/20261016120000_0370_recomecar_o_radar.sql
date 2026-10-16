-- ============================================================================
-- 0370 — RECOMEÇAR O RADAR: o radar de risco passa a contar a partir de um instante
--
-- ─── O problema
--
-- Uma clínica que acabou de adotar o CRM abre o Radar de risco e encontra 241
-- "críticos" e 50 "demandas abertas sem próximo passo", todos das semanas em que
-- o sistema ainda não era usado. A lista não serve para trabalhar: o que pede
-- atenção hoje fica enterrado no que já não tem dono nem contexto.
--
-- ─── A regra
--
-- `organizations.settings.radar.desde` guarda o instante do recomeço. O radar
-- (`lib/leads/radar-de-risco.ts`, lido pela tela, pela rota e pela capacidade da
-- IA) ignora o negócio e a demanda cuja última atividade é anterior a ele. Quem
-- tiver atividade nova depois desse instante volta.
--
-- NADA é apagado nem alterado: leads, conversas e demandas ficam como estão.
-- Desfazer é limpar a chave, e o radar volta a ser o de antes.
--
-- ─── Por que uma função
--
-- `settings` é jsonb compartilhado (o provedor de IA mora nele). Ler, mesclar e
-- gravar pelo servidor deixaria duas escritas simultâneas de chaves diferentes
-- se apagarem. Esta função grava SÓ `settings.radar.desde`, num comando
-- (`jsonb_set` dentro de `radar`), com o relógio do banco (`now()`), nunca o de
-- quem chama. O instante sai em UTC com milissegundos, a forma de
-- `Date.prototype.toISOString`, que qualquer navegador lê.
--
-- Só `service_role` executa: a rota (`app/api/v1/leads/at-risk/recomeco`) exige
-- administrador, MFA e escrita de suporte, e passa a organização da sessão.
-- Aqui o papel é conferido de novo, contra `user_organizations` e `p_actor`
-- (nunca `auth.uid()`, que é nulo com a chave de serviço), mesmo desenho de
-- `fn_definir_frases_de_comentario`.
--
-- Devolve `{ desde, antes, mudou }`. Vigiado por
-- `tests/invariants/recomecar-o-radar.test.ts`.
-- ============================================================================

create or replace function public.fn_definir_inicio_do_radar(
  p_org uuid,
  p_actor uuid,
  p_recomecar boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_radar jsonb;
  v_antes text;
  v_depois text;
begin
  if p_org is null or p_actor is null or p_recomecar is null then
    raise exception 'inicio_do_radar_argumentos' using errcode = '22023';
  end if;

  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_org
          and uo.role = 'admin'
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     )
  then
    raise exception 'inicio_do_radar_sem_permissao' using errcode = '42501';
  end if;

  select case when jsonb_typeof(o.settings -> 'radar') = 'object' then o.settings -> 'radar' else '{}'::jsonb end
    into v_radar
    from public.organizations o
   where o.id = p_org
   for update;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;

  v_antes := case when jsonb_typeof(v_radar -> 'desde') = 'string' then v_radar ->> 'desde' end;
  v_depois := case
    when p_recomecar then to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  end;

  update public.organizations o
     set settings = jsonb_set(
           coalesce(o.settings, '{}'::jsonb),
           '{radar}',
           case when v_depois is null then v_radar - 'desde'
                else v_radar || jsonb_build_object('desde', v_depois) end,
           true)
   where o.id = p_org;

  return jsonb_build_object(
    'desde', v_depois,
    'antes', v_antes,
    'mudou', v_antes is distinct from v_depois
  );
end;
$$;

comment on function public.fn_definir_inicio_do_radar(uuid, uuid, boolean) is
  'Recomeça (p_recomecar = true, grava now()) ou desfaz (false, limpa) organizations.settings.radar.desde, '
  'o instante a partir do qual o radar de risco conta (migration 0370). Merge ATÔMICO dentro de settings.radar. '
  'Só admin da própria organização (user_organizations, por p_actor) ou super-admin de plataforma. '
  'Devolve {desde, antes, mudou}. Chamador: app/api/v1/leads/at-risk/recomeco/route.ts, com a chave de serviço.';

-- As DUAS origens de EXECUTE (CLAUDE.md, item 9): o grant a PUBLIC que o
-- Postgres dá ao criar a função, e o grant direto a anon do ALTER DEFAULT
-- PRIVILEGES. `authenticated` também sai: definer que escreve, alcançável por
-- qualquer usuário logado, seria escrita cross-tenant
-- (tests/invariants/hardening-definer-varredura.test.ts). O único chamador é a
-- rota, com a chave de serviço.
do $janela$ begin
  revoke execute on function public.fn_definir_inicio_do_radar(uuid, uuid, boolean) from public, anon, authenticated;
  grant execute on function public.fn_definir_inicio_do_radar(uuid, uuid, boolean) to service_role;
end $janela$;

notify pgrst, 'reload schema';
