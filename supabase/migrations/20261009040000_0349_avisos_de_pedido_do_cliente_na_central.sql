-- ============================================================================
-- 0349 — AVISOS DE PEDIDO DO CLIENTE NA CENTRAL
--
-- Porte da 0500 de melgarafael/DeskcommCRM (#1747, usada pelo #2246), sem o
-- Jev. Dois kinds novos em `agent_inbox_items`, com os nomes do upstream para
-- o porte do Jev reaproveitá-los: `jev_pedido_de_humano` e
-- `jev_parar_de_receber`. Hoje quem os abre é a REGRA do fork
-- (`lib/opt-out/deteccao.ts`) sobre a transcrição de um áudio que chegou
-- depois de o turno responder (`workers/media-derive-worker.pedidos.ts`).
-- Nada aqui bloqueia, passa, cala nem responde: é só aviso.
--
-- 1. A LISTA DO CHECK VEM INTEIRA, derivada do `supabase/baseline.sql` do
--    fork (não da 0500 do upstream, que tem kinds que o fork não tem):
--    `add constraint` substitui, e lista parcial apagaria aviso de outra
--    feature (`tests/unit/kind-check-migration-x-baseline.test.ts`).
--
-- Idempotente; sem BEGIN/COMMIT. As funções de gatilho nascem revogadas de
-- public, anon e authenticated: ninguém as chama. O baseline recebe os kinds
-- no bloco ÚNICO da constraint e o resto num bloco de apêndice.
-- ============================================================================

alter table public.agent_inbox_items
  drop constraint if exists agent_inbox_items_kind_check;

alter table public.agent_inbox_items
  add constraint agent_inbox_items_kind_check check (kind in (
    'appointment_outcome_required',
    'appointment_recovery_review',
    'qr_rescan',
    'routing_unassigned',
    'job_dead',
    'event_dead',
    'budget_exceeded',
    'handoff',
    'promotion_review',
    'judge_unaligned',
    'followup_dead',
    'snooze_expired',
    'next_action_ambiguous',
    'risk_backlog_seeded',
    'reactivation_expired',
    'capabilities_missing',
    'message_send_stuck',
    'midia_nao_lida',
    'channel_template_review',
    'channel_number_alert',
    'promise_unfulfilled',
    'contact_proposal_expired',
    'budget_warning',
    'conhecimento_nao_indexado',
    'voice_call_missed',
    'case_stale',
    'supervision_review',
    'sinal_revisao_humana',
    'instagram_comment_stuck',
    'jev_pedido_de_humano',
    'jev_parar_de_receber',
    'other'
  ));

-- 2. UM AVISO POR CONVERSA E PEDIDO, NO BANCO. Índice único parcial em
--    (organização, kind, conversa), sem status: o pedido novo REABRE o aviso
--    que existe (o gravador trata o 23505) em vez de abrir outro. Antes do
--    índice, os repetidos saem (fica o aberto e o mais novo), para o
--    `update.sh` de nenhum clone quebrar aqui.
delete from public.agent_inbox_items a
 using (
   select id, row_number() over (
            partition by organization_id, kind, ref_id
            order by (status = 'open') desc, created_at desc, id desc
          ) as n
     from public.agent_inbox_items
    where kind in ('jev_pedido_de_humano','jev_parar_de_receber')
 ) d
 where a.id = d.id and d.n > 1;
create unique index if not exists agent_inbox_jev_pedido_unico
  on public.agent_inbox_items (organization_id, kind, ref_id)
  where kind in ('jev_pedido_de_humano','jev_parar_de_receber');

-- 3. O AVISO FECHA QUANDO O PEDIDO FOI ATENDIDO, por qualquer caminho.
--    Conversa encerrada: os dois. Conversa com uma pessoa (assumida, ou
--    passada por `performHumanHandoff`, que grava `last_handoff_at` e cala o
--    robô): só o de falar com uma pessoa. O de parar de receber segue aberto
--    até o contato ser bloqueado (o STOP do próprio cliente, na entrada da
--    mensagem), quando fecha em todas as conversas dele. Nenhum gatilho faz
--    HTTP; os dois filtram a organização da própria linha.
create or replace function public.fn_fechar_avisos_do_jev_da_conversa()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.status not in('open','pending','claimed','ai_handling') then
  update public.agent_inbox_items set status='resolved',resolved_at=now()
   where organization_id=new.organization_id and ref_kind='conversation' and ref_id=new.id
     and kind in('jev_pedido_de_humano','jev_parar_de_receber') and status<>'resolved';
 elsif new.assigned_to_user_id is not null
    or (new.last_handoff_at is not null and new.last_handoff_at is distinct from old.last_handoff_at)
    or (new.bot_silenced_until > now() and new.bot_silenced_until is distinct from old.bot_silenced_until) then
  update public.agent_inbox_items set status='resolved',resolved_at=now()
   where organization_id=new.organization_id and ref_kind='conversation' and ref_id=new.id
     and kind='jev_pedido_de_humano' and status<>'resolved';
 end if;
 return new;
end;
$$;
revoke all on function public.fn_fechar_avisos_do_jev_da_conversa() from public, anon, authenticated;
drop trigger if exists trg_fechar_avisos_do_jev_da_conversa on public.conversations;
create trigger trg_fechar_avisos_do_jev_da_conversa
 after update of assigned_to_user_id, status, bot_silenced_until, last_handoff_at on public.conversations
 for each row execute function public.fn_fechar_avisos_do_jev_da_conversa();

create or replace function public.fn_fechar_aviso_do_jev_ao_bloquear()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 update public.agent_inbox_items set status='resolved',resolved_at=now()
  where organization_id=new.organization_id and kind='jev_parar_de_receber' and ref_kind='conversation'
    and status<>'resolved'
    and ref_id in(select v.id from public.conversations v where v.organization_id=new.organization_id and v.contact_id=new.id);
 return new;
end;
$$;
revoke all on function public.fn_fechar_aviso_do_jev_ao_bloquear() from public, anon, authenticated;
drop trigger if exists trg_fechar_aviso_do_jev_ao_bloquear on public.contacts;
create trigger trg_fechar_aviso_do_jev_ao_bloquear
 after update of is_blocked on public.contacts
 for each row when (new.is_blocked and old.is_blocked is distinct from true)
 execute function public.fn_fechar_aviso_do_jev_ao_bloquear();

notify pgrst, 'reload schema';
