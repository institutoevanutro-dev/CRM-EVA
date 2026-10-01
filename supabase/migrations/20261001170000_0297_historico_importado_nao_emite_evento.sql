-- 0297 — Mensagem IMPORTADA DO HISTÓRICO do celular (coexistência) não acorda ninguém.
-- `messages` tem três AFTER INSERT: `trg_messages_emit_event` emite
-- `message.*` (IA, sentimento, follow-up, push, automação);
-- `trg_demanda_abre_no_inbound` abre uma `demandas` por contato com inbound
-- (180 dias de histórico = uma demanda "sem próximo passo" por contato);
-- `trg_reply_inbound_revision` incrementa `reply_context_revision`. Um worker
-- que "não chama a IA" não basta: o banco chama por ele. A guarda vive nos
-- gatilhos porque é o único lugar por onde TODOS os consumidores passam.
-- Corpos derivados das versões em vigor; só a guarda entra em cada um.
create or replace function public.fn_emit_message_event() returns trigger
language plpgsql set search_path to 'public', 'pg_temp' as $$
declare
  v_event text;
begin
  if coalesce(new.metadata->>'importada_do_historico', '') = 'true' then
    return new;
  end if;
  if new.direction = 'inbound' then
    v_event := 'message.received';
  else
    v_event := case new.status
                 when 'sending' then 'message.sending'
                 when 'sent' then 'message.sent'
                 when 'failed' then 'message.failed'
                 else 'message.outbound'
               end;
  end if;
  perform public.fn_log_event(
    new.organization_id, v_event,
    jsonb_build_object(
      'message_id', new.id, 'conversation_id', new.conversation_id,
      'contact_id', new.contact_id, 'direction', new.direction,
      'type', new.type, 'status', new.status, 'external_id', new.external_id,
      'channel_session_id', new.channel_session_id,
      'body_preview', left(new.body, 280)
    )
  );
  return new;
end$$;

-- A demanda: a guarda entra ANTES de `fn_service_inbound`, para o histórico
-- nem chegar lá.
create or replace function public.fn_demanda_abre_no_inbound()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if coalesce(new.metadata->>'importada_do_historico', '') = 'true' then
    return new;
  end if;
  perform public.fn_service_inbound(new.id);
  return new;
end; $$;
revoke execute on function public.fn_demanda_abre_no_inbound() from public, anon, authenticated;

-- A revisão de contexto de resposta: histórico importado não é inbound ao vivo
-- (o comentário da função já dizia isso; agora o corpo também).
create or replace function public.fn_reply_inbound_revision()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.direction = 'inbound' and coalesce(new.metadata->>'importada_do_historico', '') <> 'true' then
    update public.conversations set reply_context_revision = reply_context_revision + 1
     where organization_id = new.organization_id and id = new.conversation_id and contact_id = new.contact_id;
  end if;
  return new;
end; $$;
revoke all on function public.fn_reply_inbound_revision() from public, anon, authenticated;
