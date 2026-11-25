-- 0436 — a devolução automática confere o último sinal humano sob o lock da linha.
--
-- Porte de melgarafael/DeskcommCRM #5183 (migration 9472 lá), na forma do fork.
--
-- O cron `handoff-devolucao` lê as conversas, decide quais voltam ao agente de
-- IA e só depois escreve, uma a uma. Uma pessoa que assumisse a conversa ou
-- respondesse o cliente nesse intervalo não era vista: a devolução soltava o
-- dono (`fn_conversation_assign` com `p_enforce_expected = false`) e a conversa
-- voltava à IA logo depois de a pessoa entrar nela.
--
-- A troca de dono a aplicação recusa antes de escrever (o dono lido na varredura
-- vai junto). A resposta do MESMO dono, não: ela só move `last_outbound_at`, e
-- conferir isso no app seria outra leitura antes da escrita, com a mesma janela.
-- Por isso a conferência vai para dentro da escrita:
--
--   · conversa COM dono: esta função trava a linha (`for no key update`, a
--     mesma força de `fn_conversation_assign`), confere o dono esperado e que
--     nenhum sinal humano (`last_handoff_at`, `assigned_at`, `last_outbound_at`)
--     é posterior ao corte, e só então chama `fn_conversation_assign` (release)
--     na MESMA transação — a chamada interna reaproveita o lock;
--   · conversa SEM dono: não há release, e o relógio vai no próprio UPDATE da
--     devolução, que é a única escrita (`lib/escalacao/retomada.ts`).
--
-- Por que um invólucro e não um parâmetro novo em `fn_conversation_assign`:
-- mudar a assinatura dela obrigaria a reescrever a primeira definição no
-- baseline e abriria janela de sobrecarga no update.sh, na porta única de toda
-- atribuição (o mesmo motivo da 0425).
--
-- Devolve `true` quando soltou o dono e `false` quando a conversa mudou (dono
-- diferente, sinal humano depois do corte, ou nenhuma linha). Security invoker,
-- EXECUTE só para `service_role`: só o cron a chama. Nenhuma tabela, coluna ou
-- dado muda.

create or replace function public.fn_conversation_release_if_idle(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_expected_assignee uuid,
  p_sem_sinal_humano_desde timestamptz
) returns boolean
language plpgsql
set search_path = public
as $$
begin
  perform 1
    from public.conversations
   where id = p_conversation_id
     and organization_id = p_organization_id
     and assigned_to_user_id is not distinct from p_expected_assignee
     and coalesce(last_handoff_at, '-infinity') <= p_sem_sinal_humano_desde
     and coalesce(assigned_at, '-infinity') <= p_sem_sinal_humano_desde
     and coalesce(last_outbound_at, '-infinity') <= p_sem_sinal_humano_desde
   for no key update;
  if not found then
    return false;
  end if;

  return exists (
    select 1
      from public.fn_conversation_assign(
        p_organization_id, p_conversation_id, null, 'release', p_expected_assignee, true)
  );
end;
$$;

revoke execute on function public.fn_conversation_release_if_idle(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.fn_conversation_release_if_idle(uuid, uuid, uuid, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
