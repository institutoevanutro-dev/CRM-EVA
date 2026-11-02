-- Migration 0399 : RESPOSTA A QUEM ESCREVEU NÃO GASTA NEM É BARRADA PELO TETO DO DIA.
--
-- Portado do projeto original (DeskcommCRM, PR #3769 de @ZvisionAutomations;
-- lá é a migration 9061). O SQL é o de lá.
--
-- O teto de aquecimento e o `daily_message_limit` contavam TODO envio do
-- `pacing_ledger`, e a resposta da IA a um lead que acabou de escrever ficava
-- para o dia seguinte quando o número batia o teto. Agora o teto mede só
-- DISPAROS (1ª mensagem, follow-up, campanha): esta coluna marca a linha
-- gravada por uma resposta, `loadPacingState` conta só `not resposta`, e
-- `decidePacing` não aplica o teto à resposta. A janela de resposta e o
-- espaçamento entre mensagens continuam valendo.
--
-- Default `false`: toda linha antiga e todo escritor que não declara segue
-- contando como disparo. Não cria função: nenhum grant a revogar. Idempotente.
alter table public.pacing_ledger
  add column if not exists resposta boolean not null default false;

comment on column public.pacing_ledger.resposta is
  'true = resposta a quem escreveu: vale para o espaçamento, não para o teto do dia (warm-up/daily_message_limit), que conta só disparos (migration 0399).';
