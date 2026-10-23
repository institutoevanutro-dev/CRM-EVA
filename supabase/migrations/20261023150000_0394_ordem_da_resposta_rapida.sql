-- Migration 0394 : A RESPOSTA RÁPIDA GANHA A ORDEM QUE O OPERADOR DEFINE.
--
-- Portado do projeto original (DeskcommCRM, PR #3261 de @webtecnica; lá é a
-- migration 0729).
--
-- `message_templates.ordem` é a POSIÇÃO da resposta rápida na lista da
-- organização. A listagem saía por `updated_at desc`: editar o texto de uma
-- resposta a empurrava para o topo da tela `/app/templates` e do Inbox (o menu
-- `/` e a barra "Respostas rápidas"), e não havia como voltar. A ordem passa a
-- ser dado da linha: a tela arrasta, o Inbox herda.
--
-- `numeric`, como `position_in_stage`: soltar entre duas respostas grava a
-- média entre elas (`lib/templates/ordem.ts`) e só a linha arrastada é escrita.
-- Inteiro obrigaria a renumerar a lista a cada arrasto, inclusive linhas que o
-- papel não escreve pela RLS (`message_templates_write`). Quando a média não
-- cabe mais entre as vizinhas (empate ou precisão esgotada), a rota renumera a
-- lista visível em passos de 1000.
--
-- Idempotente, e o backfill só roda quando a coluna NASCE: numera cada
-- organização na sequência que a tela `/app/templates` deste fork mostrava,
-- ASSUNTO POR ASSUNTO (`lib/respostas/organizar.ts`: o assunto é o prefixo do
-- título antes de " · "; os assuntos na ordem em que aparecem por `updated_at
-- desc`, os sem assunto por último, e dentro de cada um `updated_at desc`,
-- depois `id`). Adaptação do fork: o original numera só por `updated_at desc`,
-- porque a tela de lá não agrupa. Aqui isso deixaria os assuntos intercalados
-- na ordem global, e arrastar a primeira resposta de um assunto faria o assunto
-- inteiro pular de lugar na tela, já que ele aparece onde está a sua primeira.
-- Numerado assim, cada assunto nasce contíguo, a tela não muda e o Inbox passa
-- a mostrar a mesma sequência da tela.
--
-- Sem o guarda da coluna, todo `update.sh` renumeraria e apagaria a ordem
-- escolhida. Em banco novo a tabela está vazia e o backfill não escreve nada. O
-- UPDATE só toca `ordem`, então os gatilhos da 0383 (que olham
-- `media_item_ids` e `organization_id`) não disparam. Sem função nova e sem
-- policy nova: a RLS da 0060 já decide quem lê e quem escreve a coluna.

do $$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'message_templates'
       and column_name = 'ordem'
  ) then
    alter table public.message_templates
      add column ordem numeric not null default 0;

    with base as (
      select id,
             organization_id,
             case when strpos(title, ' · ') > 1
                  then lower(btrim(left(title, strpos(title, ' · ') - 1)))
                  else ''
             end as assunto,
             row_number() over (
               partition by organization_id
               order by updated_at desc, id
             ) as na_tela
        from public.message_templates
    ),
    assuntos as (
      select organization_id, assunto, min(na_tela) as primeira
        from base
       group by organization_id, assunto
    ),
    numeradas as (
      select b.id,
             row_number() over (
               partition by b.organization_id
               order by (a.assunto = ''), a.primeira, b.na_tela
             )::numeric * 1000 as posicao
        from base b
        join assuntos a
          on a.organization_id = b.organization_id
         and a.assunto = b.assunto
    )
    update public.message_templates as m
       set ordem = numeradas.posicao
      from numeradas
     where numeradas.id = m.id;
  end if;
end $$;

comment on column public.message_templates.ordem is
  'Posição da resposta rápida na lista da organização (migration 0394): menor primeiro; a tela grava por arrastar e soltar, a criação nasce um passo acima da primeira.';

-- O índice da leitura: a listagem filtra por organização e ordena por `ordem`.
create index if not exists idx_message_templates_org_ordem
  on public.message_templates (organization_id, ordem);

notify pgrst, 'reload schema';
