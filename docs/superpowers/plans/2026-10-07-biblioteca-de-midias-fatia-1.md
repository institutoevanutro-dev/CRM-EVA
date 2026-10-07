# Biblioteca de mídias, fatia 1 (acervo + tela com termo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O gestor sobe imagens e vídeos para uma biblioteca da organização, com nome, "quando usar", etiquetas, até 2 variantes (A/B) e termo de uso de imagem, e vê a situação de cada item (Pronta / Sem termo / Termo vencido / Revogada / Arquivo ausente).

**Architecture:** Tabela nova `media_library_items` (RLS: leitura de qualquer membro, escrita manager+, `mfa_provada`) e bucket privado novo `media-library`, só service role. Rotas `/api/v1/ai/midias` no padrão de `respostas-prontas` (cliente de sessão para a linha, admin client só para o Storage, igual a `settings/sons`). A regra "pode ser enviada?" é uma função pura `situacaoDaMidia` em `lib/midias/termo.ts`, que as fatias 2 a 4 reutilizam no handler de envio.

**Tech Stack:** Next.js 16 Route Handlers, Supabase (Postgres + Storage), Zod, React Query, Vitest, invariantes `pnpm test:db`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-06-biblioteca-de-midias-design.md` (decisões aceitas pelo André em 07/10/2026).

## Global Constraints

- Migration **0326** (reservada; 0325 é da sessão Graphify). Arquivo `supabase/migrations/20261007160000_0326_biblioteca_de_midias.sql` + bloco no apêndice do `supabase/baseline.sql` **antes** da linha `-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----` + linha no `supabase/migrations/MANIFEST.md`.
- Política nova NÃO pode ser `for all` só de tenancy (`tests/invariants/rbac-config-ia-canais.test.ts:225`); toda tabela com `organization_id` precisa da restritiva `mfa_provada` (`tests/invariants/mfa-na-rest.test.ts`).
- Bucket `media-library`: `public=false`, `file_size_limit = 52428800` (50 MB), `allowed_mime_types = image/jpeg, image/png, image/webp, video/mp4, video/3gpp`. Nenhuma policy em `storage.objects`.
- Caminho do arquivo: `<org_id>/<item_id>/<A|B>-<uuid>.<ext>`.
- Máximo 2 variantes, chaves `A` e `B`.
- `contains_person` nasce `true`.
- Termo enviável = `contains_person = false` OU (`consent_signed_at` preenchido E `consent_revoked_at` nulo E (`consent_expires_at` nulo OU >= hoje)).
- Ações de audit novas (no fim de `AUDIT_ACTIONS`, sob comentário `// Biblioteca de mídias (migration 0326).`): `media_library.item_created`, `media_library.item_updated`, `media_library.file_replaced`, `media_library.file_removed`, `media_library.consent_recorded`, `media_library.consent_revoked`, `media_library.item_deleted`.
- Papel mínimo da tela e da escrita: `manager`. A leitura pela API também é `manager`; agentes de IA usam o service role na fatia 3.
- Fora desta fatia: envio (fatia 2), tool `send_media` (3), passo de follow-up (4), arquivo PDF do termo assinado (`consent_document_path`, adiado: o termo vale pelos campos; entra quando alguém pedir), coluna `messages.media_library_item_id` (fatia 2, migration própria).
- Português nos textos de tela, sem travessão.

## Review Focus

1. **Upload de arquivo que não é o que diz ser** (SVG/HTML rotulado `image/png`, MP4 falso): esperado 415. Coberto pelo reaproveitamento de `validateOutboundMedia` + teste na Task 4.
2. **Trocar o arquivo de uma variante**: o item, o id e a situação continuam; o arquivo antigo sai do Storage só depois de o novo estar gravado. Teste na Task 4.
3. **Termo com validade vencendo hoje**: vence no dia seguinte, não no próprio dia (comparação `>= hoje` em America/Sao_Paulo). Teste na Task 2.
4. **Gestor da org B adivinhando o id de um item da org A** (PATCH/DELETE/upload): esperado 404, sem tocar no Storage da org A. Teste na Task 4 e invariante na Task 1.
5. **Apagar item**: os arquivos das variantes saem do Storage; falha no Storage não deixa a linha órfã apontando para nada (linha sai primeiro, arquivos depois, falha de remoção só loga). Teste na Task 4.

---

### Task 1: Schema, bucket e invariantes

**Files:**
- Create: `supabase/migrations/20261007160000_0326_biblioteca_de_midias.sql`
- Modify: `supabase/baseline.sql` (inserir bloco antes da linha `-- ---- VARREDURA anon ... (migration 0116) ----`, hoje na L34651)
- Modify: `supabase/migrations/MANIFEST.md` (linha nova no fim da tabela "Applied")
- Create: `tests/invariants/biblioteca-de-midias.test.ts`
- Modify: `tests/invariants/rls-completude-varredura.test.ts` (registrar `media_library_items` em `PROVA_PROPRIA` apontando para o teste novo, no mesmo formato das entradas existentes nas L77-85)

**Interfaces:**
- Produces: tabela `public.media_library_items` com colunas `id, organization_id, title, when_to_use, tags text[], variants jsonb, contains_person, consent_subject, consent_scope, consent_signed_at date, consent_expires_at date, consent_revoked_at timestamptz, created_by_user_id, created_at, updated_at`; bucket `media-library`.

- [ ] **Step 1: Escrever o invariante (falha)**

```ts
// tests/invariants/biblioteca-de-midias.test.ts
import { describe, expect, it } from "vitest";

import { countAs, lastLine, sql, writeCountAs } from "./gov-helpers";

/**
 * O que a migration 0326 promete no banco que o clone recebe:
 *  1. media_library_items com RLS e a restritiva mfa_provada.
 *  2. Escrita de gestor; atendente lê e não escreve.
 *  3. Isolamento entre duas organizações, inclusive o lado `with check`.
 *  4. Bucket media-library privado, 50 MB, só imagem e vídeo, sem policy.
 */
const ORG_A = "0326aaaa-0000-4000-8000-000000000001";
const ORG_B = "0326bbbb-0000-4000-8000-000000000002";
const GESTOR_A = "0326aaaa-1111-4000-8000-000000000001";
const ATENDENTE_A = "0326aaaa-2222-4000-8000-000000000001";
const GESTOR_B = "0326bbbb-1111-4000-8000-000000000002";
const ITEM_A = "0326aaaa-3333-4000-8000-000000000001";

function seed(): void {
  sql(`
    insert into auth.users (id, email) values
      ('${GESTOR_A}', 'midia-gestor-a@invariant.test'),
      ('${ATENDENTE_A}', 'midia-atendente-a@invariant.test'),
      ('${GESTOR_B}', 'midia-gestor-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'midia-inv-a', 'Midia Inv A', 'Midia A'),
      ('${ORG_B}', 'midia-inv-b', 'Midia Inv B', 'Midia B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GESTOR_A}', '${ORG_A}', 'manager', now()),
      ('${ATENDENTE_A}', '${ORG_A}', 'agent', now()),
      ('${GESTOR_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
  `);
}

describe("0326 · biblioteca de mídias chega ao clone isolada e com papel", () => {
  it("nasce com RLS e a restritiva do segundo fator", () => {
    seed();
    expect(sql(`select relrowsecurity from pg_class where relname = 'media_library_items' and relnamespace = 'public'::regnamespace`)).toBe("t");
    expect(sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = 'media_library_items' and policyname = 'mfa_provada'`)).toBe("1");
  });

  it("gestor cria; contains_person nasce true e variants nasce vazio", () => {
    expect(writeCountAs(GESTOR_A, `insert into public.media_library_items (id, organization_id, title) values ('${ITEM_A}', '${ORG_A}', 'Vídeo da unidade')`)).toBe(1);
    expect(sql(`select contains_person::text || ' ' || variants::text from public.media_library_items where id = '${ITEM_A}'`)).toBe("true []");
  });

  it("atendente lê e não escreve", () => {
    expect(countAs(ATENDENTE_A, `select count(*) from public.media_library_items where organization_id = '${ORG_A}';`)).toBe(1);
    expect(writeCountAs(ATENDENTE_A, `update public.media_library_items set title = 'x' where id = '${ITEM_A}'`)).toBe(0);
  });

  it("org B não vê nem escreve na org A", () => {
    expect(countAs(GESTOR_B, `select count(*) from public.media_library_items where organization_id = '${ORG_A}';`)).toBe(0);
    expect(writeCountAs(GESTOR_B, `insert into public.media_library_items (organization_id, title) values ('${ORG_A}', 'invadido')`)).toBe(0);
  });

  it("título vazio é recusado", () => {
    expect(() => sql(`insert into public.media_library_items (organization_id, title) values ('${ORG_A}', '   ')`)).toThrow();
  });

  it("bucket media-library existe privado, 50 MB, só imagem e vídeo, sem policy", () => {
    expect(lastLine(sql(`select public::text || '|' || file_size_limit::text || '|' || array_to_string(allowed_mime_types, ',') from storage.buckets where id = 'media-library';`)))
      .toBe("false|52428800|image/jpeg,image/png,image/webp,video/mp4,video/3gpp");
    expect(lastLine(sql(`select coalesce(string_agg(policyname, ','), 'NENHUMA') from pg_policies where schemaname = 'storage' and tablename = 'objects' and (coalesce(qual,'') || coalesce(with_check,'')) like '%media-library%';`)))
      .toBe("NENHUMA");
  });
});
```

Se `writeCountAs` lançar em vez de devolver 0 para `with check` violado, siga o que `tests/invariants/respostas-prontas-rls.test.ts` faz no caso equivalente (L128 em diante) e copie a forma.

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:db -- tests/invariants/biblioteca-de-midias.test.ts` (requer Docker; se o Docker estiver parado, rode `open -a Docker` e espere `docker info` responder)
Expected: FAIL, `relation "public.media_library_items" does not exist`.

- [ ] **Step 3: Escrever a migration**

```sql
-- supabase/migrations/20261007160000_0326_biblioteca_de_midias.sql
-- Biblioteca de mídias (Fase 2, fatia 1): acervo de imagem e vídeo da organização,
-- com termo de uso de imagem. Arquivos no bucket PRÓPRIO `media-library`, separado
-- do `whatsapp-media`: a anonimização LGPD recolhe só messages.media_storage_path,
-- então o acervo nunca é apagado pela anonimização de um contato.

create table if not exists public.media_library_items (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  when_to_use text not null default '',
  tags text[] not null default '{}',
  variants jsonb not null default '[]'::jsonb,
  contains_person boolean not null default true,
  consent_subject text,
  consent_scope text,
  consent_signed_at date,
  consent_expires_at date,
  consent_revoked_at timestamptz,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint media_library_items_title_check check (btrim(title) <> ''),
  constraint media_library_items_variants_array check (jsonb_typeof(variants) = 'array' and jsonb_array_length(variants) <= 2)
);

create index if not exists media_library_items_org_idx on public.media_library_items (organization_id);
create index if not exists media_library_items_tags_gin on public.media_library_items using gin (tags);

drop trigger if exists trg_media_library_items_updated_at on public.media_library_items;
create trigger trg_media_library_items_updated_at
  before update on public.media_library_items
  for each row execute function public.fn_set_updated_at();

alter table public.media_library_items enable row level security;

drop policy if exists tenant_isolation_media_library_items_all on public.media_library_items;
drop policy if exists tenant_isolation_media_library_items_select on public.media_library_items;
create policy tenant_isolation_media_library_items_select on public.media_library_items
  for select using (organization_id in (select public.fn_user_org_ids()));
drop policy if exists tenant_isolation_media_library_items_write on public.media_library_items;
create policy tenant_isolation_media_library_items_write on public.media_library_items
  for all using (
    organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')
  ) with check (
    organization_id in (select public.fn_user_org_ids()) and public.fn_role_at_least(organization_id, 'manager')
  );
drop policy if exists security_role_insert on public.media_library_items;
create policy security_role_insert on public.media_library_items as restrictive for insert to authenticated
  with check (public.fn_role_at_least(organization_id, 'manager'));
drop policy if exists security_role_update on public.media_library_items;
create policy security_role_update on public.media_library_items as restrictive for update to authenticated
  using (public.fn_role_at_least(organization_id, 'manager'))
  with check (public.fn_role_at_least(organization_id, 'manager'));
drop policy if exists security_role_delete on public.media_library_items;
create policy security_role_delete on public.media_library_items as restrictive for delete to authenticated
  using (public.fn_role_at_least(organization_id, 'manager'));
drop policy if exists mfa_provada on public.media_library_items;
create policy mfa_provada on public.media_library_items as restrictive for all to authenticated
  using ((select public.fn_session_mfa_proven())) with check ((select public.fn_session_mfa_proven()));

revoke all on public.media_library_items from public, anon;
revoke truncate, references, trigger on public.media_library_items from authenticated;
grant select, insert, update, delete on public.media_library_items to authenticated;
grant all on public.media_library_items to service_role;

-- Bucket privado; só o service_role lê e grava (quem autoriza é o requireRole da rota).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media-library', 'media-library', false, 52428800,
        array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/3gpp'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
```

- [ ] **Step 4: Copiar o mesmo SQL para o baseline**

Inserir, imediatamente antes da linha `-- ---- VARREDURA anon: função nova nasce exposta em quem ATUALIZA (migration 0116) ----`:

```
-- ---- biblioteca de mídias: acervo de imagem e vídeo com termo de uso (migration 0326) ----
<corpo idêntico ao da migration, do `create table` até o `on conflict ... ;` do bucket>
-- ---- fim: biblioteca de mídias (migration 0326) ----
```

- [ ] **Step 5: Linha no MANIFEST**

```
| `20261007160000` | `0326_biblioteca_de_midias` | Biblioteca de mídias (Fase 2, fatia 1): `media_library_items` (título, quando usar, etiquetas, até 2 variantes A/B em `variants`, termo de uso de imagem com assinatura, validade e revogação; `contains_person` nasce true). RLS: leitura de membro, escrita manager+ por restritivas, `mfa_provada`. Bucket privado `media-library` (50 MB, imagem e vídeo), sem policy em `storage.objects`: separado do `whatsapp-media` para a anonimização LGPD nunca alcançar o acervo. |
```

- [ ] **Step 6: Registrar em PROVA_PROPRIA**

Em `tests/invariants/rls-completude-varredura.test.ts`, acrescentar a entrada `media_library_items` no objeto `PROVA_PROPRIA` copiando o formato das entradas vizinhas e apontando para `tests/invariants/biblioteca-de-midias.test.ts`.

- [ ] **Step 7: Rodar invariantes e gates de baseline**

Run: `pnpm test:db > /tmp/db.log 2>&1; echo "exit=$?"; grep -aE "Test Files|Tests |Errors " /tmp/db.log | tail -3`
Expected: `exit=0`.
Run: `pnpm exec vitest run tests/unit/manifest-x-migrations.test.ts tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts tests/unit/baseline-reaplicavel.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/20261007160000_0326_biblioteca_de_midias.sql supabase/baseline.sql supabase/migrations/MANIFEST.md tests/invariants/biblioteca-de-midias.test.ts tests/invariants/rls-completude-varredura.test.ts
git commit -m "feat(midias): tabela e bucket da biblioteca de mídias (migration 0326)"
```

---

### Task 2: Regra do termo e esquemas (funções puras)

**Files:**
- Create: `lib/midias/termo.ts`
- Create: `lib/midias/termo.test.ts`
- Create: `lib/midias/esquemas.ts`
- Create: `lib/midias/esquemas.test.ts`

**Interfaces:**
- Produces:
  - `type Variante = { key: "A" | "B"; storage_path: string; mime: string; size_bytes: number }`
  - `type ItemDeMidia = { contains_person: boolean; consent_signed_at: string | null; consent_expires_at: string | null; consent_revoked_at: string | null; variants: Variante[] }`
  - `type SituacaoDaMidia = "pronta" | "arquivo_ausente" | "sem_termo" | "termo_vencido" | "revogada"`
  - `situacaoDaMidia(item: ItemDeMidia, hoje: string): SituacaoDaMidia` (`hoje` = `YYYY-MM-DD`)
  - `hojeNaClinica(agora?: Date): string` (data em America/Sao_Paulo)
  - `BUCKET_DA_BIBLIOTECA = "media-library"`, `TIPOS_ACEITOS_NA_BIBLIOTECA` (os 5 mimes da Global Constraints, na mesma ordem)
  - `variantesSchema` (Zod de `Variante[]`, máx 2, chaves únicas)
  - `criarMidiaSchema` `{ title, when_to_use?, tags?, contains_person? }` `.strict()`
  - `editarMidiaSchema` `{ title?, when_to_use?, tags?, contains_person?, consent?: { subject, scope, signed_at, expires_at: string | null }, revogar?: true }` `.strict()` + refine "ao menos um campo"

- [ ] **Step 1: Testes da regra (falham)**

```ts
// lib/midias/termo.test.ts
import { describe, expect, it } from "vitest";

import { hojeNaClinica, situacaoDaMidia, type ItemDeMidia } from "./termo";

const arquivo = [{ key: "A" as const, storage_path: "o/i/A-1.mp4", mime: "video/mp4", size_bytes: 10 }];
const base: ItemDeMidia = { contains_person: true, consent_signed_at: null, consent_expires_at: null, consent_revoked_at: null, variants: arquivo };

describe("situacaoDaMidia", () => {
  it("sem arquivo é arquivo_ausente, mesmo sem pessoa", () => {
    expect(situacaoDaMidia({ ...base, contains_person: false, variants: [] }, "2026-10-07")).toBe("arquivo_ausente");
  });
  it("sem pessoa não precisa de termo", () => {
    expect(situacaoDaMidia({ ...base, contains_person: false }, "2026-10-07")).toBe("pronta");
  });
  it("com pessoa e sem assinatura é sem_termo", () => {
    expect(situacaoDaMidia(base, "2026-10-07")).toBe("sem_termo");
  });
  it("assinado sem validade é pronta", () => {
    expect(situacaoDaMidia({ ...base, consent_signed_at: "2026-10-01" }, "2026-10-07")).toBe("pronta");
  });
  it("validade de hoje ainda vale; de ontem venceu", () => {
    const assinado = { ...base, consent_signed_at: "2026-10-01" };
    expect(situacaoDaMidia({ ...assinado, consent_expires_at: "2026-10-07" }, "2026-10-07")).toBe("pronta");
    expect(situacaoDaMidia({ ...assinado, consent_expires_at: "2026-10-06" }, "2026-10-07")).toBe("termo_vencido");
  });
  it("revogado vence tudo, inclusive validade futura", () => {
    expect(
      situacaoDaMidia({ ...base, consent_signed_at: "2026-10-01", consent_expires_at: "2030-01-01", consent_revoked_at: "2026-10-05T10:00:00Z" }, "2026-10-07"),
    ).toBe("revogada");
  });
});

describe("hojeNaClinica", () => {
  it("usa o fuso de São Paulo: 01:30 UTC ainda é o dia anterior", () => {
    expect(hojeNaClinica(new Date("2026-10-08T01:30:00Z"))).toBe("2026-10-07");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm exec vitest run lib/midias/termo.test.ts`
Expected: FAIL, módulo `./termo` não existe.

- [ ] **Step 3: Implementar**

```ts
// lib/midias/termo.ts
/**
 * A regra "esta mídia pode sair?" da biblioteca (spec 2026-10-06, §2.5).
 * Usada pela tela (fatia 1), pelo prompt e pelo handler de envio (fatias 2-4).
 * O handler é a trava; tela e prompt são conveniência.
 */
export const BUCKET_DA_BIBLIOTECA = "media-library";
export const TIPOS_ACEITOS_NA_BIBLIOTECA = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/3gpp"] as const;

export type Variante = { key: "A" | "B"; storage_path: string; mime: string; size_bytes: number };
export type ItemDeMidia = {
  contains_person: boolean;
  consent_signed_at: string | null;
  consent_expires_at: string | null;
  consent_revoked_at: string | null;
  variants: Variante[];
};
export type SituacaoDaMidia = "pronta" | "arquivo_ausente" | "sem_termo" | "termo_vencido" | "revogada";

export function situacaoDaMidia(item: ItemDeMidia, hoje: string): SituacaoDaMidia {
  if (item.variants.length === 0) return "arquivo_ausente";
  if (!item.contains_person) return "pronta";
  if (item.consent_revoked_at) return "revogada";
  if (!item.consent_signed_at) return "sem_termo";
  if (item.consent_expires_at && item.consent_expires_at < hoje) return "termo_vencido";
  return "pronta";
}

// ponytail: fuso fixo de São Paulo; trocar pelo fuso da organização quando houver cliente fora dele.
export function hojeNaClinica(agora: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(agora);
}
```

- [ ] **Step 4: Testes dos esquemas (falham)**

```ts
// lib/midias/esquemas.test.ts
import { describe, expect, it } from "vitest";

import { criarMidiaSchema, editarMidiaSchema, variantesSchema } from "./esquemas";

describe("esquemas da biblioteca", () => {
  it("cria com título; recusa título vazio e campo desconhecido", () => {
    expect(criarMidiaSchema.safeParse({ title: "Vídeo da unidade" }).success).toBe(true);
    expect(criarMidiaSchema.safeParse({ title: "  " }).success).toBe(false);
    expect(criarMidiaSchema.safeParse({ title: "x", organization_id: "y" }).success).toBe(false);
  });
  it("editar exige ao menos um campo", () => {
    expect(editarMidiaSchema.safeParse({}).success).toBe(false);
    expect(editarMidiaSchema.safeParse({ revogar: true }).success).toBe(true);
  });
  it("termo exige titular e data de assinatura em YYYY-MM-DD", () => {
    expect(editarMidiaSchema.safeParse({ consent: { subject: "Maria", scope: "WhatsApp comercial", signed_at: "2026-10-01", expires_at: null } }).success).toBe(true);
    expect(editarMidiaSchema.safeParse({ consent: { subject: "", scope: "x", signed_at: "2026-10-01", expires_at: null } }).success).toBe(false);
    expect(editarMidiaSchema.safeParse({ consent: { subject: "Maria", scope: "x", signed_at: "01/10/2026", expires_at: null } }).success).toBe(false);
  });
  it("validade antes da assinatura é recusada", () => {
    expect(editarMidiaSchema.safeParse({ consent: { subject: "Maria", scope: "x", signed_at: "2026-10-01", expires_at: "2026-09-01" } }).success).toBe(false);
  });
  it("variantes: no máximo 2 e sem chave repetida", () => {
    const v = (key: "A" | "B") => ({ key, storage_path: "o/i/A-1.png", mime: "image/png", size_bytes: 1 });
    expect(variantesSchema.safeParse([v("A"), v("B")]).success).toBe(true);
    expect(variantesSchema.safeParse([v("A"), v("A")]).success).toBe(false);
  });
});
```

- [ ] **Step 5: Implementar**

```ts
// lib/midias/esquemas.ts
import { z } from "zod";

const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data no formato AAAA-MM-DD.");
const etiquetas = z.array(z.string().trim().min(1).max(40)).max(20);

export const variantesSchema = z
  .array(
    z.object({
      key: z.enum(["A", "B"]),
      storage_path: z.string().min(1),
      mime: z.string().min(1),
      size_bytes: z.number().int().positive(),
    }),
  )
  .max(2)
  .refine((vs) => new Set(vs.map((v) => v.key)).size === vs.length, "Variante repetida.");

export const criarMidiaSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    when_to_use: z.string().trim().max(500).optional(),
    tags: etiquetas.optional(),
    contains_person: z.boolean().optional(),
  })
  .strict();

export const editarMidiaSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    when_to_use: z.string().trim().max(500).optional(),
    tags: etiquetas.optional(),
    contains_person: z.boolean().optional(),
    consent: z
      .object({
        subject: z.string().trim().min(1).max(120),
        scope: z.string().trim().min(1).max(200),
        signed_at: data,
        expires_at: data.nullable(),
      })
      .strict()
      .refine((c) => c.expires_at === null || c.expires_at >= c.signed_at, "A validade não pode ser antes da assinatura.")
      .optional(),
    revogar: z.literal(true).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nada para alterar.");

export type CriarMidia = z.infer<typeof criarMidiaSchema>;
export type EditarMidia = z.infer<typeof editarMidiaSchema>;
```

- [ ] **Step 6: Rodar**

Run: `pnpm exec vitest run lib/midias`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/midias
git commit -m "feat(midias): regra do termo de imagem e esquemas da biblioteca"
```

---

### Task 3: API de itens (listar, criar, editar, termo, revogar, apagar)

**Files:**
- Modify: `lib/audit/actions.ts` (7 ações no fim do array, antes de `] as const;`)
- Create: `app/api/v1/ai/midias/route.ts` (GET, POST)
- Create: `app/api/v1/ai/midias/[id]/route.ts` (PATCH, DELETE)
- Create: `app/api/v1/ai/midias/route.test.ts`
- Create: `app/api/v1/ai/midias/[id]/route.test.ts`

**Interfaces:**
- Consumes: `situacaoDaMidia`, `hojeNaClinica`, `BUCKET_DA_BIBLIOTECA`, `criarMidiaSchema`, `editarMidiaSchema`, `variantesSchema` (Task 2).
- Produces:
  - `GET /api/v1/ai/midias` → `{ data: { itens: Array<{ id, title, when_to_use, tags, contains_person, consent_subject, consent_scope, consent_signed_at, consent_expires_at, consent_revoked_at, situacao: SituacaoDaMidia, variantes: Array<{ key, mime, size_bytes, url: string | null }> }> } }` (url assinada de 1 h, para pré-visualização)
  - `POST /api/v1/ai/midias` body `CriarMidia` → 201 `{ data: { id } }`
  - `PATCH /api/v1/ai/midias/:id` body `EditarMidia` → 200 `{ data: { id, situacao } }`; 404 `not_found` se o id não é da org
  - `DELETE /api/v1/ai/midias/:id` → 200 `{ data: { id } }`; 404 se não é da org

- [ ] **Step 1: Ações de audit**

Acrescentar ao fim de `AUDIT_ACTIONS` em `lib/audit/actions.ts`:

```ts
  // Biblioteca de mídias (migration 0326). Envio é auditado pelo handler de mensagens.
  "media_library.item_created",
  "media_library.item_updated",
  "media_library.file_replaced",
  "media_library.file_removed",
  "media_library.consent_recorded",
  "media_library.consent_revoked",
  "media_library.item_deleted",
```

- [ ] **Step 2: Testes das rotas (falham)**

Copie a estrutura de mocks de `app/api/v1/ai/respostas-prontas/route.test.ts` (`vi.hoisted`, mocks de `@/lib/auth/require-role`, `@/lib/impersonate/support`, `@/lib/audit`, `@/lib/supabase/server`, `@/lib/logger`, e `supabaseGravador` de `@/tests/unit/helpers/supabase-gravador`). Mocke também `@/lib/supabase/admin` com um `storage.from().createSignedUrl/remove` gravado. Casos obrigatórios:

`route.test.ts`:
- acesso negado devolve a resposta do guard e não toca o banco (`ops` vazio)
- POST com `{ title: "" }` → 422 `validation_failed`
- POST válido insere com `organization_id` da sessão (não do body) e audita `media_library.item_created` → 201
- GET devolve `situacao` calculada (item com pessoa e sem termo → `sem_termo`; sem pessoa e com variante → `pronta`)

`[id]/route.test.ts`:
- PATCH em id que o select filtrado por org não acha → 404 `not_found`, sem update
- PATCH com `consent` grava `consent_subject/scope/signed_at/expires_at`, zera `consent_revoked_at` e audita `media_library.consent_recorded`
- PATCH com `revogar: true` grava `consent_revoked_at` e audita `media_library.consent_revoked`
- DELETE apaga a linha filtrando `organization_id` e `id`, DEPOIS remove do bucket `media-library` os `storage_path` das variantes, audita `media_library.item_deleted`; falha do `remove` não muda o 200 (só loga)

Run: `pnpm exec vitest run app/api/v1/ai/midias`
Expected: FAIL (rotas não existem).

- [ ] **Step 3: Implementar `route.ts`**

```ts
// app/api/v1/ai/midias/route.ts
/**
 * GET  /api/v1/ai/midias — itens da biblioteca com a situação calculada e URL
 *      assinada (1 h) de cada variante, para pré-visualização na tela.
 * POST /api/v1/ai/midias — cria um item (sem arquivo; o arquivo sobe por
 *      /api/v1/ai/midias/:id/arquivo).
 *
 * manager+. Cliente de SESSÃO para a linha (RLS da 0326); admin só para assinar
 * URL no bucket privado `media-library`. Filtro por organização explícito.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { criarMidiaSchema, variantesSchema } from "@/lib/midias/esquemas";
import { BUCKET_DA_BIBLIOTECA, hojeNaClinica, situacaoDaMidia } from "@/lib/midias/termo";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export const COLUNAS_DA_MIDIA =
  "id, title, when_to_use, tags, variants, contains_person, consent_subject, consent_scope, consent_signed_at, consent_expires_at, consent_revoked_at";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("media_library_items")
    .select(COLUNAS_DA_MIDIA)
    .eq("organization_id", authz.org.orgId)
    .order("title", { ascending: true });
  if (error) return fail("internal_error", t("Erro ao ler a biblioteca de mídias."), 500, { requestId });

  const hoje = hojeNaClinica();
  const storage = createAdminClient().storage.from(BUCKET_DA_BIBLIOTECA);
  const itens = await Promise.all(
    (data ?? []).map(async (linha) => {
      const variants = variantesSchema.catch([]).parse(linha.variants);
      const variantes = await Promise.all(
        variants.map(async (v) => ({
          key: v.key,
          mime: v.mime,
          size_bytes: v.size_bytes,
          url: (await storage.createSignedUrl(v.storage_path, 3600)).data?.signedUrl ?? null,
        })),
      );
      const { variants: _bruto, ...resto } = linha;
      return { ...resto, situacao: situacaoDaMidia({ ...linha, variants }, hoje), variantes };
    }),
  );
  return ok({ itens }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = criarMidiaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const supabase = await createClient();
  const { data: item, error } = await supabase
    .from("media_library_items")
    .insert({ organization_id: org.orgId, created_by_user_id: user.id, ...parsed.data })
    .select("id")
    .single();
  if (error || !item) return fail("internal_error", t("Erro ao salvar a mídia."), 500, { requestId });

  void audit({
    action: "media_library.item_created",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "media_library_item",
    resourceId: item.id,
    requestId,
    metadata: { title: parsed.data.title, contains_person: parsed.data.contains_person ?? true },
  });
  return ok({ id: item.id }, { requestId, status: 201 });
}
```

Se `variantesSchema.catch` não existir na versão do Zod do repo, troque por `const r = variantesSchema.safeParse(linha.variants); const variants = r.success ? r.data : [];`.

- [ ] **Step 4: Implementar `[id]/route.ts`**

```ts
// app/api/v1/ai/midias/[id]/route.ts
/**
 * PATCH  /api/v1/ai/midias/:id — edita nome, quando usar, etiquetas, "mostra
 *        pessoa", registra o termo ou revoga. Revogar é imediato: a fatia 2
 *        confere a situação no envio.
 * DELETE /api/v1/ai/midias/:id — apaga o item e, depois, os arquivos.
 * manager+. Item de outra organização responde 404 (não vaza existência).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { editarMidiaSchema, variantesSchema } from "@/lib/midias/esquemas";
import { BUCKET_DA_BIBLIOTECA, hojeNaClinica, situacaoDaMidia } from "@/lib/midias/termo";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

async function guarda(requestId: string) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return { ok: false as const, response: supportDenied };
  return requireRole("manager", { requestId, resource: "media_library" });
}

export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await guarda(requestId);
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });

  const parsed = editarMidiaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { consent, revogar, ...campos } = parsed.data;
  const mudanca: Record<string, unknown> = { ...campos };
  const acoes: AuditAction[] = [];
  if (Object.keys(campos).length > 0) acoes.push("media_library.item_updated");
  if (consent) {
    Object.assign(mudanca, {
      consent_subject: consent.subject,
      consent_scope: consent.scope,
      consent_signed_at: consent.signed_at,
      consent_expires_at: consent.expires_at,
      consent_revoked_at: null,
    });
    acoes.push("media_library.consent_recorded");
  }
  if (revogar) {
    mudanca.consent_revoked_at = new Date().toISOString();
    acoes.push("media_library.consent_revoked");
  }

  const supabase = await createClient();
  const { data: item, error } = await supabase
    .from("media_library_items")
    .update(mudanca)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id, variants, contains_person, consent_signed_at, consent_expires_at, consent_revoked_at")
    .maybeSingle();
  if (error) return fail("internal_error", t("Erro ao salvar a mídia."), 500, { requestId });
  if (!item) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });

  for (const action of acoes) {
    void audit({
      action,
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "media_library_item",
      resourceId: id,
      requestId,
      metadata: action === "media_library.consent_recorded" ? { expires_at: consent?.expires_at ?? null } : {},
    });
  }
  const parsedVariants = variantesSchema.safeParse(item.variants);
  const situacao = situacaoDaMidia({ ...item, variants: parsedVariants.success ? parsedVariants.data : [] }, hojeNaClinica());
  return ok({ id, situacao }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: Ctx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await guarda(requestId);
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });

  const supabase = await createClient();
  const { data: item, error } = await supabase
    .from("media_library_items")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .select("id, title, variants")
    .maybeSingle();
  if (error) return fail("internal_error", t("Erro ao apagar a mídia."), 500, { requestId });
  if (!item) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });

  // A linha sai primeiro: arquivo órfão é só espaço; linha sem arquivo seria item quebrado.
  const v = variantesSchema.safeParse(item.variants);
  const caminhos = v.success ? v.data.map((x) => x.storage_path) : [];
  if (caminhos.length > 0) {
    const { error: erroRemove } = await createAdminClient().storage.from(BUCKET_DA_BIBLIOTECA).remove(caminhos);
    if (erroRemove) logger.warn("[midias] arquivos ficaram no bucket após apagar o item", { id, requestId, detail: erroRemove.message });
  }
  void audit({
    action: "media_library.item_deleted",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "media_library_item",
    resourceId: id,
    requestId,
    metadata: { title: item.title },
  });
  return ok({ id }, { requestId });
}
```

Confira a assinatura real de `requireRole` em `lib/auth/require-role.ts`: se o retorno negado não tiver `.response`, adapte `guarda` ao formato existente. Se `logger.warn` não existir, use `logger.error`.

- [ ] **Step 5: Rodar**

Run: `pnpm exec vitest run app/api/v1/ai/midias lib/midias tests/unit/audit-lista-do-painel-e-derivada.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/audit/actions.ts app/api/v1/ai/midias
git commit -m "feat(midias): API da biblioteca com termo, revogação e situação calculada"
```

---

### Task 4: Upload e remoção de arquivo por variante

**Files:**
- Create: `app/api/v1/ai/midias/[id]/arquivo/route.ts` (POST multipart `variante` + `arquivo`; DELETE `?variante=`)
- Create: `app/api/v1/ai/midias/[id]/arquivo/route.test.ts`

**Interfaces:**
- Consumes: `validateOutboundMedia` de `lib/messaging/media/upload-validation.ts`; `BUCKET_DA_BIBLIOTECA`, `TIPOS_ACEITOS_NA_BIBLIOTECA`, `variantesSchema`, `situacaoDaMidia`, `hojeNaClinica`.
- Produces: `POST /api/v1/ai/midias/:id/arquivo` → 201 `{ data: { key, situacao } }`; `DELETE /api/v1/ai/midias/:id/arquivo?variante=B` → 200 `{ data: { key, situacao } }`.

- [ ] **Step 1: Testes (falham)**

Casos obrigatórios em `route.test.ts` (mesmos mocks da Task 3, mais o storage admin gravado):
- `content-length` declarado acima de 50 MB + 64 KB → 413 sem ler o corpo nem tocar o storage
- `variante` diferente de A/B, ou sem arquivo → 400 `invalid_request`
- arquivo com `type: "image/png"` cujos bytes são `<svg ...>` → 415 `unsupported_media_type`
- mime fora de `TIPOS_ACEITOS_NA_BIBLIOTECA` (ex.: `application/pdf` válido) → 415
- item de outra org (select por org devolve null) → 404 e nenhum `upload`
- sucesso em variante nova: `upload` em `media-library` com caminho `^<org>/<id>/A-[0-9a-f-]{36}\.png$`, update de `variants` com a variante, audit `media_library.file_replaced` → 201
- troca de variante existente: o arquivo antigo é removido DEPOIS do update; se o update falhar, o novo é removido e nada do antigo sai
- DELETE `?variante=B`: tira B de `variants`, remove o arquivo, audita `media_library.file_removed`

Use bytes reais de PNG no teste de sucesso: `new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,0])`.

Run: `pnpm exec vitest run app/api/v1/ai/midias/[id]/arquivo`
Expected: FAIL.

- [ ] **Step 2: Implementar**

```ts
// app/api/v1/ai/midias/[id]/arquivo/route.ts
/**
 * POST   multipart `variante` (A|B) + `arquivo` — sobe ou TROCA o arquivo da
 *        variante. O item, o id e as automações que apontam para ele não mudam.
 * DELETE `?variante=` — tira a variante do item.
 * manager+. Tipo FAREJADO pelos bytes (validateOutboundMedia). Bucket privado,
 * só service_role (migration 0326). Organização sempre da sessão.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";
import { validateOutboundMedia } from "@/lib/messaging/media/upload-validation";
import { variantesSchema } from "@/lib/midias/esquemas";
import {
  BUCKET_DA_BIBLIOTECA,
  TIPOS_ACEITOS_NA_BIBLIOTECA,
  hojeNaClinica,
  situacaoDaMidia,
  type Variante,
} from "@/lib/midias/termo";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const EXTENSAO: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
};
const ehVariante = (v: unknown): v is "A" | "B" => v === "A" || v === "B";

async function lerItem(orgId: string, id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("media_library_items")
    .select("id, variants, contains_person, consent_signed_at, consent_expires_at, consent_revoked_at")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return { erro: true as const };
  if (!data) return { item: null };
  const v = variantesSchema.safeParse(data.variants);
  return { item: { ...data, variants: v.success ? v.data : [] }, supabase };
}

async function gravarVariantes(orgId: string, id: string, variants: Variante[]) {
  const supabase = await createClient();
  const { error } = await supabase
    .from("media_library_items")
    .update({ variants })
    .eq("organization_id", orgId)
    .eq("id", id);
  return !error;
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });

  const declarado = Number(req.headers.get("content-length") ?? 0);
  if (declarado > MAX_MEDIA_BYTES + 64 * 1024) {
    return fail("payload_too_large", t("O arquivo pode ter no máximo 50 MB."), 413, { requestId });
  }
  const form = await req.formData().catch(() => null);
  const variante = form?.get("variante");
  const arquivo = form?.get("arquivo");
  if (!ehVariante(variante) || !(arquivo instanceof File)) {
    return fail("invalid_request", t("Escolha a variante e o arquivo."), 400, { requestId });
  }
  const bytes = new Uint8Array(await arquivo.arrayBuffer());
  const mime = (arquivo.type || "").split(";")[0]!.trim().toLowerCase();
  const validacao = validateOutboundMedia(mime, arquivo.size, bytes);
  if (!validacao.ok) {
    const status = validacao.code === "payload_too_large" ? 413 : validacao.code === "unsupported_media_type" ? 415 : 422;
    return fail(validacao.code, t(validacao.message), status, { requestId });
  }
  if (!(TIPOS_ACEITOS_NA_BIBLIOTECA as readonly string[]).includes(mime)) {
    return fail("unsupported_media_type", t("Use imagem JPG, PNG ou WEBP, ou vídeo MP4."), 415, { requestId });
  }

  // Lê o item ANTES de subir: item de outra org não gera arquivo órfão.
  const lido = await lerItem(orgId, id);
  if ("erro" in lido) return fail("internal_error", t("Erro ao salvar o arquivo."), 500, { requestId });
  if (!lido.item) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });

  const caminho = `${orgId}/${id}/${variante}-${randomUUID()}.${EXTENSAO[mime]}`;
  const storage = createAdminClient().storage.from(BUCKET_DA_BIBLIOTECA);
  const { error: erroUp } = await storage.upload(caminho, Buffer.from(bytes), { contentType: mime, upsert: false });
  if (erroUp) {
    logger.error("[midias] upload falhou", { requestId, detail: erroUp.message });
    return fail("internal_error", t("Erro ao subir o arquivo."), 500, { requestId });
  }

  const anterior = lido.item.variants.find((v) => v.key === variante);
  const novas: Variante[] = [
    ...lido.item.variants.filter((v) => v.key !== variante),
    { key: variante, storage_path: caminho, mime, size_bytes: arquivo.size },
  ].sort((a, b) => a.key.localeCompare(b.key));
  if (!(await gravarVariantes(orgId, id, novas))) {
    await storage.remove([caminho]);
    return fail("internal_error", t("Erro ao salvar o arquivo."), 500, { requestId });
  }
  // O antigo sai DEPOIS do novo gravado: falhar aqui deixa órfão, nunca item sem arquivo.
  if (anterior) await storage.remove([anterior.storage_path]);

  void audit({
    action: "media_library.file_replaced",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "media_library_item",
    resourceId: id,
    requestId,
    metadata: { variante, mime, bytes: arquivo.size, substituiu: Boolean(anterior) },
  });
  return ok({ key: variante, situacao: situacaoDaMidia({ ...lido.item, variants: novas }, hojeNaClinica()) }, { requestId, status: 201 });
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "media_library" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const { id } = await ctx.params;
  const variante = new URL(req.url).searchParams.get("variante");
  if (!z.string().uuid().safeParse(id).success) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });
  if (!ehVariante(variante)) return fail("invalid_request", t("Variante desconhecida."), 400, { requestId });

  const lido = await lerItem(orgId, id);
  if ("erro" in lido) return fail("internal_error", t("Erro ao remover o arquivo."), 500, { requestId });
  if (!lido.item) return fail("not_found", t("Mídia não encontrada."), 404, { requestId });
  const alvo = lido.item.variants.find((v) => v.key === variante);
  const novas = lido.item.variants.filter((v) => v.key !== variante);
  if (alvo) {
    if (!(await gravarVariantes(orgId, id, novas))) {
      return fail("internal_error", t("Erro ao remover o arquivo."), 500, { requestId });
    }
    await createAdminClient().storage.from(BUCKET_DA_BIBLIOTECA).remove([alvo.storage_path]);
    void audit({
      action: "media_library.file_removed",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "media_library_item",
      resourceId: id,
      requestId,
      metadata: { variante },
    });
  }
  return ok({ key: variante, situacao: situacaoDaMidia({ ...lido.item, variants: novas }, hojeNaClinica()) }, { requestId });
}
```

Se o `fail()` não aceitar `validacao.code` direto como código, confira `lib/api/errors.ts` e mapeie para os códigos canônicos equivalentes usados em `app/api/v1/conversations/[id]/media/route.ts:89-95`.

- [ ] **Step 3: Rodar**

Run: `pnpm exec vitest run app/api/v1/ai/midias`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/api/v1/ai/midias/[id]/arquivo
git commit -m "feat(midias): subir, trocar e remover o arquivo de cada variante"
```

---

### Task 5: Tela "Biblioteca de mídias" e porta na navegação

**Files:**
- Create: `app/app/ai/midias/page.tsx`
- Create: `app/app/ai/midias/_client.tsx`
- Create: `hooks/ai/useMidias.ts`
- Modify: `lib/navigation/catalogo.ts` (entrada logo depois de "Perguntas frequentes", L376-387)
- Modify: `lib/navigation/registry.ts` (adicionar `ImageSquare` ao `ICONS`, importando de `@/lib/ui/icons`)

**Interfaces:**
- Consumes: as rotas das Tasks 3 e 4; `SituacaoDaMidia`.
- Produces: rota `/app/ai/midias`; `data-testid` usados pelo e2e da Task 6: `midia-item` (cartão), `midia-situacao` (selo), `midia-nova` (botão), `midia-titulo`, `midia-quando-usar`, `midia-etiquetas`, `midia-mostra-pessoa` (checkbox), `midia-arquivo-A`, `midia-arquivo-B` (inputs file), `midia-termo-titular`, `midia-termo-escopo`, `midia-termo-assinado`, `midia-termo-validade`, `midia-termo-salvar`, `midia-revogar`, `midia-apagar`.

- [ ] **Step 1: Porta na navegação (teste de completude falha antes da página existir? Não: a página ainda não existe, então crie a entrada junto com a página)**

```ts
// lib/navigation/catalogo.ts, logo após o objeto de "/app/ai/perguntas-frequentes"
  {
    href: "/app/ai/midias",
    label: "Biblioteca de mídias",
    description: "Imagens e vídeos que o agente e os follow-ups podem enviar, com o termo de uso de imagem.",
    icon: "ImageSquare",
    group: "ia",
    section: "Ensinar o agente",
    minRole: "manager",
  },
```

- [ ] **Step 2: Página servidor**

```tsx
// app/app/ai/midias/page.tsx
import { redirect } from "next/navigation";

import { requireAuth } from "@/lib/auth/require-auth";
import { resolveActiveOrg } from "@/lib/auth/active-org";
import { ROLE_RANK } from "@/lib/auth/roles";

import { BibliotecaDeMidias } from "./_client";

export const metadata = { title: "Biblioteca de mídias" };

export default async function Page() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  return <BibliotecaDeMidias />;
}
```

Os caminhos de import de `requireAuth`, `resolveActiveOrg` e `ROLE_RANK` devem ser copiados exatamente de `app/app/ai/perguntas-frequentes/page.tsx` (os acima são o formato esperado; o arquivo é a fonte).

- [ ] **Step 3: Hook**

Copie a forma de `hooks/ai/useRespostasProntas.ts` (react-query + `apiClient` de `@/lib/api/client`), com `BASE = "/api/v1/ai/midias"`, exportando: `useMidias()` (GET, chave `["midias"]`), `useCriarMidia()`, `useEditarMidia()` (PATCH `/:id`), `useApagarMidia()`, `useSubirArquivo()` (POST multipart `/:id/arquivo` com `FormData` `variante`+`arquivo`, via `fetch` direto se o `apiClient` não aceitar `FormData`) e `useRemoverArquivo()`. Toda mutação invalida `["midias"]`.

- [ ] **Step 4: Cliente**

`_client.tsx`, seguindo o visual de `app/app/ai/perguntas-frequentes/_client.tsx` (mesmos componentes de cabeçalho, cartão, botão e campos):
- Cabeçalho `h1` "Biblioteca de mídias" e uma linha: "Suba uma vez e o agente e os follow-ups reutilizam. Trocar o arquivo não mexe em nenhuma automação."
- Botão `midia-nova` abre um formulário com título, quando usar, etiquetas (texto separado por vírgula) e "Mostra pessoa identificável?" (marcado por padrão) → `useCriarMidia`.
- Lista de cartões `midia-item`, cada um com: pré-visualização (`<img>` para imagem, `<video controls preload="metadata">` para vídeo) das variantes A e B; selo `midia-situacao` com os textos `Pronta` / `Sem termo` / `Termo vencido` / `Revogada` / `Arquivo ausente` (Pronta em verde, demais em âmbar, Revogada em vermelho); inputs `midia-arquivo-A` e `midia-arquivo-B` (`accept="image/jpeg,image/png,image/webp,video/mp4,video/3gpp"`); quando `contains_person`, bloco "Termo de uso de imagem" com titular, escopo, data de assinatura, validade (vazia = sem prazo) e botão `midia-termo-salvar`; se há termo ativo, botão `midia-revogar`, que confirma com o texto "Revogar para de enviar agora. O que já foi enviado no WhatsApp não volta." ; botão `midia-apagar` com confirmação.
- Mostrar o erro da API (`error.message`) abaixo do campo que falhou; nunca travar a lista.
- Sem travessão nos textos.

- [ ] **Step 5: Rodar gates**

Run: `pnpm typecheck && pnpm lint && pnpm exec vitest run tests/unit/navegacao-completude.test.ts tests/unit/navegacao-registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/app/ai/midias hooks/ai/useMidias.ts lib/navigation/catalogo.ts lib/navigation/registry.ts
git commit -m "feat(midias): tela da biblioteca com termo de uso de imagem"
```

---

### Task 6: Prova pela tela, fragmento e documentação

**Files:**
- Create: `tests/e2e/biblioteca-de-midias.spec.ts`
- Create: `tests/e2e/fixtures/midia-teste.png` (PNG 1x1 real) e `tests/e2e/fixtures/midia-teste.mp4` (MP4 curto real; gere com `ffmpeg -f lavfi -i color=c=green:s=64x64:d=1 -pix_fmt yuv420p tests/e2e/fixtures/midia-teste.mp4` ou reutilize um MP4 de fixture que já exista em `tests/`)
- Modify: `.github/workflows/e2e.yml` (pôr `biblioteca-de-midias.spec.ts` na `SPECS_PARTE_*` com menos specs)
- Create: `.changes/biblioteca-de-midias.md`
- Modify: `docs/testing/user-journey-map.md` (casos novos da jornada "Ensinar o agente")
- Modify: `docs/architecture/` (se houver mapa de IA; acrescentar o nó `media_library_items` com arestas para a tela e o bucket, seguindo o formato do arquivo)

- [ ] **Step 1: Spec e2e (copie a estrutura de `tests/e2e/respostas-prontas.spec.ts`)**

Roteiro, como um gestor leigo, pela tela:
1. Login como gestor (`.e2e-creds.json`), abrir `/app/ai/midias` pela navegação (menu "Agente de IA" › "Biblioteca de mídias"), conferir `h1`.
2. Criar "E2E vídeo da unidade" com "Mostra pessoa identificável?" desmarcado; subir `midia-teste.mp4` na variante A; selo vira `Pronta`.
3. Criar "E2E antes e depois" com pessoa; subir `midia-teste.png`; selo `Sem termo`; preencher termo (titular, escopo, assinatura de hoje, sem validade) e salvar; selo `Pronta`.
4. Trocar o arquivo da variante A do item 3; selo continua `Pronta` e a contagem de cartões não muda.
5. Revogar; confirmar; selo `Revogada`.
6. Apagar os dois itens; lista sem eles.
7. Screenshot em cada selo para `.superpowers/evidence/biblioteca-de-midias/`.
`limpar()` no `beforeAll`/`afterAll` apagando itens com título `E2E %` pelo admin client (e os arquivos do bucket `media-library` sob o prefixo da org).

- [ ] **Step 2: Rodar contra banco fresco**

Run (receita de ambiente fresco do CLAUDE.md: Supabase local pg15 com `baseline.sql`, `next build && next start`): `E2E_PORT=3032 pnpm exec playwright test tests/e2e/biblioteca-de-midias.spec.ts`
Expected: PASS, com as screenshots em `.superpowers/evidence/biblioteca-de-midias/`.

- [ ] **Step 3: Fragmento de release**

```md
---
efeito: capacidade_nova
---
Biblioteca de mídias: em Agente de IA › Biblioteca de mídias, o gestor sobe imagens e vídeos, diz quando usar, marca etiquetas e registra o termo de uso de imagem de quem aparece. A tela mostra se cada mídia está pronta para envio. O envio pelo agente e pelos follow-ups chega nas próximas versões.
```

Confira o formato exato do cabeçalho com um fragmento existente em `.changes/` e rode `pnpm release:conferir`.

- [ ] **Step 4: Suíte completa**

```bash
pnpm typecheck && pnpm lint
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests |Errors " /tmp/vt.log | tail -3
pnpm test:db > /tmp/db.log 2>&1; echo "exit=$?"
```
Expected: os três `exit=0`, rodapé sem `failed` e sem linha `Errors`.

- [ ] **Step 5: Commit e PR**

```bash
git add tests/e2e/biblioteca-de-midias.spec.ts tests/e2e/fixtures .github/workflows/e2e.yml .changes/biblioteca-de-midias.md docs
git commit -m "test(midias): jornada da biblioteca pela tela, fragmento e mapa"
git push -u origin feat/biblioteca-de-midias
gh pr create --repo institutoevanutro-dev/CRM-EVA --title "feat(midias): biblioteca de mídias com termo de uso de imagem (Fase 2, fatia 1)" --body-file /tmp/pr-midias.md
```

---

## Fatias seguintes (cada uma ganha seu plano quando a anterior entrar)

- **Fatia 2 (envio):** migration própria com `messages.media_library_item_id ... on delete set null`; ramo novo em `app/api/v1/messages/_handler.ts` ao lado do de `media_storage_path` (L823) que resolve o item pela org da conversa, chama `situacaoDaMidia` na hora e assina URL de 10 min no `media-library`; rota `messages/[id]/media` resolvendo pelo item; invariante "anonimizar contato que recebeu mídia da biblioteca não enfileira o arquivo do acervo".
- **Fatia 3 (IA):** tool `send_media { media_id, caption? }` em `lib/agent-engine/agent/inbound-turn.ts`, teto de 1 mídia por turno dentro do `MAX_SENDS_PER_TURN`, lista de itens `Pronta` no prompt, legenda pela cadeia de guardrails, erros de ensino `media_not_found|media_consent_invalid|media_not_ready`, sorteio A/B por lead (`reentry-template.ts:108`) gravado em `metadata.media_variant`.
- **Fatia 4 (follow-up):** modo `media` em `actionConfigSchema` (`lib/followup/graph-schema.ts:213`), motor em `followup-turn.ts`, formulário do passo e legenda do histórico.
- **Fatia 5:** e2e de envio com WAHA real (imagem e vídeo de 30 MB) e evidência.
