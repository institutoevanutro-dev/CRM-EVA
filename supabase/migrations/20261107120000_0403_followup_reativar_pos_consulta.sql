-- 0403 — Reativar o follow-up pós-consulta encerrado pela trava de envio.
--
-- A 4.51.0 trouxe POST /api/v1/ai/followups/enrollments/:id/reactivate, mas o
-- gatilho trg_followup_revision recusava (followup_stale) toda volta de
-- 'cancelled' para 'active' em inscrição presa a uma consulta — exatamente o
-- caso para o qual a reativação existe. Agora a volta é aceita só quando o
-- cancelamento foi a recusa do envio (MOTIVO_ENVIO_VETADO); recibo válido,
-- consulta no mesmo desfecho e mesmo contato continuam exigidos.
-- Idempotente: create or replace.

create or replace function public.fn_followup_revision()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 -- Origem da recuperação é imutável, inclusive para quem pode editar o fluxo.
 -- Só o desaparecimento real da FK permite apagar a referência, cancelando-o.
 if old.appointment_revision is not null then
  new.appointment_revision:=old.appointment_revision;
  if new.appointment_id is null and not exists(select 1 from public.calendar_appointments where organization_id=old.organization_id and id=old.appointment_id) then
   new.status:='cancelled';new.cancel_reason:='O compromisso foi removido.';new.next_eval_at:=null;new.claimed_until:=null;new.completed_at:=now();
  else new.appointment_id:=old.appointment_id; end if;
  if new.contact_id is distinct from old.contact_id then
   new.status:='cancelled';new.cancel_reason:='O contato do compromisso mudou.';new.next_eval_at:=null;new.claimed_until:=null;new.completed_at:=now();
  end if;
 end if;
 if new.appointment_revision is not null and new.status in ('active','waiting_reply','paused_handoff','paused_manual') then
  -- P0001, não 40001: 40001 é serialization_failure e o cliente retenta para
  -- sempre. followup_stale é permanente. Medido: 6000 erros/min, CPU 100%, 24h.
  -- 0403: a única volta de 'cancelled' é a reativação manual do que a trava de
  -- envio recusou (MOTIVO_ENVIO_VETADO em send-ledger.ts). O recibo e a consulta
  -- continuam exigidos abaixo: desfazer a presença segue impedindo a volta.
  if (old.status not in ('active','waiting_reply','paused_handoff','paused_manual')
      and not (old.status='cancelled' and old.cancel_reason='O envio foi recusado pelas regras do atendimento.')) or not exists(
   select 1 from public.calendar_appointments a join public.appointment_recovery_receipts r
    on r.organization_id=a.organization_id and r.appointment_id=a.id and r.appointment_revision=a.revision
   where a.organization_id=new.organization_id and a.id=new.appointment_id and a.revision=new.appointment_revision
    and a.status in ('no_show','completed') and a.contact_id=new.contact_id and r.result='started' and r.invalidated_at is null
  ) then raise exception 'followup_stale' using errcode='P0001'; end if;
 end if;
 new.revision:=old.revision+1; return new;
end; $$;
revoke all on function public.fn_followup_revision() from public,anon,authenticated;
create or replace trigger trg_followup_revision before update on public.followup_enrollments for each row execute function public.fn_followup_revision();
