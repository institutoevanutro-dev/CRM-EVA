-- 0413 — Excluir contato não esbarra mais em compromisso que a Agenda já excluiu
--
-- ── O incidente (13/11, produção) ─────────────────────────────────────────────
-- A recepção tentou excluir um contato duplicado e recebeu 409, "Este contato
-- tem 1 compromisso na Agenda". O único compromisso estava `status='cancelled'`
-- e com `excluded_at` preenchido: excluído pela 0364, invisível na Agenda, nas
-- listas e para a IA. Não havia saída pela tela; foi preciso apagar por SQL.
--
-- `calendar_appointments.contact_id` é `on delete restrict` (0177) e
-- `fn_apagar_contato_com_historico` (0340) não tocava na agenda: qualquer
-- compromisso, até o que ninguém mais vê, segurava a ficha para sempre.
--
-- ── A regra nova (dentro da MESMA transação da 0340) ──────────────────────────
-- Antes do histórico, a função apaga os compromissos EXCLUÍDOS do contato que o
-- Google já não espera mais:
--   * `excluded_at is not null` — a pessoa já o tirou da Agenda (0364);
--   * `google_pending_write is null` — nenhuma escrita ao Google em voo;
--   * e, se o compromisso chegou a existir no Google (`google_event_id`), a ida
--     está quitada: `google_local_revision = google_synced_local_revision` e
--     sem `google_conflict`. Sem `google_event_id` não há o que retirar de lá: o
--     worker de ida só confirma (`ack`) o cancelado sem evento
--     (`lib/agenda/google/sync-executor.ts`), então a revisão local maior que a
--     sincronizada, nesse caso, não é pendência — é o estado normal de quem não
--     usa o Google.
-- Todo o resto continua segurando a ficha pelo RESTRICT, e a transação inteira
-- desfaz: compromisso visível (ativo, cancelado, realizado, falta) é histórico,
-- e excluído com Google pendente sumiria daqui deixando o evento lá.
-- A rota (`deleteContactHandler`) faz a mesma conta ANTES, para dar a mensagem
-- certa; quem garante é o banco — sem janela em que a ficha saia e o
-- compromisso fique, ou o contrário.
--
-- ── O que apagar a linha leva junto (medido nas FKs do baseline) ──────────────
--   * `ad_conversion_dispatches.appointment_id` CASCADE — o envio de conversão
--     de um agendamento que foi excluído como engano/teste;
--   * `appointment_recovery_receipts.appointment_id` CASCADE — recibo de
--     pós-consulta (excluído não tem consulta para recuperar);
--   * `followup_enrollments.appointment_id` SET NULL — `fn_followup_revision`
--     encerra a inscrição; as do próprio contato saem em cascata com a ficha;
--   * `calendar_appointments.rescheduled_from_id` SET NULL — a remarcação fica;
--   * `crm_lead_links` do compromisso — `trg_limpar_vinculos_do_agendamento`.
-- A 0364 guardava a linha excluída "para auditoria". Essa prova não se perde:
-- quem excluiu, quando e por quê está em `api_audit_log`
-- (`agenda.appointment_excluded`, append-only, 5 anos), e a rota registra os
-- ids apagados na linha `contact.deleted`.
--
-- ── Permissões ────────────────────────────────────────────────────────────────
-- Continua `security invoker`: a RLS de quem chama vale (`contacts_delete` e
-- `calendar_appointments_delete` — a rota já exige `manager`), e
-- `p_organization_id` fecha as linhas por dentro. Mesma assinatura e mesmo
-- retorno: `create or replace` não abre janela. O par revoke/grant é repetido
-- por idempotência.
--
-- Gates: `tests/invariants/excluir-contato-com-compromisso-excluido.test.ts` e
-- `tests/unit/contato-delete.test.ts`.

create or replace function public.fn_apagar_contato_com_historico(
  p_contact_id uuid,
  p_organization_id uuid
)
returns boolean
language plpgsql
volatile
security invoker
set search_path to 'public', 'pg_temp'
as $$
begin
  -- 0413: o compromisso que a Agenda já excluiu e que o Google não espera mais
  -- sai junto. O resto (visível, ou excluído com Google pendente) segura a
  -- ficha pelo RESTRICT abaixo e a transação inteira desfaz.
  delete from public.calendar_appointments
   where contact_id = p_contact_id
     and organization_id = p_organization_id
     and excluded_at is not null
     and google_pending_write is null
     and (google_event_id is null
          or (google_local_revision = google_synced_local_revision and google_conflict is null));

  -- RESTRICT da #752: o histórico sai antes da ficha, na mesma transação.
  delete from public.messages
   where contact_id = p_contact_id
     and organization_id = p_organization_id;

  delete from public.conversations
   where contact_id = p_contact_id
     and organization_id = p_organization_id;

  delete from public.contacts
   where id = p_contact_id
     and organization_id = p_organization_id;

  -- `found` é do DELETE da ficha: false = a ficha não estava acessível para quem
  -- chamou (outra organização, RLS, corrida) — a rota devolve 404 nesse caso.
  return found;
end;
$$;

revoke execute on function public.fn_apagar_contato_com_historico(uuid, uuid) from public, anon;
grant  execute on function public.fn_apagar_contato_com_historico(uuid, uuid) to authenticated, service_role;

notify pgrst, 'reload schema';
