-- ── As palavras que o dono liberou para a IA usar ───────────────────────────
--
-- A trava de segurança nega por padrão: só publica quando TODO token está num
-- vocabulário conhecido. Esta tabela é o que o dono acrescentou a esse
-- vocabulário, palavra por palavra, olhando a lista do que apareceu nos
-- comentários que ele mesmo respondeu.
--
-- Guarda a RECUSA também (`aprovada = false`), e isso não é simetria de
-- enfeite: sem ela a mesma palavra volta a ser oferecida toda semana e a tela
-- vira ruído.
--
-- Sem coluna de contagem: quantas vezes a palavra apareceu é derivável de
-- `instagram_comments` (Doutrina DIRC: Calcular, e anti-pattern nº 2).
--
-- RLS: ler é de qualquer membro do tenant (a lista não é dado sensível; quem
-- segura papel na leitura é a rota, que exige `agent`), escrever exige `manager`.
-- Decidir o que a IA pode dizer em público é decisão de gestão — doutrina da
-- migration 0150. Quem reprova tabela nova que entre com `for all` só de
-- tenancy é UM caso de `tests/invariants/rbac-config-ia-canais.test.ts`, o
-- "nenhuma tabela NOVA entra com policy ALL só-tenancy", que varre
-- `pg_policies` inteiro; os demais casos daquele arquivo são fixtures sobre
-- `ai_agents` e NÃO olham para esta tabela. A revisão final leu só os
-- fixtures e deu a afirmação por falsa — para ver a varredura em vez de
-- acreditar em qualquer das duas linhas:
--   grep -n "nenhuma tabela NOVA" -A 13 tests/invariants/rbac-config-ia-canais.test.ts

create table if not exists public.instagram_comment_vocabulario (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Já normalizada (minúscula, sem acento): a MESMA forma que o tokenizador
  -- de `lib/comentarios/seguranca.ts` produz. Guardar "Conteúdo" faria a
  -- comparação falhar em silêncio.
  palavra text not null,
  aprovada boolean not null,
  decidida_por uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists instagram_comment_vocabulario_unica
  on public.instagram_comment_vocabulario(organization_id, palavra);

alter table public.instagram_comment_vocabulario enable row level security;

drop policy if exists instagram_comment_vocabulario_select on public.instagram_comment_vocabulario;
create policy instagram_comment_vocabulario_select on public.instagram_comment_vocabulario
  for select using (
    organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
  );

drop policy if exists instagram_comment_vocabulario_write on public.instagram_comment_vocabulario;
create policy instagram_comment_vocabulario_write on public.instagram_comment_vocabulario
  for all using (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  ) with check (
    public.fn_is_platform_admin()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'manager'))
  );
