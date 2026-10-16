-- Migration 0366 : CONTATO "SEMPRE ATENDIMENTO HUMANO".
--
-- Porte da 0624 (#2671, @webtecnica) e da 0676 (#2924, @melgarafael) do
-- upstream, adaptado. `contacts.force_human` é a trava do HANDOFF: nasce na
-- escalação e morre quando o atendimento é devolvido ao automático. Faltava uma
-- marca PERMANENTE, que nenhuma devolução desfaz: "este contato a IA nunca
-- atende".
--
-- `ai_opt_out` é essa marca, e o banco garante a regra que importa: enquanto ela
-- estiver ligada, `force_human` fica ligado. Toda guarda da IA já lê
-- `force_human` (turno de entrada, roteador, follow-up, envio da agenda pela IA,
-- worker nativo, before-send), então a marca cala a IA em todos esses caminhos
-- sem uma segunda regra para cada um. O gatilho também segura a escrita que
-- tentar soltar `force_human` por outro lado (a corrida entre marcar e devolver
-- que a 0676 do upstream fechou em código).
--
-- Desligar a marca NÃO devolve o atendimento: `force_human` continua ligado até
-- alguém clicar em "Devolver ao automático". O envio humano não muda nada.
-- Vigiado por tests/invariants/contato-sempre-humano.test.ts.

alter table public.contacts add column if not exists ai_opt_out boolean not null default false;

comment on column public.contacts.ai_opt_out is
  'Sempre atendimento humano (migration 0366): a IA nunca atende este contato. Enquanto true, o gatilho trg_contacts_ai_opt_out_segura_humano mantém force_human = true. A devolução ao automático é recusada.';

-- `authenticated` lê contacts por grant de COLUNA (0289: tudo menos cpf_hash), e
-- coluna nova não entra sozinha nesse grant. Sem esta linha a ficha do contato
-- recusaria a leitura inteira.
grant select (ai_opt_out) on public.contacts to authenticated;

create or replace function public.fn_contacts_ai_opt_out_segura_humano()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.force_human := true;
  return new;
end;
$$;

revoke execute on function public.fn_contacts_ai_opt_out_segura_humano() from public, anon, authenticated;

create or replace trigger trg_contacts_ai_opt_out_segura_humano
  before insert or update of ai_opt_out, force_human on public.contacts
  for each row
  when (new.ai_opt_out)
  execute function public.fn_contacts_ai_opt_out_segura_humano();
