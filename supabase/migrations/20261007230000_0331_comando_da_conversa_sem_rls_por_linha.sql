-- 0331 — "Quem manda na conversa" sem passar duas vezes pela RLS de contacts por linha.
--
-- Medido em produção em 07/10/2026 (647 conversas, JWT de um membro): a contagem
-- `?comando_da_conversa=in.(aguardando)` levava 1,25 s sozinha e até 8 s sob carga
-- (edge logs do Supabase, contadores do Inbox). `comando_da_conversa(c)` lia o
-- contato em DUAS subconsultas (`force_human`, `is_blocked`), cada uma sob a
-- policy `contacts_select`, que chama 3 funções por linha.
--
-- Agora uma `security definer` lê o contato UMA vez, sem a policy, e devolve só o
-- booleano que a regra usa ("o contato segura o robô?"). A guarda é de
-- organização, no corpo: contato de organização em que quem pergunta não é membro
-- (nem está em sessão de suporte) devolve false. Ela não escolhe linha nem devolve
-- dado além desse booleano. Medido: 1,25 s → 0,51 s, com o mesmo resultado.
--
-- `fn_comando_da_conversa` (a regra) não muda: `force_human` e `is_blocked` levam
-- ao mesmo estado (`aguardando`), então o OR dos dois entra no primeiro argumento.

create or replace function public.fn_contato_segura_o_robo(p_contact uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn_segura$
  select coalesce((
    select ct.force_human is true or ct.is_blocked is true
      from public.contacts ct
     where ct.id = p_contact
       and case
             when exists (select 1 from public.user_organizations uo
                           where uo.user_id = auth.uid()
                             and uo.organization_id = ct.organization_id
                             and uo.revoked_at is null) then true
             else ct.organization_id in (select public.fn_user_org_ids())
           end
  ), false);
$fn_segura$;

revoke execute on function public.fn_contato_segura_o_robo(uuid) from public, anon;
grant  execute on function public.fn_contato_segura_o_robo(uuid) to authenticated, service_role;

create or replace function public.comando_da_conversa(c public.conversations)
returns text
language sql
stable
set search_path = public
as $comando$
  select public.fn_comando_da_conversa(
    c.status,
    c.assigned_to_user_id,
    c.bot_silenced_until,
    public.fn_contato_segura_o_robo(c.contact_id),
    false,
    now()
  );
$comando$;

revoke execute on function public.comando_da_conversa(public.conversations) from public, anon;
grant  execute on function public.comando_da_conversa(public.conversations) to authenticated, service_role;
