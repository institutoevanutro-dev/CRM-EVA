# Papéis e Escopo da Equipe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Oferecer Administrador, Gerente, Colaborador e Prestador de serviço, limitando o prestador à própria agenda e aos pacientes ligados ao seu trabalho.

**Architecture:** Manter os valores internos existentes (`admin`, `manager`, `agent`, `viewer`) e adicionar `provider`; `agent` passa a ser exibido como Colaborador. O prestador ganha rank próprio e escopo por vínculo, aplicado no banco e reutilizado pelas rotas, enquanto `viewer` continua disponível como papel legado de somente leitura.

**Tech Stack:** PostgreSQL/Supabase RLS, TypeScript 6, Zod 4, Next.js 16, Vitest 4, testes de banco.

**Spec:** `docs/superpowers/specs/2026-09-19-agenda-equipe-permissoes-design.md`

## Global Constraints

- Administrador mantém acesso total.
- Gerente acessa equipe, pacientes, agendas, leads, funis e pendências.
- Colaborador acessa todos os pacientes e agendas, mas não administra o sistema.
- Prestador acessa e altera somente sua agenda e os pacientes vinculados a ela.
- Pessoas e agentes de IA permanecem identidades diferentes.
- Toda migration sai em tripla: migration, `supabase/baseline.sql` e `supabase/migrations/MANIFEST.md`.
- Nenhum dado do Instituto Eva será hardcoded no produto genérico.

---

### Task 1: Acrescentar o papel canônico `provider`

**Files:**
- Create: `supabase/migrations/20260919140000_0268_prestador_com_escopo_proprio.sql`
- Modify: `supabase/baseline.sql`
- Modify: `supabase/migrations/MANIFEST.md`
- Modify: `lib/auth/types.ts`
- Modify: `lib/schemas/team.ts`
- Modify: `lib/auth/invite-token.ts`
- Modify: `lib/auth/issue-invite.ts`
- Test: `tests/unit/papel-do-prestador.test.ts`
- Test: `tests/invariants/agenda-rbac.test.ts`

**Interfaces:**
- Produces: `Role = "viewer" | "provider" | "agent" | "ai_operator" | "manager" | "admin"`.
- Produces: `ROLE_RANK.provider === 2` e `ROLE_RANK.agent === 3`.
- Produces: `fn_provider_can_access_contact(p_org uuid, p_contact uuid, p_user uuid default auth.uid()) returns boolean`.

- [ ] **Step 1: Escrever os testes que exigem o novo papel**

```ts
expect(PAPEIS_HUMANOS).toContain("provider");
expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.provider);
expect(ROLE_RANK.provider).toBeLessThan(ROLE_RANK.agent);
expect(ROTULO_DO_PAPEL.provider).toBe("Prestador de serviço");
expect(ROTULO_DO_PAPEL.agent).toBe("Colaborador");
```

- [ ] **Step 2: Rodar os testes e confirmar a falha esperada**

Run: `pnpm vitest run tests/unit/papel-do-prestador.test.ts tests/invariants/agenda-rbac.test.ts`

Expected: FAIL porque `provider` ainda não existe no vocabulário e no CHECK do banco.

- [ ] **Step 3: Criar a migration idempotente**

```sql
alter table public.user_organizations drop constraint if exists user_organizations_role_check;
alter table public.user_organizations add constraint user_organizations_role_check
  check (role in ('viewer','provider','agent','manager','admin'));

alter table public.team_invites drop constraint if exists team_invites_role_check;
alter table public.team_invites add constraint team_invites_role_check
  check (role in ('viewer','provider','agent','manager','admin'));
```

Atualizar também as funções que validam `p_role` para aceitarem a mesma lista. Criar `fn_provider_can_access_contact` como `security definer`, com `search_path=''`, retornando verdadeiro somente quando há na mesma organização um agendamento daquele contato cujo `owner_user_id = p_user`, ou um lead/conversa do contato atribuído à mesma pessoa.

- [ ] **Step 4: Atualizar tipos e rótulos**

```ts
export const ROLE_RANK = {
  viewer: 1,
  provider: 2,
  agent: 3,
  ai_operator: 4,
  manager: 5,
  admin: 6,
} satisfies Record<Role, number>;

export const ROTULO_DO_PAPEL = {
  viewer: "Somente leitura",
  provider: "Prestador de serviço",
  agent: "Colaborador",
  ai_operator: "Assistente com autonomia de operação",
  manager: "Gerente",
  admin: "Administrador",
} satisfies Record<Role, string>;
```

- [ ] **Step 5: Repetir o SQL no baseline e documentar no manifesto**

O bloco do baseline deve ser idempotente e corrigir constraints antes de recriá-las. A linha do manifesto deve registrar que `viewer` continua legado e que `provider` tem escopo próprio.

- [ ] **Step 6: Rodar os testes focados**

Run: `pnpm vitest run tests/unit/papel-do-prestador.test.ts tests/invariants/agenda-rbac.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260919140000_0268_prestador_com_escopo_proprio.sql supabase/baseline.sql supabase/migrations/MANIFEST.md lib/auth/types.ts lib/schemas/team.ts lib/auth/invite-token.ts lib/auth/issue-invite.ts tests/unit/papel-do-prestador.test.ts tests/invariants/agenda-rbac.test.ts
git commit -m "feat(equipe): adiciona papel de prestador"
```

### Task 2: Aplicar escopo próprio no banco

**Files:**
- Create: `supabase/migrations/20260919143000_0269_prestador_ve_so_proprios_pacientes.sql`
- Modify: `supabase/baseline.sql`
- Modify: `supabase/migrations/MANIFEST.md`
- Test: `tests/invariants/prestador-ve-so-proprios-pacientes.test.ts`
- Test: `tests/invariants/agenda-rbac.test.ts`

**Interfaces:**
- Consumes: `fn_provider_can_access_contact` da Task 1.
- Produces: policies de SELECT/INSERT/UPDATE/DELETE para `calendar_appointments` e leitura limitada dos dados ligados ao paciente.

- [ ] **Step 1: Escrever o cenário A/B de isolamento**

Criar duas organizações, dois prestadores, dois contatos e dois agendamentos. O prestador A deve ler e alterar somente seu agendamento e o contato relacionado; gerente e colaborador devem continuar vendo ambos.

```ts
expect(await idsVisiveisComo(prestadorA, "calendar_appointments")).toEqual([agendamentoA]);
expect(await idsVisiveisComo(prestadorA, "contacts")).toContain(contatoA);
expect(await idsVisiveisComo(prestadorA, "contacts")).not.toContain(contatoB);
```

- [ ] **Step 2: Confirmar que o teste falha com as policies org-wide atuais**

Run: `pnpm vitest run tests/invariants/prestador-ve-so-proprios-pacientes.test.ts`

Expected: FAIL mostrando que o prestador ainda vê linhas alheias.

- [ ] **Step 3: Recriar as policies sem abrir acesso por rank**

Para `provider`, a policy de agendamentos exige `owner_user_id = auth.uid()`. Para contatos e seus dados operacionais, exige `fn_provider_can_access_contact(organization_id, contact_id)`. Para os demais papéis, preserva o comportamento atual por organização. Escrita do prestador nunca pode trocar `owner_user_id` para outra pessoa.

- [ ] **Step 4: Provar leitura e escrita nos dois sentidos**

Run: `pnpm vitest run tests/invariants/prestador-ve-so-proprios-pacientes.test.ts tests/invariants/agenda-rbac.test.ts`

Expected: PASS, incluindo recusa de leitura e alteração cruzada.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260919143000_0269_prestador_ve_so_proprios_pacientes.sql supabase/baseline.sql supabase/migrations/MANIFEST.md tests/invariants/prestador-ve-so-proprios-pacientes.test.ts tests/invariants/agenda-rbac.test.ts
git commit -m "feat(equipe): limita prestador aos próprios pacientes"
```

### Task 3: Exibir os quatro papéis operacionais na equipe

**Files:**
- Modify: `app/app/team/_components/TeamMembersClient.tsx`
- Modify: `app/app/team/invite/_components/InviteForm.tsx`
- Modify: `app/onboarding/invite-team/_form.tsx`
- Modify: `app/api/v1/team/[user_id]/role/route.ts`
- Modify: `app/api/v1/team/invite/route.ts`
- Test: `app/app/team/_components/TeamMembersClient.test.tsx`
- Test: `tests/e2e/rbac-roles.spec.ts`

**Interfaces:**
- Consumes: `PAPEIS_HUMANOS` e `ROTULO_DO_PAPEL`.
- Produces: seleção visual em português; payload continua usando valores internos.

- [ ] **Step 1: Escrever o teste visual dos rótulos**

```tsx
expect(screen.getByText("Prestador de serviço")).toBeTruthy();
expect(screen.getByText("Colaborador")).toBeTruthy();
expect(screen.getByText("Gerente")).toBeTruthy();
expect(screen.getByText("Administrador")).toBeTruthy();
expect(screen.queryByText(/^agent$/)).toBeNull();
```

- [ ] **Step 2: Confirmar a falha**

Run: `pnpm vitest run app/app/team/_components/TeamMembersClient.test.tsx`

Expected: FAIL porque a tela imprime o valor cru.

- [ ] **Step 3: Renderizar rótulos e descrições de alcance**

Usar `ROTULO_DO_PAPEL[r]` nos selects, badges e convites. Mostrar ao lado de Prestador: “Somente sua agenda e pacientes vinculados”. Manter `viewer` apenas para vínculos legados existentes, sem oferecê-lo em novos convites.

- [ ] **Step 4: Rodar unitário e E2E focados**

Run: `pnpm vitest run app/app/team/_components/TeamMembersClient.test.tsx`

Run: `pnpm playwright test tests/e2e/rbac-roles.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/app/team app/onboarding/invite-team app/api/v1/team lib/auth tests/e2e/rbac-roles.spec.ts
git commit -m "feat(equipe): mostra papeis da clinica"
```

### Task 4: Fechar a entrega de permissões

**Files:**
- Create: `.changes/papeis-da-equipe.md`
- Create: `docs/runbooks/configurar-papeis-instituto-eva.md`
- Modify: `docs/superpowers/specs/2026-09-19-agenda-equipe-permissoes-design.md`

- [ ] **Step 1: Rodar gates de schema e autorização**

Run: `pnpm typecheck`

Run: `pnpm lint`

Run: `pnpm test:unit`

Run: `pnpm test:db`

Expected: todos com exit code 0.

- [ ] **Step 2: Sabotar a policy de prestador**

Trocar temporariamente a condição `owner_user_id = auth.uid()` por `true`, rodar `prestador-ve-so-proprios-pacientes.test.ts` e confirmar que o caso de isolamento fica vermelho. Restaurar a condição e repetir o teste verde.

- [ ] **Step 3: Criar fragmento de release**

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: Equipe distingue colaboradores, gerentes, administradores e prestadores
---
Prestadores trabalham somente na própria agenda e nos pacientes ligados aos seus atendimentos; gerentes, colaboradores e administradores mantêm o alcance definido pela organização.
```

- [ ] **Step 4: Documentar a atribuição inicial após o deploy**

```text
André Luis Lopes Costa → Administrador
Erick Augusto → Gerente
Isadora Carvalho de Figueiredo → Colaborador
Geovana Carvalho → Administrador
Cintia humana → Colaborador, somente depois de aceitar o convite
```

O runbook deve exigir conferência do e-mail antes de alterar o papel e proibir confundir pessoas com agentes de IA de mesmo nome.

- [ ] **Step 5: Commit**

```bash
git add .changes/papeis-da-equipe.md docs/runbooks/configurar-papeis-instituto-eva.md docs/superpowers/specs/2026-09-19-agenda-equipe-permissoes-design.md
git commit -m "docs(equipe): registra novos papeis"
```
