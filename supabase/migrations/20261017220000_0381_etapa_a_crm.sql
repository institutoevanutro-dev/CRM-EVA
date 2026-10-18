-- ============================================================================
-- 0381: NOME DA APRESENTAÇÃO E REGRA DO RQE DOS COMENTÁRIOS
--
-- ─── 1. platform_branding.nome_da_apresentacao
--
-- A página "Sobre" (`/legal/about`) é a apresentação pública da instalação, a
-- que um revisor de app OAuth lê. O título dela era fixo no código: 'CRM Eva',
-- o mesmo em toda instalação deste repositório (`app/legal/about/page.tsx`).
-- Ele passa a vir desta coluna e, vazia, do nome da marca da instalação
-- (`lib/legal/nome-da-apresentacao.ts`).
--
-- A coluna é semeada com 'CRM Eva' UMA vez, no comando que a cria, e só quando
-- a instalação já tem organização: é o título que toda instalação existente
-- mostra hoje, e um nome já apresentado a um revisor não pode mudar só porque o
-- operador atualizou. Numa instalação nova o apêndice do baseline roda antes de
-- existir organização, e a coluna fica vazia. Depois de criada, nenhuma
-- reaplicação a toca: o valor passa a ser de quem administra a instalação.
--
-- A linha id=1 só existe depois que a marca foi gravada (pelo .env no primeiro
-- render, ou pela tela). Quando falta, a semeadura a cria com marca vazia e
-- `seeded_from_env = true`: é o estado em que `lib/branding/instalacao.ts`
-- ainda completa a linha com o .env ("completar"), igual a quando não havia
-- linha. Com `seeded_from_env = false` a linha travaria essa semeadura.
--
-- ─── 2. organizations.settings.medico_sem_rqe e fn_definir_medico_sem_rqe
--
-- A trava dos comentários do Instagram que nunca deixa a IA chamar o dono de
-- especialista (médico sem RQE: regra de publicidade médica do CFM) era fixa
-- no código. Vira chave por organização: o booleano `settings.medico_sem_rqe`.
-- Ausente, ou com qualquer valor que não seja o booleano false, vale LIGADA,
-- que é o comportamento de hoje e o lado seguro. Quem lê é
-- `lib/comentarios/regra-do-rqe.ts`.
--
-- No nível de cima de `settings`, e não dentro de `settings.comentarios`:
-- `fn_definir_frases_de_comentario` (0288) regrava aquele objeto inteiro e
-- apagaria a chave.
--
-- A função segue o desenho da 0360: `security definer`; papel conferido pelo
-- `auth.uid()` da sessão (só admin da própria organização, com escrita de
-- suporte permitida e MFA provada); gravação num comando só, com `jsonb_set`,
-- sem ler e regravar o jsonb inteiro. Quem audita é a rota que a chama
-- (`app/api/v1/comentarios/regra-do-rqe/route.ts`).
--
-- Idempotente: a coluna nasce num bloco que confere o catálogo antes; a função
-- é `create or replace`. Reaplicar não muda privilégio: a função já existe sem
-- o EXECUTE de `public` e de `anon`, e `authenticated` nunca o perde.
-- ============================================================================

do $$
begin
  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'platform_branding'
       and column_name = 'nome_da_apresentacao'
  ) then
    alter table public.platform_branding add column nome_da_apresentacao text;
    if exists (select 1 from public.organizations) then
      insert into public.platform_branding (id, seeded_from_env, nome_da_apresentacao)
      values (1, true, 'CRM Eva')
      on conflict (id) do update set nome_da_apresentacao = excluded.nome_da_apresentacao;
    end if;
  end if;
end $$;

comment on column public.platform_branding.nome_da_apresentacao is
  'Título da página Sobre (/legal/about). Vazia: a página usa o nome da marca da instalação. '
  'Semeada uma vez com o título antigo, fixo no código, quando a coluna nasceu numa instalação '
  'que já tinha organização (migration 0381). Lida por lib/legal/nome-da-apresentacao.ts.';

create or replace function public.fn_definir_medico_sem_rqe(
  p_organization_id uuid,
  p_ligada boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null
     or p_organization_id is null
     or p_ligada is null
     or not public.fn_role_at_least(p_organization_id, 'admin')
     or not public.fn_support_write_allowed(p_organization_id) then
    raise exception 'medico_sem_rqe_forbidden' using errcode = '42501';
  end if;
  if not public.fn_session_mfa_proven() then
    raise exception 'medico_sem_rqe_mfa_required' using errcode = '42501';
  end if;

  update public.organizations
     set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{medico_sem_rqe}', to_jsonb(p_ligada), true)
   where id = p_organization_id;
  if not found then
    raise exception 'organization_not_found' using errcode = 'P0002';
  end if;
end $$;

comment on function public.fn_definir_medico_sem_rqe(uuid, boolean) is
  'Liga ou desliga a regra do RQE dos comentários do Instagram de uma organização '
  '(organizations.settings.medico_sem_rqe, migration 0381). Só admin da própria organização, '
  'com escrita de suporte permitida e MFA provada. Ausente ou não booleano vale ligada: quem lê é '
  'lib/comentarios/regra-do-rqe.ts. Medido em tests/invariants/apresentacao-e-regra-do-rqe.test.ts.';

revoke execute on function public.fn_definir_medico_sem_rqe(uuid, boolean) from public, anon;
grant  execute on function public.fn_definir_medico_sem_rqe(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
