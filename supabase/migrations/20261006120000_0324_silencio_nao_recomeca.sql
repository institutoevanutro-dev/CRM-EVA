-- 0324: o gatilho de silêncio não recomeça
-- (spec docs/superpowers/specs/2026-10-06-followup-nao-recomeca-design.md).
--
-- (1) Índice da consulta de episódio (lib/followup/silence-sweep.ts,
--     loadUltimaInscricaoNoPonteiro): porte IDÊNTICO do 0411 do DeskcommCRM
--     original (2240b215e) — mesmo nome e colunas, para que um merge futuro do
--     0411 seja no-op. A consulta usa o prefixo (organization_id, pointer_id,
--     contact_id).
create index if not exists idx_followup_enrollments_pointer_contact_cooldown
  on public.followup_enrollments (organization_id, pointer_id, contact_id, updated_at);

-- (2) Vigência: desde quando o ponteiro vale com o status e o gatilho atuais.
--     A varredura de silêncio só conta silêncio cuja mensagem qualificante é
--     POSTERIOR a ela — ligar o fluxo não cobra quem calou antes.
--
--     Sem backfill, de propósito: a coluna nasce `not null default now()` num
--     comando só. Um backfill (versão ativa, updated_at) abria uma janela no
--     update.sh — que aplica o banco antes de trocar a imagem, sem
--     ON_ERROR_STOP — em que o app antigo grava ponteiro com NULL e o
--     `set not null` falha calado; e reabria o passado para fluxo publicado há
--     meses e só armado agora. O custo: na atualização, episódios em andamento
--     (silêncio menor que o limiar) não recebem a sequência. Erra para o lado
--     de não mandar.
alter table public.followup_flow_pointers
  add column if not exists active_since timestamptz not null default now();
comment on column public.followup_flow_pointers.active_since is
  'Desde quando o ponteiro vale com o status, o kind e os segments atuais do gatilho (trigger trg_followup_ponteiro_marca_vigencia). A varredura de silêncio ignora silêncio cuja última mensagem recebida é anterior. Trocar versão, limiar ou cancel_on_reply não mexe: só desativar e ativar de novo, mudar o kind ou os segmentos, ou armá-lo num agente quando nenhum o armava (trigger trg_followup_ponteiro_armado_marca_vigencia). Episódios em andamento nesse instante não recebem a sequência (erra para o lado de não mandar).';

create or replace function public.fn_followup_ponteiro_marca_vigencia()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.active_since := now();
  return new;
end
$$;
revoke execute on function public.fn_followup_ponteiro_marca_vigencia() from public, anon, authenticated;

drop trigger if exists trg_followup_ponteiro_marca_vigencia on public.followup_flow_pointers;
create trigger trg_followup_ponteiro_marca_vigencia
  before update on public.followup_flow_pointers
  for each row
  when (
    old.status is distinct from new.status
    or old.trigger_config ->> 'kind' is distinct from new.trigger_config ->> 'kind'
    or coalesce(old.trigger_config -> 'params' -> 'segments', '[]'::jsonb)
       is distinct from coalesce(new.trigger_config -> 'params' -> 'segments', '[]'::jsonb)
  )
  execute function public.fn_followup_ponteiro_marca_vigencia();

-- (3) Armar o ponteiro num agente também é passar a valer. O gate da varredura
--     (lib/followup/agent-followup-gate.ts) só libera o ponteiro que um agente
--     PUBLICADO arma (followup.enabled e flow_pointer_ids). Um fluxo ativo há
--     semanas e armado só agora inscreveria de uma vez todo silêncio desde a
--     vigência — o disparo em massa por outro caminho. Ao publicar uma versão
--     que arma o ponteiro, a vigência avança SE ninguém o armava até ali:
--     nem outro agente publicado, nem a versão que esta acabou de substituir
--     (fn_publish_ai_agent_version grava superseded_at = published_at da
--     nova, na mesma transação). Republicar o agente com o ponteiro ainda
--     armado não mexe — ajuste de prompt não descarta episódio em andamento.
--     Desarmar e armar de novo avança. Só UPDATE de status: publicar é UPDATE
--     (fn_publish_ai_agent_version); nenhum caminho insere versão já
--     publicada. `followup` é imutável fora do rascunho
--     (fn_ai_agent_version_content_immutable), então só a publicação arma.
create or replace function public.fn_followup_ponteiro_armado_marca_vigencia()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.followup -> 'enabled' is distinct from 'true'::jsonb
     or jsonb_typeof(new.followup -> 'flow_pointer_ids') is distinct from 'array' then
    return null;
  end if;
  update public.followup_flow_pointers p
     set active_since = now()
   where p.organization_id = new.organization_id
     and new.followup -> 'flow_pointer_ids' ? p.id::text
     and not exists (
       select 1 from public.ai_agent_versions v
        where v.organization_id = new.organization_id
          and v.id <> new.id
          and v.followup -> 'enabled' = 'true'::jsonb
          and v.followup -> 'flow_pointer_ids' ? p.id::text
          and (v.status = 'published'
               or (v.agent_id = new.agent_id and v.status = 'superseded'
                   and v.superseded_at = new.published_at)));
  return null;
end
$$;
revoke execute on function public.fn_followup_ponteiro_armado_marca_vigencia() from public, anon, authenticated;

drop trigger if exists trg_followup_ponteiro_armado_marca_vigencia on public.ai_agent_versions;
create trigger trg_followup_ponteiro_armado_marca_vigencia
  after update of status on public.ai_agent_versions
  for each row
  when (new.status = 'published' and old.status is distinct from 'published')
  execute function public.fn_followup_ponteiro_armado_marca_vigencia();
