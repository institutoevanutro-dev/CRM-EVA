-- Migration 0404 : O PUSH DE MENSAGEM NOVA VIRA ESCOLHA DE QUEM SE INSCREVEU.
--
-- O defeito: quem ligava o push no celular para receber os avisos da Central
-- que pedem gente (a IA pedindo a equipe, kind `handoff`) recebia também TODA
-- mensagem recebida — centenas por dia numa clínica movimentada. O botão
-- "Nova mensagem › Push" em Configurações › Notificações só gravava no
-- `localStorage` do navegador; o servidor não sabia dele e mandava igual.
--
-- O conserto:
--   - `push_subscriptions.recebe_mensagens boolean not null default true`: o
--     navegador grava o botão junto com a inscrição (PUT
--     /api/v1/notifications/push). O default mantém quem já se inscreveu como
--     está até o navegador sincronizar.
--   - `fn_push_inscricoes_que_veem_a_conversa` ganha
--     `p_so_quem_recebe_mensagens boolean default true`: o push de
--     `message.received` só vai a quem deixou `recebe_mensagens` ligado. A
--     menção (`user.mentioned`) chama com `false` — ser mencionado é pedido de
--     gente, como o aviso da Central. A régua de quem VÊ a conversa (0378) não
--     muda.
--   - Os avisos da Central (`enviarPushDaOrg`) leem a tabela direto e seguem
--     indo a todas as inscrições.
--
-- A assinatura muda, então a de dois argumentos sai antes (`drop ... if
-- exists`); a nova nasce só para o service role (CLAUDE.md, item 9).
-- Idempotente. No baseline, o corpo é trocado no lugar, no bloco da 0378, e a
-- coluna entra no bloco da tabela (migrations 0197/0199).
-- Prova: tests/invariants/push-so-a-quem-ve-a-conversa.test.ts.

alter table public.push_subscriptions
  add column if not exists recebe_mensagens boolean not null default true;

comment on column public.push_subscriptions.recebe_mensagens is
  'false = este navegador não recebe o push de mensagem nova (só os avisos que pedem gente). Migration 0404.';

drop function if exists public.fn_push_inscricoes_que_veem_a_conversa(uuid, uuid);

create or replace function public.fn_push_inscricoes_que_veem_a_conversa(
  p_org uuid,
  p_conversation uuid,
  p_so_quem_recebe_mensagens boolean default true
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
    select distinct s.user_id from public.push_subscriptions s
     where s.organization_id = p_org
       and (s.recebe_mensagens or not p_so_quem_recebe_mensagens)
     order by s.user_id
  loop
    perform set_config('request.jwt.claims', jsonb_build_object('sub', v_user)::text, true);
    if public.fn_can_view_conversation(p_org, v_assigned) then
      return query
        select s.id, s.user_id, s.endpoint, s.p256dh, s.auth
          from public.push_subscriptions s
         where s.organization_id = p_org and s.user_id = v_user
           and (s.recebe_mensagens or not p_so_quem_recebe_mensagens);
    end if;
  end loop;

  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('request.jwt.claim', coalesce(v_claim, ''), true);
  perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
end;
$$;

revoke execute on function public.fn_push_inscricoes_que_veem_a_conversa(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_push_inscricoes_que_veem_a_conversa(uuid, uuid, boolean) to service_role;
