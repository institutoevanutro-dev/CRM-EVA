-- Migration 0365 : AGENDAMENTO EXCLUÍDO NÃO DÁ ACESSO AO PACIENTE.
--
-- Decisão do dono do produto, complemento da 0364 (excluir agendamento lançado
-- por engano). `fn_provider_can_access_contact` contava QUALQUER agendamento do
-- prestador com o paciente: um agendamento lançado por engano e depois excluído
-- seguia abrindo o cadastro, as conversas e o negócio daquele paciente para o
-- prestador. Agora o agendamento excluído (`excluded_at is not null`) não conta.
--
-- O cancelado comum continua contando, exatamente como antes: cancelar não muda
-- acesso nenhum. O resto do corpo é a definição da 0268, letra a letra.
-- Vigiado por tests/invariants/agendamento-excluido-nao-da-acesso.test.ts.

create or replace function public.fn_provider_can_access_contact(
  p_org uuid, p_contact uuid, p_user uuid default auth.uid()
) returns boolean
language sql stable security definer set search_path = '' as $$
  select
    p_user is not null
    and (auth.uid() is null or auth.uid() = p_user)
    and exists (
      select 1 from public.user_organizations u
       where u.organization_id = p_org
         and u.user_id = p_user
         and u.role = 'provider'
         and u.revoked_at is null
    )
    and (
      exists (
        select 1 from public.calendar_appointments a
         where a.organization_id = p_org
           and a.contact_id = p_contact
           and a.owner_user_id = p_user
           and a.excluded_at is null
      )
      or exists (
        select 1 from public.crm_leads l
         where l.organization_id = p_org
           and l.contact_id = p_contact
           and l.owner_user_id = p_user
      )
      or exists (
        select 1 from public.conversations c
         where c.organization_id = p_org
           and c.contact_id = p_contact
           and c.assigned_to_user_id = p_user
      )
    );
$$;
revoke all on function public.fn_provider_can_access_contact(uuid,uuid,uuid) from public, anon;
grant execute on function public.fn_provider_can_access_contact(uuid,uuid,uuid) to authenticated, service_role;
