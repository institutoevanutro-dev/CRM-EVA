-- 20261006000200_0319_travas_no_banco_notas_casos_e_bloqueio.sql
-- 0319 — travas no banco: nota interna, casos da IA e bloqueio de contato.
--
-- Três regras que já valiam nas telas e nas rotas, mas não no banco. O PostgREST
-- fala com a tabela direto pelo JWT da sessão, então "a rota barra" não protege
-- de quem chama o banco por fora. Idempotente: `drop policy if exists` +
-- `create policy`, `create or replace function`, `drop trigger if exists`,
-- `revoke` (repetir não muda nada). Nenhum dado é tocado.

-- ════════════════════════════════════════════════════════════════════════════
-- 1 · NOTA INTERNA: editar e apagar só o autor ou o gestor
-- ════════════════════════════════════════════════════════════════════════════
-- Porte do DeskcommCRM original: d9c3afdfc (webtecnica, PR 1870) e da2b3462f
-- (melgarafael, PR 2080); lá, migration 0509.
--
-- A 0302 fez a nota seguir a visibilidade da conversa, mas a escrita ficou numa
-- policy única `for all` (`conversation_notes_write`): organização + papel
-- `agent` + ver a conversa, sem olhar QUEM escreveu. Entre quem vê a conversa,
-- qualquer atendente editava ou apagava a nota de um colega pelo PostgREST. A
-- rota de apagar (`app/api/v1/conversations/[id]/notes/[noteId]/route.ts`) já
-- exigia autor ou gestor; o banco não.
--
--   INSERT         organização + `agent` + ver a conversa + autor = a sessão
--   UPDATE/DELETE  organização + `agent` + ver a conversa E (autor OU gestor)
--
-- Policies permissivas somam por OR: sem derrubar a `for all`, ela continuaria
-- liberando quem não é o autor. As de leitura (`conversation_notes_select` e
-- `conversation_notes_select_platform_admin`, 0302) e a restritiva do segundo
-- fator (`mfa_provada`, 0301) ficam como estão.
--
-- O anexo (0303) não precisa de regra própria: o bucket `internal-media` não
-- tem policy em `storage.objects`, então sessão nenhuma lê, troca ou apaga o
-- arquivo direto. O único jeito de um colega "trocar o arquivo" era reapontar
-- `media_storage_path` da nota alheia, e isso é o UPDATE que esta seção fecha.
drop policy if exists "conversation_notes_write" on public.conversation_notes;

drop policy if exists "conversation_notes_insert" on public.conversation_notes;
create policy "conversation_notes_insert" on public.conversation_notes
  for insert
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and created_by_user_id = auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

-- O `with check` repete o `using`: o autor não passa a nota para outro nome, e
-- o gestor que edita a nota de um atendente mantém o autor original.
drop policy if exists "conversation_notes_update" on public.conversation_notes;
create policy "conversation_notes_update" on public.conversation_notes
  for update
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and (created_by_user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager'))
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  )
  with check (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and (created_by_user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager'))
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

drop policy if exists "conversation_notes_delete" on public.conversation_notes;
create policy "conversation_notes_delete" on public.conversation_notes
  for delete
  using (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'agent')
    and (created_by_user_id = auth.uid() or public.fn_role_at_least(organization_id, 'manager'))
    and exists (
      select 1 from public.conversations c
      where c.organization_id = conversation_notes.organization_id
        and c.id = conversation_notes.conversation_id
        and public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id)
    )
  );

notify pgrst, 'reload schema';
