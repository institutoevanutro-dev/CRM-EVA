-- Migration 0378 : O AVISO DE MENSAGEM NOVA VAI SÓ A QUEM PODE VER A CONVERSA.
--
-- Portado do projeto original (DeskcommCRM, PR #2590 de @melgarafael; lá é a
-- migration 0612).
--
-- O defeito: o push de `message.received` (celular e bandeja do computador)
-- saía para TODAS as inscrições da organização (`enviarPushDaOrg`). Com o
-- nome do contato e a prévia da mensagem no aviso, o profissional que só pode
-- ver as conversas atribuídas a ele recebia, na tela de bloqueio, o começo da
-- conversa de qualquer paciente — sigilo médico vazando pela notificação.
--
-- Quem pode ver uma conversa é decidido num lugar só: `fn_can_view_conversation`
-- (a RLS de `conversations`, migration 0035, com o papel `provider` deste fork).
-- Ela pergunta por `auth.uid()`, e o envio do push roda com service role, sem
-- usuário. Esta função avalia a MESMA regra para cada inscrito: põe o `sub`
-- dele nos claims da transação, chama a função da RLS e devolve as claims de
-- quem chamou. Nenhuma cópia da regra (papel, visibility_mode, dono da
-- conversa, vínculo revogado) mora aqui — mudou a régua da inbox, mudou o push.
--
-- Quem atende a conversa (`assigned_to_user_id`) com vínculo ativo sempre
-- passa pela régua; vínculo revogado nunca.
-- Conversa inexistente ou de outra organização: nenhuma inscrição.
-- Só o service role executa (o worker de eventos); nenhum papel do PostgREST.
-- Idempotente (create or replace + grants). No baseline, bloco antes da
-- VARREDURA anon, com o mesmo corpo
-- (tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts).
-- Prova: tests/invariants/push-so-a-quem-ve-a-conversa.test.ts.

create or replace function public.fn_push_inscricoes_que_veem_a_conversa(
  p_org uuid,
  p_conversation uuid
) returns table (id uuid, user_id uuid, endpoint text, p256dh text, auth text)
language plpgsql volatile security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_assigned uuid;
  v_user uuid;
  v_claims text := current_setting('request.jwt.claims', true);
  v_claim text := current_setting('request.jwt.claim', true);
  v_sub text := current_setting('request.jwt.claim.sub', true);
begin
  select c.assigned_to_user_id into v_assigned
    from public.conversations c
   where c.id = p_conversation and c.organization_id = p_org;
  if not found then
    return;
  end if;

  -- auth.uid()/auth.jwt() leem estas três; só `claims` carrega o inscrito.
  perform set_config('request.jwt.claim', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  for v_user in
    select distinct s.user_id from public.push_subscriptions s where s.organization_id = p_org
     order by s.user_id
  loop
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user)::text, true);
    if public.fn_can_view_conversation(p_org, v_assigned) then
      return query
        select s.id, s.user_id, s.endpoint, s.p256dh, s.auth
          from public.push_subscriptions s
         where s.organization_id = p_org and s.user_id = v_user;
    end if;
  end loop;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim', coalesce(v_claim, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end;
$$;

revoke execute on function public.fn_push_inscricoes_que_veem_a_conversa(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_push_inscricoes_que_veem_a_conversa(uuid, uuid) to service_role;
