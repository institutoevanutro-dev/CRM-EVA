-- Migration 0398 : CADA RESPOSTA RÁPIDA ESCOLHE SE APARECE NA BARRA DO INBOX.
--
-- Portado do projeto original (DeskcommCRM, PR #3311 de @webtecnica, issue
-- #3282; lá é a migration 0742). O SQL é o de lá.
--
-- A barra "Respostas rápidas" do Inbox mostra um botão por linha de
-- `message_templates` da organização. Com dezenas de respostas aparecem ali
-- textos que ninguém escolhe à mão (usados só pelo atalho `/`), e a única
-- saída era apagar a resposta — o que a tirava também do `/`.
--
-- `mostrar_na_barra = false` esconde o botão da barra; `true` (default) mantém
-- o comportamento de hoje. O atalho `/` ignora a coluna e continua listando
-- TODAS. Convive com a ordem da 0394: a barra segue a mesma ordem.
--
-- `add column if not exists` + `default true`: linhas existentes ficam
-- marcadas para aparecer, byte a byte o comportamento atual. Idempotente.

alter table public.message_templates
  add column if not exists mostrar_na_barra boolean not null default true;

comment on column public.message_templates.mostrar_na_barra is
  'Se a resposta rápida aparece na barra do Inbox (migration 0398). Default true: mantém o comportamento de sempre. O atalho / lista TODAS, independente deste campo.';
