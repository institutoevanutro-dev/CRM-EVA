-- 0412 — a conversa encerrada reabre mesmo quando a mensagem chega FORA DE ORDEM.
-- Portado do projeto original (DeskcommCRM, PR #3231 de @webtecnica, issue #3015).
--
-- O defeito: `fn_service_inbound` (disparado por `trg_demanda_abre_no_inbound` no
-- INSERT da mensagem) fazia
--
--   if m.sent_at <= c.service_closed_at then return; end if;
--   reopened := c.status in ('closed','resolved','archived');
--
-- e decidia a REABERTURA pela ordem do `sent_at` do canal. Mensagem que chega
-- depois do fechamento mas com horário anterior a ele (entrega atrasada, lote do
-- provedor, relógio do celular do paciente atrasado) era descartada em silêncio:
-- a conversa seguia encerrada COM a mensagem dentro, fora da Fila, sem erro.
--
-- O conserto: o guard vale só no caminho que NÃO reabre. Conversa encerrada +
-- mensagem inbound nova reabre, com `sent_at` anterior ou não. O episódio novo
-- começa em `greatest(m.sent_at, c.service_closed_at)`, nunca antes do fim do
-- anterior (senão a resposta do episódio encerrado entra no recorte do novo).
--
-- Continua protegido: reentrega da MESMA linha (topo devolve cedo quando
-- `m.service_revision is not null`; a ingestão deduplica por `external_id`) e a
-- segunda mensagem atrasada de um episódio já reaberto (a conversa já está
-- `open`, e o guard volta a valer). Recorte por par (contato, canal) intacto.
--
-- Diferença do original: o corpo upstream traz também "a conversa fica com quem
-- atendeu" (`keep_owner`) e o carimbo de grupo (#2729), que o fork não tem. Aqui
-- só as duas linhas do conserto entram, sobre o corpo vigente do fork.
--
-- `create or replace`, sem tabela, coluna, policy ou dado novo. Idempotente.

create or replace function public.fn_service_inbound(p_message uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.messages; c public.conversations; d public.demandas; reopened boolean; pre_contact uuid;
begin
 select * into m from public.messages where id = p_message;
 if not found or m.direction <> 'inbound' or m.service_revision is not null then return; end if;
 select * into c from public.conversations where id = m.conversation_id;
 if not found or c.organization_id is distinct from m.organization_id
    or c.channel_session_id is distinct from m.channel_session_id
    or not exists(select 1 from public.channel_sessions where id=m.channel_session_id and organization_id=m.organization_id)
 then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 if c.is_group or coalesce(c.group_chat_id,'') like '%@g.us' then return; end if;
 if c.contact_id is distinct from m.contact_id
    or not exists(select 1 from public.contacts where id=m.contact_id and organization_id=m.organization_id)
 then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 pre_contact:=c.contact_id;
 perform public.fn_service_lock(c.organization_id,c.contact_id);
 select * into c from public.conversations where id=m.conversation_id and organization_id=m.organization_id for no key update;
 if c.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 -- 0412: a ORDEM do `sent_at` decide se uma mensagem atrasada entra no episódio em
 -- curso, nunca se quem escreveu depois do fechamento volta a ser atendido. Só o
 -- caminho que NÃO reabre devolve cedo.
 reopened := c.status in ('closed','resolved','archived');
 if not reopened and m.sent_at <= c.service_closed_at then return; end if;
 if not reopened then
   select x.* into d from public.demandas x join public.demanda_conversas dc on dc.demanda_id=x.id
    where x.id=c.current_demanda_id and x.organization_id=c.organization_id and x.contact_id=c.contact_id
      and dc.organization_id=c.organization_id and dc.conversation_id=c.id
      and dc.service_revision=c.service_revision and x.fechada_em is null;
 end if;
 if d.id is null then
   insert into public.demandas(organization_id,contact_id,aberta_em,origem,estado,dono_kind,proximo_passo)
    values(c.organization_id,c.contact_id,m.sent_at,'inbound','aberta','ia','Responder à nova mensagem do cliente') returning * into d;
 end if;
 if reopened then
   update public.conversations set status='open', status_changed_at=clock_timestamp(),
     service_revision=service_revision+1,service_started_at=greatest(m.sent_at,c.service_closed_at),
     assigned_to_user_id=null,assigned_at=null,assignee_kind=null,active_ai_agent_id=null,
     current_demanda_id=d.id where id=c.id and organization_id=c.organization_id returning * into c;

 else
   update public.conversations set
     service_revision=service_revision+case when current_demanda_id is not null and current_demanda_id<>d.id then 1 else 0 end,
     service_started_at=case when current_demanda_id is not null and current_demanda_id<>d.id then m.sent_at else coalesce(service_started_at,m.sent_at) end,
     current_demanda_id=d.id
    where id=c.id and organization_id=c.organization_id returning * into c;
 end if;
 insert into public.demanda_conversas(organization_id,demanda_id,conversation_id,service_revision)
  values(c.organization_id,d.id,c.id,c.service_revision) on conflict(demanda_id,conversation_id)
  do update set service_revision=excluded.service_revision;
 update public.messages set service_revision=c.service_revision,demanda_id=d.id,demanda_revision=d.revision
  where id=m.id and organization_id=c.organization_id;
end; $$;
revoke execute on function public.fn_service_inbound(uuid) from public,anon,authenticated;
grant execute on function public.fn_service_inbound(uuid) to service_role;
