-- ============================================================================
-- 0383 — A RESPOSTA RÁPIDA LEVA IMAGENS DA BIBLIOTECA DE MÍDIA
-- Portado e adaptado do projeto original (DeskcommCRM, PR #2704 de @webtecnica;
-- 0643 lá). Lá a resposta guardava arquivos próprios; aqui ela APONTA para
-- itens da Biblioteca de mídia (`media_library_items`, migration 0326) — a
-- mesma que agentes e acompanhamentos usam, com o mesmo termo de uso de imagem
-- conferido no envio e o mesmo bucket privado `media-library`.
--
-- ─── A coluna ────────────────────────────────────────────────────────────────
--
-- `message_templates.media_item_ids uuid[]`: até 5 itens, na ordem em que saem.
-- Um array e não uma tabela de ligação: a lista é lida e reescrita inteira, num
-- UPDATE só (o PATCH da tela), e a ordem é a do próprio array. Default `{}`:
-- toda resposta existente continua só de texto, nenhuma linha muda.
--
-- ─── A organização do item é a da resposta (gatilho na escrita) ─────────────
--
-- `fn_midias_da_resposta_rapida_conferir` (invoker): todo id tem de existir em
-- `media_library_items` DA MESMA organização da linha, sem repetição (42501
-- `midia_da_resposta_rapida_fora_da_biblioteca`). Vale para qualquer escrita —
-- sessão, service role ou migration. Pela sessão a RLS da biblioteca já
-- esconde item de outra organização; o filtro explícito por `organization_id`
-- fecha também o service role.
--
-- ─── Apagar item em uso é recusado (gatilho na biblioteca) ──────────────────
--
-- `fn_midia_em_resposta_rapida_nao_sai` (`security definer`, porque resposta
-- PESSOAL de outro usuário é invisível pela RLS a quem apaga): apagar um item
-- que alguma resposta da organização usa levanta 23503
-- `midia_em_resposta_rapida`. Escolhido em vez de "pular a imagem que sumiu":
-- a resposta mudaria o que a equipe envia sem ninguém ter mexido nela, e o
-- aviso só apareceria no meio do atendimento. Recusar diz a quem apaga, na
-- hora, o que depende do item. (Termo vencido ou revogado continua sendo
-- recusado no ENVIO, item a item, com aviso — isso não se resolve aqui.)
-- Quando a ORGANIZAÇÃO é apagada (cascade), a linha dela já não existe e o
-- gatilho deixa o item sair: a resposta sai pelo mesmo cascade.
--
-- Idempotente: `add column if not exists`, constraint criada só quando falta,
-- `create or replace` nas funções e nos gatilhos.
-- ============================================================================

alter table public.message_templates
  add column if not exists media_item_ids uuid[] not null default '{}';

-- Só cria quando falta: reaplicar (`update.sh`) não derruba a constraint nem
-- por um comando (`reaplicar-o-baseline-nao-abre-janela.test.ts`).
do $janela$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'message_templates_media_item_ids_maxima'
                    and conrelid = 'public.message_templates'::regclass) then
    alter table public.message_templates
      add constraint message_templates_media_item_ids_maxima
      check (cardinality(media_item_ids) <= 5);
  end if;
end $janela$;

create index if not exists idx_message_templates_media_item_ids
  on public.message_templates using gin (media_item_ids)
  where media_item_ids <> '{}';

create or replace function public.fn_midias_da_resposta_rapida_conferir()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if cardinality(new.media_item_ids) <> (select count(distinct x) from unnest(new.media_item_ids) x)
     or exists (
       select 1 from unnest(new.media_item_ids) x
        where not exists (
          select 1 from public.media_library_items m
           where m.id = x and m.organization_id = new.organization_id)) then
    raise exception 'midia_da_resposta_rapida_fora_da_biblioteca' using errcode = '42501';
  end if;
  return new;
end $$;

comment on function public.fn_midias_da_resposta_rapida_conferir() is
  'Guarda de message_templates (migration 0383): todo id de media_item_ids é item da Biblioteca de mídia da MESMA '
  'organização, sem repetição; 42501 midia_da_resposta_rapida_fora_da_biblioteca. '
  'Provado em tests/invariants/midia-da-resposta-rapida.test.ts.';

revoke execute on function public.fn_midias_da_resposta_rapida_conferir() from public, anon, authenticated;

create or replace trigger trg_midias_da_resposta_rapida_insert
  before insert on public.message_templates
  for each row
  when (new.media_item_ids <> '{}')
  execute function public.fn_midias_da_resposta_rapida_conferir();

create or replace trigger trg_midias_da_resposta_rapida_update
  before update on public.message_templates
  for each row
  when (new.media_item_ids <> '{}'
        and (old.media_item_ids is distinct from new.media_item_ids
             or old.organization_id is distinct from new.organization_id))
  execute function public.fn_midias_da_resposta_rapida_conferir();

create or replace function public.fn_midia_em_resposta_rapida_nao_sai()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.organizations o where o.id = old.organization_id)
     and exists (
       select 1 from public.message_templates t
        where t.organization_id = old.organization_id
          and t.media_item_ids @> array[old.id]) then
    raise exception 'midia_em_resposta_rapida' using errcode = '23503';
  end if;
  return old;
end $$;

comment on function public.fn_midia_em_resposta_rapida_nao_sai() is
  'Guarda de media_library_items (migration 0383): item usado por resposta rápida da organização não é apagado '
  '(23503 midia_em_resposta_rapida); apagar a organização inteira passa. '
  'Provado em tests/invariants/midia-da-resposta-rapida.test.ts.';

revoke execute on function public.fn_midia_em_resposta_rapida_nao_sai() from public, anon, authenticated;

create or replace trigger trg_midia_em_resposta_rapida_nao_sai
  before delete on public.media_library_items
  for each row
  execute function public.fn_midia_em_resposta_rapida_nao_sai();

notify pgrst, 'reload schema';
