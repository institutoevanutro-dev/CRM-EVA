-- 0355: o export do titular é reivindicado pelo worker.
--
-- O bloco abaixo é o MESMO, letra a letra, do apêndice de `supabase/baseline.sql`:
-- é ele que o deploy reaplica a cada atualização.

-- ---- o export do titular é reivindicado pelo worker (migration 0355) ----
-- Porte da 0652 de melgarafael/DeskcommCRM #2752 (@Tong-bit-art, issue 2751 lá).
--
-- O worker de exportação LGPD só pulava pedido `completed`. Dois eventos do
-- MESMO pedido (o webhook e a aprovação emitem `lgpd.data_request_received`
-- cada um, e o reaper do `event_log` devolve à fila um evento preso), drenados
-- em paralelo pelo laço do worker e pelo cron, liam o mesmo `attempts` e
-- exportavam duas vezes: `attempts=2`, dois `lgpd.export_generated`, o PDF
-- montado e o e-mail enviado em dobro.
--
-- A reivindicação é ATÔMICA e exclusiva: só quem consegue gravar
-- `export_claimed_at` exporta; o segundo evento vira `skipped`. O marcador é do
-- WORKER porque a aprovação TAMBÉM grava `processing` (é o estado que a tela
-- mostra): `status` sozinho não distingue "aprovado, ainda na fila" de
-- "exportando agora". A janela de 10 min espelha o reaper do `event_log`
-- (`PROCESSING_STALE_MS`, `lib/event-log/drain.ts`): processo derrubado no meio
-- é retomado pelo próximo evento; a falha que devolve o pedido a `received`
-- LIMPA a reivindicação, para o retry não esperar a janela.
--
-- Coluna nullable, sem default e sem índice: nenhuma linha existente muda, e a
-- trava é o UPDATE por chave primária.

alter table public.lgpd_requests
  add column if not exists export_claimed_at timestamptz;

comment on column public.lgpd_requests.export_claimed_at is
  'Instante da reivindicação do worker de exportação: só quem grava este marcador exporta o pedido. Reivindicação mais velha que 10 min é considerada órfã (processo derrubado) e pode ser retomada; a falha que devolve o pedido a received zera o marcador para o retry imediato.';
