-- 0437 — o desfecho do negócio alcança a origem: `lead.won` e `lead.lost` entram
-- na tabela de pares `(tipo, entidade) → contato`.
--
-- Porte de melgarafael/DeskcommCRM #5163 (issue #5077; migration 9470 lá), na
-- forma do fork.
--
-- ─── O defeito ─────────────────────────────────────────────────────────────
--
-- Uma regra "Quando um negócio for ganho" com uma ação de WhatsApp (enviar
-- mensagem, iniciar fluxo, mensagem da IA) terminava pela metade: o card do
-- `create_or_move_lead` nascia, e a ação de mensagem falhava por dentro. A causa
-- é `fn_service_event_origin`: ela pergunta o contato do evento a
-- `fn_service_event_contact` e, quando a tabela não conhece o par, levanta
-- `service_event_origin_unsupported` (`PT409`). A aplicação lê o `PT409` como
-- origem velha (`StaleServiceBoundaryError`) e nada sai. O `emit_event` usa a
-- MESMA tabela para carimbar `service_origin` no evento, então ele também não
-- carimbava. A mesma família da 0345 (aniversário, compromisso) e da 0369
-- (telefone ganho).
--
-- ─── Por que DOIS rótulos de entidade ──────────────────────────────────────
--
-- Os tipos `lead.created`, `lead.stage_changed` e `lead.tag_added` chegam com
-- `entity_kind='crm_lead'`. O desfecho não: quem o emite é
-- `fn_emit_event_on_lead_change`, por `fn_log_event('lead.won', …)`, e o
-- `fn_log_event` deriva a entidade do PREFIXO do tipo
-- (`split_part(p_event_type,'.',1)`). A linha de `event_log` nasce com
-- `entity_kind='lead'` — é o que `ENTIDADE_ESPERADA_POR_GATILHO` declara para
-- `lead.won` (`lib/schemas/webhooks.ts`). Aceitar só `crm_lead` faria a
-- consulta de prova passar e deixaria a recusa de pé no caminho real. Os dois
-- rótulos entram só no ramo de won/lost; os pares que já funcionavam seguem
-- com o mesmo `crm_lead`.
--
-- ─── O que NÃO muda ────────────────────────────────────────────────────────
--
-- `lead.reopened` e `lead.assigned` (o mesmo gatilho) ficam de fora de
-- propósito, e o `else` segue devolvendo `suportado=false` para o que não foi
-- mapeado. `fn_service_event_origin` não foi afrouxada. `revoke`/`grant`
-- idênticos aos da 0345. No fork, a perda não é gatilho de regra; o par entra
-- igual ao original, para o evento já nascer carimbado.
--
-- ─── Reaplicação ───────────────────────────────────────────────────────────
--
-- `create or replace function` de assinatura inalterada: rodar duas vezes não
-- erra e o corpo final é o mesmo. O corpo parte da ÚLTIMA definição do fork (a
-- da 0345 no baseline, com `contact.phone_added` da 0369 e
-- `appointment.attended` da 0373). No baseline a troca foi feita NO LUGAR,
-- nessa primeira e única definição.

create or replace function public.fn_service_event_contact(p_org uuid,p_event_type text,p_entity_kind text,p_entity_id uuid)
returns table(contact_id uuid,suportado boolean) language plpgsql stable security definer set search_path=public as $$
begin
 if p_event_type in ('lead.created','lead.stage_changed','lead.tag_added') and p_entity_kind='crm_lead' then
   return query select (select l.contact_id from public.crm_leads l where l.organization_id=p_org and l.id=p_entity_id),true;
 elsif p_event_type in ('lead.won','lead.lost') and p_entity_kind in ('crm_lead','lead') then
   -- 0437: desfecho do negócio (o gatilho de crm_leads grava entity_kind='lead').
   return query select (select l.contact_id from public.crm_leads l where l.organization_id=p_org and l.id=p_entity_id),true;
 elsif p_event_type in ('contact.tag_added','contact.birthday','contact.phone_added') and p_entity_kind='contact' then
   return query select (select c.id from public.contacts c where c.organization_id=p_org and c.id=p_entity_id),true;
 elsif p_event_type in ('appointment.created','appointment.confirmed','appointment.rescheduled','appointment.cancelled','appointment.completed','appointment.no_show') and p_entity_kind='calendar_appointment' then
   return query select (select a.contact_id from public.calendar_appointments a where a.organization_id=p_org and a.id=p_entity_id),true;
 elsif p_event_type='appointment.attended' and p_entity_kind='appointment' then
   -- 0373: presença confirmada pela equipe (emitida por fn_appointment_change_core).
   return query select (select a.contact_id from public.calendar_appointments a where a.organization_id=p_org and a.id=p_entity_id and a.status='completed'),true;
 else
   return query select null::uuid,false;
 end if;
end $$;
revoke all on function public.fn_service_event_contact(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.fn_service_event_contact(uuid,text,text,uuid) to service_role;
