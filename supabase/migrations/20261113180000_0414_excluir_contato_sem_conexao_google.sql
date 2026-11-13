-- 0414 — Excluir contato: compromisso excluído sem conexão Google não segura a ficha
--
-- ── O beco que a 0413 deixou ──────────────────────────────────────────────────
-- A 0413 deixou o compromisso EXCLUÍDO (0364) sair junto com a ficha, menos o
-- que ainda devia algo ao Google (`google_pending_write`, ou evento com revisão
-- local à frente da sincronizada, ou `google_conflict`). Segurar esse caso é
-- certo enquanto existe quem sincronize: o worker retira o evento e a exclusão
-- passa a funcionar em minutos.
--
-- Mas há compromissos que nenhum worker vai alcançar nunca mais:
--   * `google_connection_id` NULO com evento no Google — a conexão foi apagada
--     (FK `on delete set null` da 0193; ex.: a pessoa removida do Auth) ou é
--     publicação anterior à 0193. `reconcileAppointment` lança "Publicação
--     antiga sem identidade completa" e o cron só itera por conexão;
--   * conexão `disconnected` — a pessoa (ou um gestor) desligou o Google na
--     Agenda. A rota de desconectar apaga os tokens e os calendários: não há
--     credencial para retirar o evento. A própria rota distingue "defasada"
--     (parou de atualizar, ainda é dela) de "desconectada" (a pessoa removeu).
-- Para esses, a ficha ficava presa para sempre, com a tela mandando "tentar de
-- novo em alguns minutos".
--
-- ── A regra nova ──────────────────────────────────────────────────────────────
-- O excluído sai junto também quando não há conexão capaz de sincronizá-lo.
-- Conexão nas outras situações (`token_expired`, `scope_missing`, `error`,
-- `rate_limited`, `connecting`, `healthy`) continua segurando: ela volta ao ar
-- ao reconectar, e então o worker retira o evento. Nesses casos a rota só
-- melhora a mensagem (em trânsito × travado) e aponta o compromisso na Agenda,
-- onde o painel "Sincronização Google" mostra o motivo e a saída.
--
-- ── O risco, e por que ele é aceito ───────────────────────────────────────────
-- O evento pode continuar no Google da pessoa (órfão). Mas ele já estava órfão:
-- sem conexão, segurar a linha não o retira — só segura a ficha. Se a mesma
-- conta for reconectada depois, a linha `disconnected` volta a `healthy` (o
-- callback faz upsert pela conta) e o worker retiraria o evento; apagando a
-- linha antes, essa retirada tardia não acontece. Para não perder o rastro, a
-- rota grava o `google_event_id` de cada um na linha `contact.deleted` do
-- `api_audit_log` (`compromissos_sem_conexao_no_google`).
--
-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Continua `security invoker`. A leitura de `calendar_connections` passa pela
-- policy `calendar_connections_dono_ou_manager_read`: o `manager` que a rota
-- exige enxerga as conexões da organização. Quem não as enxerga não vê a
-- conexão como desconectada — o erro fica do lado de SEGURAR a ficha.
-- Mesma assinatura e mesmo retorno: `create or replace` não abre janela.
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
  -- sai junto. 0414: e o excluído cuja conexão Google já não existe (nula pelo
  -- SET NULL, ou `disconnected`) — não há mais quem retire o evento. O resto
  -- (visível, ou excluído com Google pendente numa conexão viva) segura a
  -- ficha pelo RESTRICT abaixo e a transação inteira desfaz.
  delete from public.calendar_appointments a
   where a.contact_id = p_contact_id
     and a.organization_id = p_organization_id
     and a.excluded_at is not null
     and ((a.google_pending_write is null
           and (a.google_event_id is null
                or (a.google_local_revision = a.google_synced_local_revision and a.google_conflict is null)))
          or a.google_connection_id is null
          or exists (select 1 from public.calendar_connections k
                      where k.id = a.google_connection_id
                        and k.organization_id = a.organization_id
                        and k.status = 'disconnected'));

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
