-- 0418: follow-up de silêncio sem retroativo — marca de quando o acesso da IA
-- ao canal mudou.
--
-- Incidente (clínica Rosa, 17/11/2026): o acesso da IA ao canal foi aberto pela
-- tela às 00:39 e a varredura de silêncio (lib/followup/silence-sweep.ts)
-- inscreveu de uma vez 80 conversas paradas desde 02/11 — o gate do canal, que
-- até ali barrava todos, passou a deixá-los entrar, e nada dizia desde quando.
-- Às 10:00, com a janela de envio aberta, saíram 68 mensagens em 21 conversas.
--
-- `channel_sessions.ai_access_since` é esse "desde quando": a varredura só
-- conta silêncio cuja última mensagem é POSTERIOR a ele (além da vigência do
-- ponteiro, da publicação da versão ativa e de um teto de idade, que moram no
-- TypeScript). Nula = canal que nunca mudou de acesso depois desta migration:
-- sem piso por canal (o teto de idade continua valendo). Sem backfill, de
-- propósito: não há fonte confiável do instante antigo, e o teto cobre o legado.
--
-- Quem grava é um trigger, não a RPC da tela: qualquer caminho que mude o
-- alcance da IA (fn_configurar_pre_go_live_canal, script de suporte, UPDATE
-- manual) avança a marca. Muda quando qualquer uma das três chaves do gate
-- muda — abrir, fechar ou mexer na lista de testadores. Fechar também avança:
-- erra para o lado de não mandar. O trigger não faz HTTP.

alter table public.channel_sessions
  add column if not exists ai_access_since timestamptz;
comment on column public.channel_sessions.ai_access_since is
  'Última vez que o alcance da IA no canal mudou (metadata.ai_gate, ai_gate_mode ou ai_test_phone_numbers), gravado pelo trigger trg_canal_marca_acesso_da_ia. A varredura de silêncio não cobra silêncio anterior. Nula = sem mudança desde a migration 0418. Migration 0418.';

create or replace function public.fn_canal_marca_acesso_da_ia()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.ai_access_since := now();
  return new;
end
$$;
revoke execute on function public.fn_canal_marca_acesso_da_ia() from public, anon, authenticated;

create or replace trigger trg_canal_marca_acesso_da_ia
  before update of metadata on public.channel_sessions
  for each row
  when (
    old.metadata -> 'ai_gate' is distinct from new.metadata -> 'ai_gate'
    or old.metadata -> 'ai_gate_mode' is distinct from new.metadata -> 'ai_gate_mode'
    or old.metadata -> 'ai_test_phone_numbers' is distinct from new.metadata -> 'ai_test_phone_numbers'
  )
  execute function public.fn_canal_marca_acesso_da_ia();
