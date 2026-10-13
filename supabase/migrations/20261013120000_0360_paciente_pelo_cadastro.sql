-- ============================================================================
-- 0360 — PACIENTE PELO CADASTRO: quem já tem cadastro entra pelo funil de clientes
--
-- ─── O problema
--
-- A regra "cliente pela agenda" (0262) reconhece como cliente quem tem horário
-- marcado, e é por ela que o card de quem volta a escrever nasce no funil de
-- clientes (`crm_pipelines.is_client_pipeline`) e não no de entrada. Numa
-- clínica cujo cadastro de pacientes veio de importação, a agenda do CRM
-- conhece só uma parte deles: a maioria tem cadastro (CPF, data de nascimento,
-- às vezes o vínculo com o prontuário) e nenhum horário no CRM. Com a 0262
-- sozinha, o paciente antigo nasceria como "lead novo".
--
-- ─── A regra
--
-- Uma segunda chave, `organizations.settings.crm.paciente_pelo_cadastro`,
-- independente da primeira e também DESLIGADA em toda organização. Ligada, é
-- cliente para fins de funil o contato que TEM CADASTRO DE PACIENTE:
--
--   1. está ligado a um paciente do prontuário (`prontuario_contact_links`,
--      0285: a identidade que o prontuário grava pela API), ou
--   2. tem CPF guardado (`cpf_hash` não nulo).
--
-- Anonimizado e mesclado ficam de fora, como na 0262.
--
-- ─── O que esta migration NÃO faz, de propósito
--
--   - Não grava `first_service_at`, `client_recognized_at` nem
--     `client_tag_by_system`: os três continuam sendo só da regra da agenda, e
--     "Cliente desde" continua querendo dizer "primeiro horário que conta".
--   - Não põe a etiqueta `cliente` em ninguém. A etiqueta tem dono (o sistema só
--     tira a que pôs, 0262), e um segundo escritor exigiria reescrever
--     `fn_recalcular_cliente_do_contato`. Sem escrita, ligar e desligar não têm
--     o que desfazer.
--   - Não cria coluna, tabela, trigger nem índice. O fato é lido na hora, por
--     `lib/contacts/cliente-para-o-funil.ts`, no nascimento do lead e nas telas.
--   - Não toca em nenhuma função da 0262.
--
-- ─── Por que uma função, se não há dado a reescrever
--
-- `organizations.settings` é um jsonb com vários donos, e ler, mesclar em
-- memória e regravar o objeto inteiro já perdeu escrita (ver o cabeçalho de
-- `app/actions/settings/updateMarcaDaOrganizacao.ts`). Aqui a gravação é UM
-- comando, com a mescla dentro de `crm` igual à da 0262: a chave vizinha
-- (`cliente_pela_agenda`) não é tocada. E só o banco confere o papel pelo
-- `auth.uid()` da sessão.
--
-- `p_so_contar = true` devolve as mesmas contagens sem gravar nada: é o número
-- que a tela mostra ANTES de o administrador confirmar.
--
-- Idempotente: `create or replace function`, e nenhum dado é tocado. Reaplicar
-- não muda privilégio nenhum: a função já existe sem o EXECUTE de `public` e de
-- `anon`, e `authenticated` nunca o perde.
-- ============================================================================

create or replace function public.fn_definir_paciente_pelo_cadastro(
  p_org uuid,
  p_ligado boolean,
  p_so_contar boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_antes boolean;
  v_agenda boolean;
  v_pacientes integer;
  v_ja_clientes integer;
begin
  if auth.uid() is null
     or p_org is null
     or p_ligado is null
     or p_so_contar is null
     or not public.fn_role_at_least(p_org, 'admin')
     or not public.fn_support_write_allowed(p_org) then
    raise exception 'paciente_pelo_cadastro_forbidden' using errcode = '42501';
  end if;
  if not public.fn_session_mfa_proven() then
    raise exception 'paciente_pelo_cadastro_mfa_required' using errcode = '42501';
  end if;

  select (o.settings -> 'crm' -> 'paciente_pelo_cadastro') = 'true'::jsonb,
         (o.settings -> 'crm' -> 'cliente_pela_agenda') = 'true'::jsonb
    into v_antes, v_agenda
    from public.organizations o
   where o.id = p_org;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;

  if not p_so_contar then
    update public.organizations
       set settings = jsonb_set(
             coalesce(settings, '{}'::jsonb),
             '{crm}',
             (case when jsonb_typeof(settings -> 'crm') = 'object' then settings -> 'crm' else '{}'::jsonb end)
               || jsonb_build_object('paciente_pelo_cadastro', p_ligado),
             true)
     where id = p_org;
  end if;

  select count(*),
         count(*) filter (where v_agenda is true and c.first_service_at is not null)
    into v_pacientes, v_ja_clientes
    from public.contacts c
   where c.organization_id = p_org
     and c.is_anonymized = false
     and c.is_merged_into is null
     and (c.cpf_hash is not null
          or exists (select 1 from public.prontuario_contact_links l
                      where l.organization_id = p_org and l.contact_id = c.id));

  return jsonb_build_object(
    'ligado', case when p_so_contar then coalesce(v_antes, false) else p_ligado end,
    'mudou', (not p_so_contar) and coalesce(v_antes, false) <> p_ligado,
    'pacientes', v_pacientes,
    'ja_clientes_pela_agenda', v_ja_clientes,
    'tem_funil_de_clientes', exists (
      select 1 from public.crm_pipelines f
       where f.organization_id = p_org and f.is_client_pipeline = true and f.is_archived = false)
  );
end $$;

comment on function public.fn_definir_paciente_pelo_cadastro(uuid, boolean, boolean) is
  'Liga, desliga ou só conta (p_so_contar) a regra paciente pelo cadastro de uma organização '
  '(organizations.settings.crm.paciente_pelo_cadastro, migration 0360). Só admin da própria organização, '
  'com escrita de suporte permitida e MFA provada. Não escreve em contacts: a regra é lida na hora por '
  'lib/contacts/cliente-para-o-funil.ts. A contagem é o espelho SQL daquele predicado, comparado em '
  'tests/invariants/paciente-pelo-cadastro.test.ts.';

revoke execute on function public.fn_definir_paciente_pelo_cadastro(uuid, boolean, boolean) from public, anon;
grant  execute on function public.fn_definir_paciente_pelo_cadastro(uuid, boolean, boolean) to authenticated;

notify pgrst, 'reload schema';
