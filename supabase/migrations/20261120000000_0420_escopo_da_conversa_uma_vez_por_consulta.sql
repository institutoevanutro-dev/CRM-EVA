-- 0420: o escopo de leitura da conversa é avaliado UMA VEZ por consulta.
--
-- Porte do DeskcommCRM original, PR #3199 (migration 0726 de lá; issue #3090).
--
-- O defeito: a policy `conversations_select` chamava
-- `fn_can_view_conversation(organization_id, assigned_to_user_id)` em TODA linha.
-- Essa função refaz `fn_is_platform_admin()` e `fn_user_role_in_org()` (que refaz
-- `fn_support_context()`) por linha. Medido no Instituto em 19/11, com 1.731
-- conversas: `count(*)` como usuário levava 240 a 680 ms, e cada tela do inbox faz
-- várias dessas, de modo que a lista e os contadores levavam de 1,4 a 5,6 s.
--
-- O conserto: `fn_conversation_scope()` resolve, por organização do usuário, se ele
-- vê a organização inteira (`org_wide_read`) e se vê a fila sem responsável
-- (`sees_unassigned`). A policy compara a linha com esse conjunto, calculado uma
-- vez por consulta (hashed SubPlan), sem nenhuma chamada de função por linha.
--
-- Diferença para o original: este fork tem o papel `provider` (profissional), que
-- na escada de `fn_can_view_conversation` só vê o que está atribuído a ele. Por
-- isso `provider` nunca entra em `org_wide_read` nem em `sees_unassigned`, nem com
-- `visibility_mode = 'all'`.
--
-- A visibilidade é idêntica à da escada antiga, e `fn_can_view_conversation` segue
-- intacta (outras tabelas a usam). O invariante
-- `tests/invariants/escopo-da-conversa-avaliado-uma-vez.test.ts` compara, pessoa por
-- pessoa (inclusive `provider`), a policy nova com a função antiga.
--
-- Idempotente: `create or replace` + `drop policy if exists`. Função nova revogada
-- de public e anon.
create or replace function public.fn_conversation_scope()
returns table (organization_id uuid, org_wide_read boolean, sees_unassigned boolean)
language sql stable security definer
set search_path = public
as $$
  select x.organization_id,
         x.papel in ('viewer','manager','admin')
           or (x.papel <> 'provider' and x.modo = 'all'),
         x.papel <> 'provider' and x.modo = 'own_and_unassigned'
  from (
    select o.organization_id,
           public.fn_user_role_in_org(o.organization_id) as papel,
           coalesce((select z.settings->>'visibility_mode' from public.organizations z
                     where z.id = o.organization_id), 'own_and_unassigned') as modo
      from public.fn_user_org_ids() as o(organization_id)
  ) x;
$$;

revoke all on function public.fn_conversation_scope() from public, anon;
grant execute on function public.fn_conversation_scope() to authenticated, service_role;

drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations
  for select using (
    (select public.fn_is_platform_admin())
    or organization_id in (
         select s.organization_id from public.fn_conversation_scope() s where s.org_wide_read
       )
    or (
         assigned_to_user_id = auth.uid()
         and organization_id in (select s.organization_id from public.fn_conversation_scope() s)
       )
    or (
         assigned_to_user_id is null
         and organization_id in (
              select s.organization_id from public.fn_conversation_scope() s where s.sees_unassigned
            )
       )
  );
