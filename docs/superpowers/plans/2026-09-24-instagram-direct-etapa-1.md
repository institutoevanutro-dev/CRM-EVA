# Instagram Direct no CRM · Etapa 1 (conectar e receber) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conectar contas profissionais do Instagram em Conexões e fazer cada mensagem do Direct aparecer no Inbox do CRM, com contato, conversa, card no funil e Origem padrão preenchida.

**Architecture:** Novo provider `meta_instagram` dentro de `lib/channels/` (a doutrina proíbe nome de provider fora dali). Identidade de quem escreve (IGSID) vai para a tabela nova `contact_channel_identities`; conversa usa `channel = 'instagram'`. Webhook é do APP (um callback para todas as contas) e roteia por `entry[].id` = conta do Instagram. Ingestão reusa `marcarConversaComMensagem` e `aplicarEfeitosPosEntrada`, os mesmos passos do WhatsApp oficial.

**Tech Stack:** Next.js 16 route handlers, Supabase Postgres (migration + apêndice do `baseline.sql`), Zod, Vitest, Playwright; Instagram API with Instagram Login (`graph.instagram.com`).

**Spec:** `docs/superpowers/specs/2026-09-24-instagram-direct-no-crm-design.md`

## Global Constraints

- Nenhum arquivo fora de `lib/channels/` escreve `meta_instagram`, `instagram` como provider, nem `graph.instagram.com` (`pnpm lint:channels`). Fora dali, pergunte por capacidade.
- Toda mudança de schema: arquivo `supabase/migrations/<timestamp>_0277_instagram_canal.sql` + bloco idempotente no fim do `supabase/baseline.sql` + linha no `supabase/migrations/MANIFEST.md`. Confira o número antes: `ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1` (era 0276 em 24/09).
- As constraints `channel_sessions_provider_check` e `channel_sessions_provider_ref_check` vivem em UM bloco só (`baseline.sql`, perto da linha 9387). Edite ESSE bloco; não crie outro `drop`/`add` (`tests/unit/baseline-constraint-reconstruida.test.ts`).
- Toda função nova em `public`: `revoke execute ... from public, anon;` + `grant execute ... to service_role;`.
- Toda consulta por `ig_account_id` fora da resolução inicial do webhook filtra `organization_id`. `organization_id` nunca vem do corpo da requisição.
- Scopes do login: `instagram_business_basic,instagram_business_manage_messages`. Callback: `/api/v1/channels/instagram/callback`. Webhook: `/api/v1/webhooks/instagram`.
- Nenhuma env nova obrigatória. `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET` são opcionais (piso de rollback); a fonte é `platform_meta_app`.
- Texto de tela em português, envolvido em `t()`, com entrada `es` no `lib/i18n/dicionario.ts`. Sem travessão (`—`) em texto de tela.
- Sem `console.log`; use `logger` de `lib/logger.ts`.
- Etapa 1 NÃO envia mensagem pelo Instagram: o adapter recusa `send` com código próprio.

## Review Focus

1. **Assinatura inválida no webhook** → 401 **e** `logger.warn` com o motivo. Teste na Task 6.
2. **Conta do Instagram não conectada** (`entry.id` desconhecido) → 200, nada gravado, `logger.info`. Teste na Task 6.
3. **Mesma mensagem entregue duas vezes** (retry da Meta) → uma linha só em `messages`. Teste na Task 5.
4. **Eco** (a própria conta respondeu pelo app do Instagram) → entra como `outbound`, não cria contato para a própria conta. Teste na Task 4 e 5.
5. **Mensagem sem texto** (só imagem, ou `is_deleted`/`reaction`) → imagem entra como `image`; reação e apagada são ignoradas sem erro. Teste na Task 4.

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/<ts>_0277_instagram_canal.sql` | schema da etapa 1 |
| `supabase/baseline.sql` (bloco de constraints + apêndice) | espelho idempotente |
| `lib/channels/types.ts`, `capabilities.ts`, `index.ts`, `session-ref.ts`, `templates-fonte.ts` | registrar o provider |
| `scripts/lint-channels.pattern.ts` | fronteira do nome |
| `lib/channels/instagram/app.ts` | credencial do app (ID + segredo) |
| `lib/channels/instagram/webhook.ts` | parse puro do payload |
| `lib/channels/instagram/ingest.ts` | gravar contato, conversa, mensagem |
| `lib/channels/instagram/graph.ts` | chamadas HTTP a `graph.instagram.com` |
| `lib/channels/instagram/oauth.ts` | URL de login, troca de code, `state` assinado |
| `lib/channels/adapters/instagram.ts` | adapter (sem envio na etapa 1) |
| `app/api/v1/webhooks/instagram/route.ts` | GET desafio, POST entrega |
| `app/api/v1/channels/instagram/connect/route.ts`, `callback/route.ts` | login |
| `app/api/v1/cron/instagram-token-refresh/route.ts` + `docker/scheduler/entrypoint.sh` | renovar chave |
| `app/admin/(protected)/meta/_form.tsx`, `page.tsx` | cadastrar ID e segredo do Instagram |
| `components/connections/CanalInstagramClient.tsx`, `ConnectionsClient.tsx` | cartão em Conexões |
| `components/inbox/ConversationListItem.tsx`, `ConversationHeader.tsx` | contato sem telefone |

---

### Task 1: Schema da etapa 1

**Files:**
- Create: `supabase/migrations/20260925090000_0277_instagram_canal.sql`
- Modify: `supabase/baseline.sql` (bloco de constraints de `channel_sessions`, perto da linha 9370; e um bloco novo no fim)
- Modify: `supabase/migrations/MANIFEST.md`
- Test: `tests/invariants/instagram-canal.test.ts`

**Interfaces:**
- Produces:
  - colunas `channel_sessions.ig_account_id text`, `ig_username text`, `ig_token_encrypted bytea`, `ig_token_expires_at timestamptz`
  - `platform_meta_app.ig_app_id text`, `platform_meta_app.ig_app_secret_encrypted bytea`
  - tabela `contact_channel_identities(id, organization_id, contact_id, channel, external_id, handle, display_name, avatar_url, created_at, updated_at)`
  - `fn_upsert_contato_por_identidade(p_org uuid, p_canal text, p_external_id text, p_handle text, p_nome text, p_avatar text) returns table(contact_id uuid, criado boolean)`
  - `fn_upsert_conversa_de_canal(p_org uuid, p_contact uuid, p_session uuid, p_canal text) returns uuid`

- [ ] **Step 1: Escrever o teste de invariantes (falha)**

```ts
// tests/invariants/instagram-canal.test.ts
import { describe, expect, it } from "vitest";
import { comDuasOrgs, sql } from "./helpers/db";

describe("canal Instagram no schema", () => {
  it("channel_sessions aceita meta_instagram só com ig_account_id", async () => {
    await comDuasOrgs(async ({ orgA }) => {
      await expect(
        sql`insert into channel_sessions (organization_id, provider, status) values (${orgA}, 'meta_instagram', 'WORKING')`,
      ).rejects.toThrow(/channel_sessions_provider_ref_check/);
      await sql`insert into channel_sessions (organization_id, provider, status, ig_account_id, ig_username)
                values (${orgA}, 'meta_instagram', 'WORKING', '17841400000000001', 'clinica')`;
    });
  });

  it("conversations aceita channel instagram", async () => {
    const [{ ok }] = await sql`select pg_get_constraintdef(oid) ~ 'instagram' as ok
      from pg_constraint where conname = 'conversations_channel_check'`;
    expect(ok).toBe(true);
  });

  it("upsert por identidade é idempotente e isola organizações", async () => {
    await comDuasOrgs(async ({ orgA, orgB }) => {
      const [a1] = await sql`select * from fn_upsert_contato_por_identidade(${orgA}, 'instagram', 'IGSID1', 'maria', 'Maria', null)`;
      const [a2] = await sql`select * from fn_upsert_contato_por_identidade(${orgA}, 'instagram', 'IGSID1', 'maria', 'Maria', null)`;
      const [b1] = await sql`select * from fn_upsert_contato_por_identidade(${orgB}, 'instagram', 'IGSID1', 'maria', 'Maria', null)`;
      expect(a1.criado).toBe(true);
      expect(a2.criado).toBe(false);
      expect(a2.contact_id).toBe(a1.contact_id);
      expect(b1.contact_id).not.toBe(a1.contact_id);
    });
  });

  it("RPCs novas não são alcançáveis por anon nem authenticated", async () => {
    const linhas = await sql`select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon,
        has_function_privilege('authenticated', p.oid, 'execute') as auth
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('fn_upsert_contato_por_identidade', 'fn_upsert_conversa_de_canal')`;
    expect(linhas).toHaveLength(2);
    for (const l of linhas) expect([l.anon, l.auth]).toEqual([false, false]);
  });

  it("RLS de contact_channel_identities isola por organização", async () => {
    const [{ rls }] = await sql`select relrowsecurity as rls from pg_class where relname = 'contact_channel_identities'`;
    expect(rls).toBe(true);
    const [{ n }] = await sql`select count(*)::int as n from pg_policies
      where tablename = 'contact_channel_identities' and policyname = 'tenant_isolation_contact_channel_identities_all'`;
    expect(n).toBe(1);
  });
});
```

Antes de escrever, abra `tests/invariants/` e use o helper de banco que os vizinhos usam (por exemplo o de `tests/invariants/retencao-poda-e-expurgo.test.ts`). Se os nomes `comDuasOrgs`/`sql` forem outros, troque pelos reais, mantendo as asserções.

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:db -- instagram-canal`
Expected: FAIL (`fn_upsert_contato_por_identidade` não existe; constraint recusa `meta_instagram`).

- [ ] **Step 3: Escrever a migration**

```sql
-- supabase/migrations/20260925090000_0277_instagram_canal.sql
-- Canal Instagram (spec docs/superpowers/specs/2026-09-24-instagram-direct-no-crm-design.md).
alter table public.channel_sessions
  add column if not exists ig_account_id text,
  add column if not exists ig_username text,
  add column if not exists ig_token_encrypted bytea,
  add column if not exists ig_token_expires_at timestamptz;

alter table public.channel_sessions drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions add constraint channel_sessions_provider_check
  check (provider = any (array['waha','meta_cloud','zernio','wacalls','meta_instagram']));
alter table public.channel_sessions drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions add constraint channel_sessions_provider_ref_check check (
  (provider = 'waha'           and waha_session_name    is not null) or
  (provider = 'meta_cloud'     and meta_phone_number_id is not null) or
  (provider = 'zernio'         and zernio_account_id    is not null) or
  (provider = 'wacalls'        and wacalls_session_id   is not null) or
  (provider = 'meta_instagram' and ig_account_id        is not null)
);

-- Uma conta do Instagram ativa em UMA organização da instalação: o webhook é do app
-- e roteia por conta; duas orgs com a mesma conta seria entrega ambígua.
create unique index if not exists uniq_channel_sessions_ig_account_ativa
  on public.channel_sessions (ig_account_id)
  where ig_account_id is not null and archived_at is null;

alter table public.conversations drop constraint if exists conversations_channel_check;
alter table public.conversations add constraint conversations_channel_check
  check (channel = any (array['whatsapp','instagram']));

alter table public.platform_meta_app
  add column if not exists ig_app_id text,
  add column if not exists ig_app_secret_encrypted bytea;

create table if not exists public.contact_channel_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel text not null check (channel = any (array['instagram'])),
  external_id text not null,
  handle text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, channel, external_id)
);
create index if not exists idx_contact_channel_identities_contact
  on public.contact_channel_identities (organization_id, contact_id);

alter table public.contact_channel_identities enable row level security;
drop policy if exists tenant_isolation_contact_channel_identities_all on public.contact_channel_identities;
create policy tenant_isolation_contact_channel_identities_all on public.contact_channel_identities
  for all using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

create or replace function public.fn_upsert_contato_por_identidade(
  p_org uuid, p_canal text, p_external_id text, p_handle text, p_nome text, p_avatar text
) returns table(contact_id uuid, criado boolean)
language plpgsql security definer set search_path = public as $$
declare v_contato uuid;
begin
  select i.contact_id into v_contato from public.contact_channel_identities i
   where i.organization_id = p_org and i.channel = p_canal and i.external_id = p_external_id;
  if v_contato is not null then
    update public.contact_channel_identities set
      handle = coalesce(nullif(p_handle, ''), handle),
      display_name = coalesce(nullif(p_nome, ''), display_name),
      avatar_url = coalesce(nullif(p_avatar, ''), avatar_url),
      updated_at = now()
    where organization_id = p_org and channel = p_canal and external_id = p_external_id;
    return query select v_contato, false;
    return;
  end if;
  insert into public.contacts (organization_id, source, consent, tags, source_metadata, display_name)
  values (p_org, p_canal, '{}'::jsonb, '{}'::text[],
          jsonb_build_object('handle', nullif(p_handle, '')),
          coalesce(nullif(p_nome, ''), nullif(p_handle, '')))
  returning id into v_contato;
  insert into public.contact_channel_identities (organization_id, contact_id, channel, external_id, handle, display_name, avatar_url)
  values (p_org, v_contato, p_canal, p_external_id, nullif(p_handle, ''), nullif(p_nome, ''), nullif(p_avatar, ''))
  on conflict (organization_id, channel, external_id) do nothing;
  if not found then
    -- corrida: outra entrega criou a identidade entre o select e o insert
    delete from public.contacts where id = v_contato;
    select i.contact_id into v_contato from public.contact_channel_identities i
     where i.organization_id = p_org and i.channel = p_canal and i.external_id = p_external_id;
    return query select v_contato, false;
    return;
  end if;
  return query select v_contato, true;
end; $$;

create or replace function public.fn_upsert_conversa_de_canal(
  p_org uuid, p_contact uuid, p_session uuid, p_canal text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.conversations (organization_id, contact_id, channel_session_id, channel, status, is_group, unread_count_for_assignee, metadata)
  values (p_org, p_contact, p_session, p_canal, 'open', false, 0, '{}'::jsonb)
  on conflict (organization_id, contact_id, channel_session_id) where is_group = false
  do update set updated_at = now()
  returning id into v_id;
  return v_id;
end; $$;

revoke execute on function public.fn_upsert_contato_por_identidade(uuid, text, text, text, text, text) from public, anon, authenticated;
grant  execute on function public.fn_upsert_contato_por_identidade(uuid, text, text, text, text, text) to service_role;
revoke execute on function public.fn_upsert_conversa_de_canal(uuid, uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.fn_upsert_conversa_de_canal(uuid, uuid, uuid, text) to service_role;
```

Confira antes se `contacts` tem as colunas `consent`, `tags`, `source_metadata`, `display_name` com esses tipos (são as que `fn_upsert_wa_contact` usa, `baseline.sql:5109`) e se `fn_set_updated_at` existe para um trigger de `updated_at` (padrão: `trg_platform_meta_app_updated_at`); se existir, crie o trigger equivalente para `contact_channel_identities`.

- [ ] **Step 4: Espelhar no `baseline.sql`**

1. No bloco único de constraints (procure `add constraint channel_sessions_provider_check`), acrescente as quatro colunas `ig_*` ao `alter table ... add column if not exists` imediatamente acima e o `'meta_instagram'` nas duas constraints, exatamente como na migration. Não crie outro bloco de constraint.
2. No fim do arquivo, um bloco `-- ---- canal Instagram (migration 0277) ----` com todo o resto da migration (índice, `conversations_channel_check`, colunas de `platform_meta_app`, tabela, RLS, RPCs, revokes). Tudo já é idempotente.

- [ ] **Step 5: MANIFEST**

Acrescente na tabela "Applied": `| 0277 | instagram_canal | Canal Instagram: provider meta_instagram, contact_channel_identities, conversa channel instagram, credencial do app do Instagram. |`

- [ ] **Step 6: Rodar os invariantes**

Run: `pnpm test:db`
Expected: PASS, incluindo `instagram-canal`, `baseline-constraint-reconstruida`, `hardening-definer-varredura` e `manifest-x-migrations`.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260925090000_0277_instagram_canal.sql supabase/baseline.sql supabase/migrations/MANIFEST.md tests/invariants/instagram-canal.test.ts
git commit -m "feat(canais): schema do canal Instagram (identidade por canal, provider, conversa)"
```

---

### Task 2: Registrar o provider `meta_instagram`

**Files:**
- Modify: `lib/channels/types.ts:12`, `lib/channels/capabilities.ts`, `lib/channels/index.ts`, `lib/channels/session-ref.ts`, `lib/channels/templates-fonte.ts`, `scripts/lint-channels.pattern.ts`
- Create: `lib/channels/adapters/instagram.ts`
- Test: `tests/unit/canal-instagram-registro.test.ts`

**Interfaces:**
- Produces: `CHANNEL_PROVIDER_INSTAGRAM: ChannelProvider = "meta_instagram"`; `instagramAdapter: ChannelAdapter` com `codes.notConfigured = "instagram_nao_configurado"`, `codes.sendFailed = "instagram_envio_indisponivel"`; `ChannelSessionRef` ganha `{ provider: "meta_instagram"; ig_account_id: string }`.

- [ ] **Step 1: Teste (falha)**

```ts
// tests/unit/canal-instagram-registro.test.ts
import { describe, expect, it } from "vitest";
import { capabilitiesOf, getAdapter, resolveSessionRef, transportaMensagem } from "@/lib/channels";
import { nomeiaProvider } from "../../scripts/lint-channels.pattern";

describe("provider do Instagram registrado", () => {
  it("tem capacidades, adapter e ref", () => {
    expect(transportaMensagem("meta_instagram")).toBe(true);
    const caps = capabilitiesOf("meta_instagram");
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.freeformOutsideWindow).toBe(false);
    expect(caps.banRisk).toBe(false);
    expect(caps.groups).toBe("none");
    expect(getAdapter("meta_instagram").provider).toBe("meta_instagram");
    expect(resolveSessionRef({ provider: "meta_instagram", ig_account_id: "178414" })).toBe("178414");
  });

  it("etapa 1 não envia: o adapter recusa com código próprio", async () => {
    const a = getAdapter("meta_instagram");
    await expect(
      a.send({ organizationId: "o", sessionRef: "s", to: "igsid", kind: "text", body: "oi" }),
    ).rejects.toThrow("instagram_envio_indisponivel");
  });

  it("a fronteira do nome enxerga o provider novo", () => {
    expect(nomeiaProvider("provider: 'meta_instagram'")).toBe(true);
    expect(nomeiaProvider("https://graph.instagram.com/me")).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/canal-instagram-registro.test.ts`
Expected: FAIL (tipo não aceita `meta_instagram`).

- [ ] **Step 3: Implementar**

`lib/channels/types.ts`:
```ts
export type ChannelProvider = "waha" | "meta_cloud" | "zernio" | "wacalls" | "meta_instagram";
```

`lib/channels/capabilities.ts`, nova linha em `CHANNEL_CAPABILITIES`, constante e lista:
```ts
  meta_instagram: {
    freeformOutsideWindow: false,
    requiresTemplates: false,
    canManageTemplates: false,
    banRisk: false,
    minIntervalMs: 1000,
    voiceNote: "opus-only",
    groups: "none",
    costPerMessage: false,
  },
```
```ts
export const CHANNEL_PROVIDER_INSTAGRAM: ChannelProvider = "meta_instagram";
export const PROVIDERS_DE_MENSAGEM = ["waha", "meta_cloud", "zernio", "meta_instagram"] as const satisfies readonly ProviderDeMensagem[];
```

`lib/channels/adapters/instagram.ts`:
```ts
/**
 * Adapter do Instagram. Etapa 1 só RECEBE (webhook → lib/channels/instagram/ingest.ts):
 * envio chega na etapa 2 (spec §5.5). Recusar com código próprio, e não com o genérico,
 * deixa a tela explicar "responder pelo Instagram ainda não está disponível".
 */
import type { ChannelAdapter } from "../types";

export const instagramAdapter: ChannelAdapter = {
  provider: "meta_instagram",
  resolveRecipient: () => null,
  isConfigured: () => false,
  async send() {
    throw new Error("instagram_envio_indisponivel");
  },
  codes: {
    notConfigured: "instagram_nao_configurado",
    sendFailed: "instagram_envio_indisponivel",
    unknownError: "instagram_erro_desconhecido",
  },
};
```

`lib/channels/index.ts`: `import { instagramAdapter } from "./adapters/instagram";` e `meta_instagram: instagramAdapter,` em `ADAPTERS`.

`lib/channels/session-ref.ts`:
```ts
export type ChannelSessionRef =
  | { provider: "waha"; waha_session_name: string }
  | { provider: "meta_cloud"; meta_phone_number_id: string }
  | { provider: "zernio"; zernio_account_id: string }
  | { provider: "meta_instagram"; ig_account_id: string };

export const CHANNEL_SESSION_REF_COLUMNS =
  "provider, waha_session_name, meta_phone_number_id, zernio_account_id, ig_account_id";
```
e no `switch`: `case "meta_instagram": return session.ig_account_id;`

`lib/channels/templates-fonte.ts`: `meta_instagram: null,` em `FONTE`.

`scripts/lint-channels.pattern.ts`:
```ts
const SEPARADO = /(?<![a-zA-Z0-9])(waha|meta_cloud|meta_instagram|zernio|graph\.facebook\.com|graph\.instagram\.com)(?![a-zA-Z0-9])/i;
```

Depois rode `pnpm typecheck`: o compilador aponta todo `Record<ProviderDeMensagem, …>` e todo `switch` exaustivo que falta. Resolva cada um com o valor "sem suporte" do próprio arquivo (o padrão é `null` ou `false`), nunca copiando o valor do `meta_cloud`.

- [ ] **Step 4: Rodar**

Run: `npx vitest run tests/unit/canal-instagram-registro.test.ts tests/unit/channel-capability-matrix.test.ts tests/unit/lint-channels-fronteira.test.ts tests/unit/vazamento-nome-de-provider.test.ts && pnpm typecheck && pnpm lint:channels`
Expected: PASS. Se `channel-capability-matrix` exigir uma família de restrição, declare a do Instagram como restrição **imposta pela plataforma** (janela) no formato que o teste pede; não desligue a asserção.

- [ ] **Step 5: Commit**

```bash
git add lib/channels scripts/lint-channels.pattern.ts tests/unit/canal-instagram-registro.test.ts
git commit -m "feat(canais): registra o provider do Instagram (recebe; envio na etapa 2)"
```

---

### Task 3: Credencial do app do Instagram (banco + tela do admin)

**Files:**
- Create: `lib/channels/instagram/app.ts`
- Modify: `app/admin/(protected)/meta/page.tsx`, `app/admin/(protected)/meta/_form.tsx`, a rota que o `_form.tsx` chama para salvar (siga o `fetch`/action dele), `.env.example`, `lib/env.ts`
- Test: `tests/unit/instagram-app-credencial.test.ts`

**Interfaces:**
- Produces: `appDoInstagram(): Promise<{ appId: string | null; appSecret: string | null }>`, `instagramPodeConectar(app): boolean` (os dois preenchidos), `invalidarAppDoInstagram(): void`.
- Consumes: `decryptWebhookSecret(admin, cifrado)` e `encryptWebhookSecret` de `lib/webhooks/secrets.ts`; `createAdminClient()`.

- [ ] **Step 1: Teste (falha)**

```ts
// tests/unit/instagram-app-credencial.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ig_app_id: "123", ig_app_secret_encrypted: "cifrado" }, error: null }) }) }) }),
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => "segredo" }));

const { appDoInstagram, instagramPodeConectar, invalidarAppDoInstagram } = await import("@/lib/channels/instagram/app");

describe("credencial do app do Instagram", () => {
  it("lê do banco e decifra o segredo", async () => {
    invalidarAppDoInstagram();
    const app = await appDoInstagram();
    expect(app).toEqual({ appId: "123", appSecret: "segredo" });
    expect(instagramPodeConectar(app)).toBe(true);
  });
  it("sem segredo não conecta", () => {
    expect(instagramPodeConectar({ appId: "123", appSecret: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run tests/unit/instagram-app-credencial.test.ts` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar `lib/channels/instagram/app.ts`**

```ts
/**
 * O app do Instagram DESTA instalação (Instagram App ID + App Secret do produto
 * "Instagram" no app da Meta). Mesmo desenho de `../meta/app.ts`: banco primeiro
 * (`platform_meta_app`, cifrado), `.env` como piso de rollback, memo curto.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { logger } from "@/lib/logger";

export interface AppDoInstagram {
  appId: string | null;
  appSecret: string | null;
}

const TTL_MS = 60_000;
let memo: { valor: AppDoInstagram; expiraEm: number } | null = null;

const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function invalidarAppDoInstagram(): void {
  memo = null;
}

export function instagramPodeConectar(app: AppDoInstagram): boolean {
  return Boolean(app.appId && app.appSecret);
}

export async function appDoInstagram(): Promise<AppDoInstagram> {
  if (memo && memo.expiraEm > Date.now()) return memo.valor;
  let valor: AppDoInstagram = {
    appId: texto(process.env.INSTAGRAM_APP_ID),
    appSecret: texto(process.env.INSTAGRAM_APP_SECRET),
  };
  try {
    const admin = createAdminClient();
    const { data } = await admin
      .from("platform_meta_app")
      .select("ig_app_id, ig_app_secret_encrypted")
      .eq("id", 1)
      .maybeSingle();
    const linha = data as { ig_app_id: string | null; ig_app_secret_encrypted: string | null } | null;
    const appId = texto(linha?.ig_app_id);
    const cifrado = texto(linha?.ig_app_secret_encrypted);
    if (appId && cifrado) {
      const appSecret = texto(await decryptWebhookSecret(admin, cifrado));
      if (appSecret) valor = { appId, appSecret };
    }
  } catch (err) {
    logger.warn("[instagram.app] leitura do banco falhou; vale o .env", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  memo = { valor, expiraEm: Date.now() + TTL_MS };
  return valor;
}
```

- [ ] **Step 4: Tela do admin**

Em `app/admin/(protected)/meta/_form.tsx`, acrescente uma seção "Instagram" com dois campos: **Instagram App ID** (texto) e **Instagram App Secret** (senha, nunca reexibido; mostra só "cadastrado em …"). Siga exatamente como o formulário atual salva o App Secret do WhatsApp (mesma rota, mesma cifra `encryptWebhookSecret`, mesmo audit). Depois de salvar, chame `invalidarAppDoInstagram()` no servidor. Texto de ajuda: "Painel da Meta › seu app › Instagram › Configuração da API com login do Instagram". Adicione `INSTAGRAM_APP_ID=` e `INSTAGRAM_APP_SECRET=` comentados como opcionais no `.env.example` e como `z.string().optional()` em `lib/env.ts`.

- [ ] **Step 5: Rodar**

Run: `npx vitest run tests/unit/instagram-app-credencial.test.ts tests/unit/env-example-sync.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/channels/instagram/app.ts "app/admin/(protected)/meta" .env.example lib/env.ts tests/unit/instagram-app-credencial.test.ts lib/i18n/dicionario.ts
git commit -m "feat(canais): credencial do app do Instagram na tela do admin"
```

---

### Task 4: Parse do webhook do Instagram (função pura)

**Files:**
- Create: `lib/channels/instagram/webhook.ts`
- Test: `lib/channels/instagram/webhook.test.ts`

**Interfaces:**
- Produces:
```ts
export interface EventoDoInstagram {
  igAccountId: string;      // entry.id: a conta conectada
  remetente: string;        // sender.id
  destinatario: string;     // recipient.id
  externalId: string;       // message.mid
  eco: boolean;             // message.is_echo: a própria conta enviou
  texto: string | null;
  anexos: { tipo: "image" | "video" | "audio" | "file"; url: string }[];
  enviadaEm: Date;          // timestamp em ms
}
export function parseWebhookDoInstagram(corpo: unknown): EventoDoInstagram[];
```

- [ ] **Step 1: Teste (falha)**

```ts
// lib/channels/instagram/webhook.test.ts
import { describe, expect, it } from "vitest";
import { parseWebhookDoInstagram } from "./webhook";

const base = (messaging: unknown[]) => ({ object: "instagram", entry: [{ id: "17841400000000001", time: 1727170000000, messaging }] });

describe("parse do webhook do Instagram", () => {
  it("texto recebido", () => {
    const [e] = parseWebhookDoInstagram(base([{ sender: { id: "IGSID9" }, recipient: { id: "17841400000000001" }, timestamp: 1727170000000, message: { mid: "m1", text: "Oi" } }]));
    expect(e).toMatchObject({ igAccountId: "17841400000000001", remetente: "IGSID9", externalId: "m1", eco: false, texto: "Oi", anexos: [] });
    expect(e.enviadaEm.getTime()).toBe(1727170000000);
  });

  it("imagem sem texto", () => {
    const [e] = parseWebhookDoInstagram(base([{ sender: { id: "IGSID9" }, recipient: { id: "17841400000000001" }, timestamp: 1, message: { mid: "m2", attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }] } }]));
    expect(e.texto).toBeNull();
    expect(e.anexos).toEqual([{ tipo: "image", url: "https://cdn/x.jpg" }]);
  });

  it("eco da própria conta", () => {
    const [e] = parseWebhookDoInstagram(base([{ sender: { id: "17841400000000001" }, recipient: { id: "IGSID9" }, timestamp: 1, message: { mid: "m3", text: "Olá!", is_echo: true } }]));
    expect(e.eco).toBe(true);
  });

  it("reação, mensagem apagada, leitura e objeto de outro produto são ignorados", () => {
    expect(parseWebhookDoInstagram(base([{ sender: { id: "a" }, recipient: { id: "b" }, timestamp: 1, reaction: { mid: "m1", action: "react" } }]))).toEqual([]);
    expect(parseWebhookDoInstagram(base([{ sender: { id: "a" }, recipient: { id: "b" }, timestamp: 1, message: { mid: "m4", is_deleted: true } }]))).toEqual([]);
    expect(parseWebhookDoInstagram(base([{ sender: { id: "a" }, recipient: { id: "b" }, timestamp: 1, read: { mid: "m1" } }]))).toEqual([]);
    expect(parseWebhookDoInstagram({ object: "page", entry: [] })).toEqual([]);
    expect(parseWebhookDoInstagram("lixo")).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run lib/channels/instagram/webhook.test.ts` → FAIL.

- [ ] **Step 3: Implementar**

```ts
// lib/channels/instagram/webhook.ts
/**
 * Payload do webhook do Instagram (object "instagram", entry[].messaging[]).
 * Função pura: nada de banco. Reação, leitura, apagada e objeto de outro produto
 * viram lista vazia; a rota responde 200 do mesmo jeito (a Meta não deve reenviar).
 */
import { z } from "zod";

const anexoSchema = z.object({ type: z.string(), payload: z.object({ url: z.string().url() }).partial().optional() }).passthrough();
const itemSchema = z.object({
  sender: z.object({ id: z.string() }),
  recipient: z.object({ id: z.string() }),
  timestamp: z.number(),
  message: z.object({
    mid: z.string(),
    text: z.string().optional(),
    is_echo: z.boolean().optional(),
    is_deleted: z.boolean().optional(),
    attachments: z.array(anexoSchema).optional(),
  }).passthrough().optional(),
}).passthrough();
const corpoSchema = z.object({
  object: z.literal("instagram"),
  entry: z.array(z.object({ id: z.string(), messaging: z.array(z.unknown()).optional() }).passthrough()),
});

export interface EventoDoInstagram {
  igAccountId: string;
  remetente: string;
  destinatario: string;
  externalId: string;
  eco: boolean;
  texto: string | null;
  anexos: { tipo: "image" | "video" | "audio" | "file"; url: string }[];
  enviadaEm: Date;
}

const TIPOS = new Set(["image", "video", "audio", "file"]);

export function parseWebhookDoInstagram(corpo: unknown): EventoDoInstagram[] {
  const lido = corpoSchema.safeParse(corpo);
  if (!lido.success) return [];
  const eventos: EventoDoInstagram[] = [];
  for (const entrada of lido.data.entry) {
    for (const bruto of entrada.messaging ?? []) {
      const item = itemSchema.safeParse(bruto);
      if (!item.success || !item.data.message || item.data.message.is_deleted) continue;
      const m = item.data.message;
      const anexos = (m.attachments ?? [])
        .filter((a) => TIPOS.has(a.type) && a.payload?.url)
        .map((a) => ({ tipo: a.type as EventoDoInstagram["anexos"][number]["tipo"], url: a.payload!.url! }));
      const texto = m.text?.trim() ? m.text : null;
      if (!texto && anexos.length === 0) continue;
      eventos.push({
        igAccountId: entrada.id,
        remetente: item.data.sender.id,
        destinatario: item.data.recipient.id,
        externalId: m.mid,
        eco: m.is_echo === true,
        texto,
        anexos,
        enviadaEm: new Date(item.data.timestamp),
      });
    }
  }
  return eventos;
}
```

- [ ] **Step 4: Rodar** — mesmo comando → PASS.
- [ ] **Step 5: Commit** — `git add lib/channels/instagram/webhook.ts lib/channels/instagram/webhook.test.ts && git commit -m "feat(canais): lê o webhook do Instagram"`

---

### Task 5: Ingestão (contato, conversa, mensagem, card)

**Files:**
- Create: `lib/channels/instagram/graph.ts`, `lib/channels/instagram/ingest.ts`
- Test: `lib/channels/instagram/ingest.test.ts`

**Interfaces:**
- Consumes: `EventoDoInstagram` (Task 4); RPCs da Task 1; `marcarConversaComMensagem` (`lib/channels/marcar-conversa.ts`), `aplicarEfeitosPosEntrada` (`lib/channels/pos-entrada.ts`); `decryptWebhookSecret`.
- Produces:
```ts
export type ResultadoDaIngestao =
  | { status: "ingerida"; messageId: string; conversationId: string; contatoNovo: boolean }
  | { status: "duplicada" } | { status: "sem_sessao" } | { status: "falhou"; motivo: string };
export async function ingerirDoInstagram(admin: SupabaseClient, e: EventoDoInstagram,
  sessao: { id: string; organizationId: string; igAccountId: string; tokenCifrado: string | null; origemPadrao: { campo: string; valor: string } | null }
): Promise<ResultadoDaIngestao>;
// graph.ts
export async function perfilDoRemetente(token: string, igsid: string): Promise<{ nome: string | null; handle: string | null; foto: string | null }>;
```

- [ ] **Step 1: Teste (falha)** — com um `admin` falso que registra chamadas:

```ts
// lib/channels/instagram/ingest.test.ts
import { describe, expect, it, vi } from "vitest";
import type { EventoDoInstagram } from "./webhook";

vi.mock("./graph", () => ({ perfilDoRemetente: vi.fn(async () => ({ nome: "Maria", handle: "maria", foto: null })) }));
vi.mock("../marcar-conversa", () => ({ marcarConversaComMensagem: vi.fn(async () => undefined) }));
vi.mock("../pos-entrada", () => ({ aplicarEfeitosPosEntrada: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => "TOKEN" }));

const { ingerirDoInstagram } = await import("./ingest");
const { aplicarEfeitosPosEntrada } = await import("../pos-entrada");

function adminFalso(opts: { insertErro?: { code: string; message: string } | null; contatoNovo?: boolean }) {
  const chamadas: Record<string, unknown[]> = { rpc: [], insert: [], update: [] };
  const admin = {
    rpc: vi.fn(async (nome: string, args: unknown) => {
      chamadas.rpc.push([nome, args]);
      if (nome === "fn_upsert_contato_por_identidade") return { data: [{ contact_id: "C1", criado: opts.contatoNovo ?? true }], error: null };
      if (nome === "fn_upsert_conversa_de_canal") return { data: "CV1", error: null };
      return { data: null, error: null };
    }),
    from: vi.fn((tabela: string) => ({
      insert: (linha: unknown) => { chamadas.insert.push([tabela, linha]); return { select: () => ({ maybeSingle: async () => opts.insertErro ? { data: null, error: opts.insertErro } : { data: { id: "M1" }, error: null } }) }; },
      update: (linha: unknown) => { chamadas.update.push([tabela, linha]); return { eq: () => ({ eq: async () => ({ error: null }) }) }; },
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { custom_fields: {} }, error: null }) }) }) }),
    })),
  };
  return { admin, chamadas };
}

const sessao = { id: "S1", organizationId: "ORG", igAccountId: "IGACC", tokenCifrado: "x", origemPadrao: { campo: "origem", valor: "Instagram Dr. André" } };
const evento = (over: Partial<EventoDoInstagram> = {}): EventoDoInstagram => ({ igAccountId: "IGACC", remetente: "IGSID9", destinatario: "IGACC", externalId: "m1", eco: false, texto: "Oi", anexos: [], enviadaEm: new Date(1), ...over });

describe("ingestão do Instagram", () => {
  it("mensagem nova grava inbound com canal instagram e aplica a origem padrão no contato novo", async () => {
    const { admin, chamadas } = adminFalso({});
    const r = await ingerirDoInstagram(admin as never, evento(), sessao);
    expect(r).toMatchObject({ status: "ingerida", contatoNovo: true });
    expect(chamadas.rpc).toContainEqual(["fn_upsert_conversa_de_canal", { p_org: "ORG", p_contact: "C1", p_session: "S1", p_canal: "instagram" }]);
    const [, msg] = chamadas.insert.find(([t]) => t === "messages") as [string, Record<string, unknown>];
    expect(msg).toMatchObject({ organization_id: "ORG", direction: "inbound", external_id: "m1", body: "Oi" });
    expect(chamadas.update).toContainEqual(["contacts", { custom_fields: { origem: "Instagram Dr. André" } }]);
    expect(aplicarEfeitosPosEntrada).toHaveBeenCalled();
  });

  it("entrega repetida (23505) é duplicada, sem efeitos", async () => {
    vi.mocked(aplicarEfeitosPosEntrada).mockClear();
    const { admin } = adminFalso({ insertErro: { code: "23505", message: "dup" } });
    expect(await ingerirDoInstagram(admin as never, evento(), sessao)).toEqual({ status: "duplicada" });
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });

  it("eco entra como outbound, identifica o contato pelo destinatário e não dispara efeitos de entrada", async () => {
    vi.mocked(aplicarEfeitosPosEntrada).mockClear();
    const { admin, chamadas } = adminFalso({ contatoNovo: false });
    await ingerirDoInstagram(admin as never, evento({ eco: true, remetente: "IGACC", destinatario: "IGSID9" }), sessao);
    const [, args] = chamadas.rpc.find(([n]) => n === "fn_upsert_contato_por_identidade") as [string, Record<string, unknown>];
    expect(args.p_external_id).toBe("IGSID9");
    const [, msg] = chamadas.insert.find(([t]) => t === "messages") as [string, Record<string, unknown>];
    expect(msg.direction).toBe("outbound");
    expect(aplicarEfeitosPosEntrada).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run lib/channels/instagram/ingest.test.ts` → FAIL.

- [ ] **Step 3: `graph.ts`**

```ts
// lib/channels/instagram/graph.ts
import { graphVersion } from "@/lib/graph-version";
import { logger } from "@/lib/logger";

export const BASE_DO_INSTAGRAM = "https://graph.instagram.com";

export async function perfilDoRemetente(token: string, igsid: string): Promise<{ nome: string | null; handle: string | null; foto: string | null }> {
  const url = `${BASE_DO_INSTAGRAM}/${graphVersion()}/${encodeURIComponent(igsid)}?fields=name,username,profile_pic`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      logger.info("[instagram.graph] perfil indisponível", { status: res.status });
      return { nome: null, handle: null, foto: null };
    }
    const j = (await res.json()) as { name?: string; username?: string; profile_pic?: string };
    return { nome: j.name ?? null, handle: j.username ?? null, foto: j.profile_pic ?? null };
  } catch (err) {
    logger.info("[instagram.graph] perfil falhou", { error: err instanceof Error ? err.message : String(err) });
    return { nome: null, handle: null, foto: null };
  }
}
```

- [ ] **Step 4: `ingest.ts`**

```ts
// lib/channels/instagram/ingest.ts
/**
 * Um evento do webhook do Instagram vira contato + conversa + mensagem, pelos mesmos
 * passos do WhatsApp oficial (`../meta/ingest.ts`): marcar a conversa e aplicar os
 * efeitos pós-entrada (opt-out, lead/card, despacho). Eco (a conta respondeu pelo app)
 * entra como outbound e NÃO dispara efeito de entrada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import { perfilDoRemetente } from "./graph";
import type { EventoDoInstagram } from "./webhook";

export type ResultadoDaIngestao =
  | { status: "ingerida"; messageId: string; conversationId: string; contatoNovo: boolean }
  | { status: "duplicada" }
  | { status: "sem_sessao" }
  | { status: "falhou"; motivo: string };

export interface SessaoDoInstagram {
  id: string;
  organizationId: string;
  igAccountId: string;
  tokenCifrado: string | null;
  origemPadrao: { campo: string; valor: string } | null;
}

function preview(e: EventoDoInstagram): string {
  if (e.texto) return e.texto.slice(0, 120);
  const tipo = e.anexos[0]?.tipo;
  return tipo === "image" ? "📷 Imagem" : tipo === "video" ? "🎬 Vídeo" : tipo === "audio" ? "🎵 Áudio" : "📎 Arquivo";
}

export async function ingerirDoInstagram(admin: SupabaseClient, e: EventoDoInstagram, sessao: SessaoDoInstagram): Promise<ResultadoDaIngestao> {
  const orgId = sessao.organizationId;
  const pessoa = e.eco ? e.destinatario : e.remetente;

  let perfil = { nome: null as string | null, handle: null as string | null, foto: null as string | null };
  if (!e.eco && sessao.tokenCifrado) {
    const token = await decryptWebhookSecret(admin, sessao.tokenCifrado);
    if (token) perfil = await perfilDoRemetente(token, pessoa);
  }

  const { data: linhasContato, error: erroContato } = await admin.rpc("fn_upsert_contato_por_identidade" as never, {
    p_org: orgId, p_canal: "instagram", p_external_id: pessoa,
    p_handle: perfil.handle, p_nome: perfil.nome, p_avatar: perfil.foto,
  } as never);
  const contato = (linhasContato as { contact_id: string; criado: boolean }[] | null)?.[0];
  if (erroContato || !contato) return { status: "falhou", motivo: `contato: ${erroContato?.message ?? "sem id"}` };

  if (contato.criado && sessao.origemPadrao) {
    await admin.from("contacts")
      .update({ custom_fields: { [sessao.origemPadrao.campo]: sessao.origemPadrao.valor } })
      .eq("id", contato.contact_id)
      .eq("organization_id", orgId);
  }

  const { data: conversationId, error: erroConversa } = await admin.rpc("fn_upsert_conversa_de_canal" as never, {
    p_org: orgId, p_contact: contato.contact_id, p_session: sessao.id, p_canal: "instagram",
  } as never);
  if (erroConversa || !conversationId) return { status: "falhou", motivo: `conversa: ${erroConversa?.message ?? "sem id"}` };

  const anexo = e.anexos[0] ?? null;
  const { data: inserida, error: erroInsert } = await admin.from("messages").insert({
    organization_id: orgId,
    conversation_id: conversationId as string,
    channel_session_id: sessao.id,
    contact_id: contato.contact_id,
    direction: e.eco ? "outbound" : "inbound",
    status: e.eco ? "sent" : "delivered",
    type: anexo ? anexo.tipo === "file" ? "document" : anexo.tipo : "text",
    body: e.texto,
    external_id: e.externalId,
    media_url: anexo?.url ?? null,
    sent_at: e.enviadaEm.toISOString(),
    metadata: { canal: "instagram", ...(e.eco ? { eco_do_app: true } : {}) },
  }).select("id").maybeSingle();
  if (erroInsert) {
    if (erroInsert.code === "23505") return { status: "duplicada" };
    return { status: "falhou", motivo: `mensagem: ${erroInsert.message}` };
  }
  const messageId = (inserida as { id: string } | null)?.id ?? "";

  await marcarConversaComMensagem(admin, {
    organizationId: orgId, conversationId: conversationId as string,
    direction: e.eco ? "outbound" : "inbound", preview: preview(e),
    at: e.enviadaEm.toISOString(), canal: "instagram",
  });

  if (!e.eco) {
    await aplicarEfeitosPosEntrada(admin, {
      organizationId: orgId, contactId: contato.contact_id, conversationId: conversationId as string,
      messageId: messageId || null, channelSessionId: sessao.id, texto: e.texto,
      nomeDoContato: perfil.nome ?? perfil.handle, origem: "instagram_webhook",
    });
  }
  return { status: "ingerida", messageId, conversationId: conversationId as string, contatoNovo: contato.criado };
}
```

Antes de fechar: confira em `supabase/baseline.sql` o CHECK de `messages.type` e `messages.status` (os valores `document`, `sent`, `delivered` precisam existir) e se `media_url` aceita URL http (no WhatsApp oficial ele guarda `meta-media:<id>` e um worker persiste no Storage via `media.persist_requested`). Se o worker de mídia só entende `meta-media:`, emita `media.persist_requested` como `ingestMetaInbound` faz e trate a URL do Instagram no worker (a URL do CDN do Instagram expira). Registre a decisão no cabeçalho do arquivo.

- [ ] **Step 5: Rodar** — `npx vitest run lib/channels/instagram/ingest.test.ts && pnpm typecheck` → PASS.
- [ ] **Step 6: Commit** — `git add lib/channels/instagram/graph.ts lib/channels/instagram/ingest.ts lib/channels/instagram/ingest.test.ts && git commit -m "feat(canais): grava contato, conversa e mensagem do Instagram"`

---

### Task 6: Rota do webhook

**Files:**
- Create: `app/api/v1/webhooks/instagram/route.ts`, `lib/channels/instagram/sessao.ts`
- Test: `tests/unit/webhook-instagram-rota.test.ts`

**Interfaces:**
- Consumes: `verifyMetaSignature(raw, header, secret)` e `verificationChallenge(params, token)` de `lib/channels/meta/webhook.ts`; `appDaMeta()` (verify token) de `lib/channels/meta/app.ts`; `appDoInstagram()`; `parseWebhookDoInstagram`; `ingerirDoInstagram`.
- Produces: `sessaoDoInstagramPorConta(admin, igAccountId): Promise<SessaoDoInstagram | null>` (a única consulta sem `organization_id`, justificada: o webhook é do app; o índice único global garante uma linha ativa).

- [ ] **Step 1: Teste (falha)** — mock de `appDoInstagram`, `sessaoDoInstagramPorConta`, `ingerirDoInstagram`, `logger`; assina o corpo com `createHmac("sha256", "SEG")`:

```ts
// tests/unit/webhook-instagram-rota.test.ts
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock("@/lib/logger", () => ({ logger }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/channels/instagram/app", () => ({ appDoInstagram: async () => ({ appId: "1", appSecret: "SEG" }) }));
vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: async () => ({ appSecret: "x", verifyToken: "VT" }) }));
const sessao = vi.fn();
vi.mock("@/lib/channels/instagram/sessao", () => ({ sessaoDoInstagramPorConta: sessao }));
const ingerir = vi.fn(async () => ({ status: "ingerida", messageId: "M", conversationId: "C", contatoNovo: true }));
vi.mock("@/lib/channels/instagram/ingest", () => ({ ingerirDoInstagram: ingerir }));

const { GET, POST } = await import("@/app/api/v1/webhooks/instagram/route");
const corpo = JSON.stringify({ object: "instagram", entry: [{ id: "IGACC", time: 1, messaging: [{ sender: { id: "P" }, recipient: { id: "IGACC" }, timestamp: 1, message: { mid: "m1", text: "Oi" } }] }] });
const assinar = (s: string) => `sha256=${createHmac("sha256", "SEG").update(s).digest("hex")}`;
const post = (s: string, sig: string | null) => new NextRequest("http://x/api/v1/webhooks/instagram", { method: "POST", body: s, headers: sig ? { "x-hub-signature-256": sig } : {} });

beforeEach(() => { vi.clearAllMocks(); });

describe("webhook do Instagram", () => {
  it("GET responde o desafio com o verify token da instalação", async () => {
    const r = await GET(new NextRequest("http://x/api/v1/webhooks/instagram?hub.mode=subscribe&hub.verify_token=VT&hub.challenge=42"));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("42");
  });
  it("assinatura inválida: 401 e log", async () => {
    const r = await POST(post(corpo, "sha256=00"));
    expect(r.status).toBe(401);
    expect(logger.warn).toHaveBeenCalled();
    expect(ingerir).not.toHaveBeenCalled();
  });
  it("conta não conectada: 200, nada gravado, log", async () => {
    sessao.mockResolvedValue(null);
    const r = await POST(post(corpo, assinar(corpo)));
    expect(r.status).toBe(200);
    expect(ingerir).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });
  it("conta conectada: ingere com a sessão resolvida", async () => {
    sessao.mockResolvedValue({ id: "S", organizationId: "ORG", igAccountId: "IGACC", tokenCifrado: null, origemPadrao: null });
    const r = await POST(post(corpo, assinar(corpo)));
    expect(r.status).toBe(200);
    expect(ingerir).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: `sessao.ts`**

```ts
// lib/channels/instagram/sessao.ts
/**
 * Resolve a conexão pela conta do Instagram (entry.id do webhook do APP).
 * É a raiz do roteamento: ainda não se sabe a organização, e o índice único
 * `uniq_channel_sessions_ig_account_ativa` garante uma linha ativa por conta.
 * Toda consulta DEPOIS desta usa o organization_id devolvido aqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessaoDoInstagram } from "./ingest";

export async function sessaoDoInstagramPorConta(admin: SupabaseClient, igAccountId: string): Promise<SessaoDoInstagram | null> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, organization_id, ig_account_id, ig_token_encrypted, metadata")
    .eq("provider", "meta_instagram")
    .eq("ig_account_id", igAccountId)
    .is("archived_at", null)
    .maybeSingle();
  if (error || !data) return null;
  const linha = data as { id: string; organization_id: string; ig_account_id: string; ig_token_encrypted: string | null; metadata: Record<string, unknown> | null };
  const origem = linha.metadata?.origem_padrao as { campo?: string; valor?: string } | undefined;
  return {
    id: linha.id,
    organizationId: linha.organization_id,
    igAccountId: linha.ig_account_id,
    tokenCifrado: linha.ig_token_encrypted,
    origemPadrao: origem?.campo && origem?.valor ? { campo: origem.campo, valor: origem.valor } : null,
  };
}
```

Se `tests/unit/canal-consulta-por-organizacao.test.ts` reprovar esta consulta, acrescente-a à allowlist daquele teste com o motivo do cabeçalho acima (o webhook do app não carrega organização; a unicidade é do índice). Não remova o filtro de `archived_at`.

- [ ] **Step 4: Rota**

```ts
// app/api/v1/webhooks/instagram/route.ts
/**
 * Webhook do produto Instagram do app da Meta. Um callback para todas as contas
 * conectadas na instalação; roteia por entry.id. Assinatura com o Instagram App
 * Secret. Recusa COM log: a rota do WhatsApp oficial recusava em silêncio, e isso
 * custou uma manhã de diagnóstico em 24/09/2026.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { appDaMeta } from "@/lib/channels/meta/app";
import { verificationChallenge, verifyMetaSignature } from "@/lib/channels/meta/webhook";
import { appDoInstagram } from "@/lib/channels/instagram/app";
import { parseWebhookDoInstagram } from "@/lib/channels/instagram/webhook";
import { sessaoDoInstagramPorConta } from "@/lib/channels/instagram/sessao";
import { ingerirDoInstagram } from "@/lib/channels/instagram/ingest";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const { verifyToken } = await appDaMeta();
  const desafio = verificationChallenge(req.nextUrl.searchParams, verifyToken ?? "");
  return desafio === null ? new NextResponse("forbidden", { status: 403 }) : new NextResponse(desafio, { status: 200 });
}

export async function POST(req: NextRequest): Promise<Response> {
  const raw = await req.text();
  const { appSecret } = await appDoInstagram();
  if (!appSecret || !verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), appSecret)) {
    logger.warn("[instagram.webhook] assinatura recusada", { temSegredo: Boolean(appSecret), temCabecalho: req.headers.has("x-hub-signature-256") });
    return NextResponse.json({ error: { code: "unauthorized", message: "invalid_signature" } }, { status: 401 });
  }
  let corpo: unknown;
  try { corpo = JSON.parse(raw); } catch { return NextResponse.json({ received: 0 }); }

  const admin = createAdminClient();
  let recebidas = 0;
  for (const evento of parseWebhookDoInstagram(corpo)) {
    const sessao = await sessaoDoInstagramPorConta(admin, evento.igAccountId);
    if (!sessao) {
      logger.info("[instagram.webhook] conta sem conexão ativa", { conta: evento.igAccountId });
      continue;
    }
    const r = await ingerirDoInstagram(admin, evento, sessao);
    if (r.status === "falhou") logger.error("[instagram.webhook] ingestão falhou", { motivo: r.motivo, organizationId: sessao.organizationId });
    if (r.status === "ingerida") recebidas += 1;
  }
  return NextResponse.json({ received: recebidas });
}
```

Confira se o middleware/proxy do app libera `/api/v1/webhooks/*` sem sessão (o WhatsApp oficial usa `/api/v1/webhooks/meta/[token]`; siga a mesma regra) e se há rate limit por rota pública a registrar (padrão dos vizinhos).

- [ ] **Step 5: Rodar** — `npx vitest run tests/unit/webhook-instagram-rota.test.ts tests/unit/canal-consulta-por-organizacao.test.ts && pnpm typecheck && pnpm lint:channels` → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(canais): rota do webhook do Instagram, com log de recusa"`

---

### Task 7: Conectar pelo login do Instagram

**Files:**
- Create: `lib/channels/instagram/oauth.ts`, `app/api/v1/channels/instagram/connect/route.ts`, `app/api/v1/channels/instagram/callback/route.ts`
- Modify: `lib/audit/actions.ts` (acrescentar no fim: `"channel.instagram_connected"`, `"channel.instagram_disconnected"`, `"channel.instagram_token_refreshed"`)
- Test: `lib/channels/instagram/oauth.test.ts`

**Interfaces:**
- Produces:
```ts
export function urlDeLogin(appId: string, redirectUri: string, state: string): string;
export function assinarState(dados: { org: string; user: string; nonce: string; exp: number }, segredo: string): string;
export function lerState(state: string, segredo: string, agora: number): { org: string; user: string } | null;
export async function trocarCodePorTokenLongo(app: { appId: string; appSecret: string }, code: string, redirectUri: string): Promise<{ token: string; expiraEm: Date; userId: string }>;
export async function lerConta(token: string): Promise<{ igAccountId: string; username: string }>;
export async function assinarWebhookDaConta(token: string): Promise<void>;
```

- [ ] **Step 1: Teste (falha)** — `state` com HMAC e expiração; URL de login correta:

```ts
// lib/channels/instagram/oauth.test.ts
import { describe, expect, it } from "vitest";
import { assinarState, lerState, urlDeLogin } from "./oauth";

describe("login do Instagram", () => {
  it("URL de login tem os escopos e o state", () => {
    const u = new URL(urlDeLogin("APPID", "https://crm.x/api/v1/channels/instagram/callback", "ST"));
    expect(u.origin + u.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(u.searchParams.get("client_id")).toBe("APPID");
    expect(u.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_manage_messages");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe("ST");
  });
  it("state assinado volta; adulterado ou vencido não", () => {
    const s = assinarState({ org: "O", user: "U", nonce: "n", exp: 1000 }, "SEG");
    expect(lerState(s, "SEG", 500)).toEqual({ org: "O", user: "U" });
    expect(lerState(s, "OUTRO", 500)).toBeNull();
    expect(lerState(s, "SEG", 2000)).toBeNull();
    expect(lerState(s.slice(0, -2) + "xx", "SEG", 500)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: `oauth.ts`**

```ts
// lib/channels/instagram/oauth.ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { graphVersion } from "@/lib/graph-version";
import { BASE_DO_INSTAGRAM } from "./graph";

const ESCOPOS = "instagram_business_basic,instagram_business_manage_messages";

export function urlDeLogin(appId: string, redirectUri: string, state: string): string {
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.searchParams.set("client_id", appId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", ESCOPOS);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  return u.toString();
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const hmac = (s: string, k: string) => createHmac("sha256", k).update(s).digest("base64url");

export function assinarState(dados: { org: string; user: string; nonce: string; exp: number }, segredo: string): string {
  const corpo = b64(JSON.stringify(dados));
  return `${corpo}.${hmac(corpo, segredo)}`;
}

export function lerState(state: string, segredo: string, agora: number): { org: string; user: string } | null {
  const [corpo, assinatura] = state.split(".");
  if (!corpo || !assinatura) return null;
  const esperada = hmac(corpo, segredo);
  if (esperada.length !== assinatura.length || !timingSafeEqual(Buffer.from(esperada), Buffer.from(assinatura))) return null;
  try {
    const d = JSON.parse(Buffer.from(corpo, "base64url").toString()) as { org: string; user: string; exp: number };
    return d.exp > agora ? { org: d.org, user: d.user } : null;
  } catch { return null; }
}

export async function trocarCodePorTokenLongo(app: { appId: string; appSecret: string }, code: string, redirectUri: string) {
  const form = new URLSearchParams({ client_id: app.appId, client_secret: app.appSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code });
  const curto = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
  if (!curto.ok) throw new Error(`instagram_code_recusado_${curto.status}`);
  const c = (await curto.json()) as { access_token: string; user_id: string | number };
  const longo = await fetch(`${BASE_DO_INSTAGRAM}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(app.appSecret)}`, { headers: { Authorization: `Bearer ${c.access_token}` } });
  if (!longo.ok) throw new Error(`instagram_token_longo_recusado_${longo.status}`);
  const l = (await longo.json()) as { access_token: string; expires_in: number };
  return { token: l.access_token, expiraEm: new Date(Date.now() + l.expires_in * 1000), userId: String(c.user_id) };
}

export async function lerConta(token: string) {
  const r = await fetch(`${BASE_DO_INSTAGRAM}/${graphVersion()}/me?fields=user_id,username`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`instagram_conta_ilegivel_${r.status}`);
  const j = (await r.json()) as { user_id: string | number; username: string };
  return { igAccountId: String(j.user_id), username: j.username };
}

export async function assinarWebhookDaConta(token: string): Promise<void> {
  const r = await fetch(`${BASE_DO_INSTAGRAM}/${graphVersion()}/me/subscribed_apps?subscribed_fields=messages`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`instagram_assinatura_recusada_${r.status}`);
}
```

Antes de fechar, confira na documentação oficial ([Business Login for Instagram](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)) se a troca curta→longa aceita o token em cabeçalho ou exige `access_token` na query. Se exigir query, é chamada servidor→Meta (não é API key nossa em URL de log de terceiros), e o log estruturado nunca imprime a URL.

- [ ] **Step 4: Rotas**

`connect/route.ts` (GET): `requireRole("manager")`; `appDoInstagram()`; sem credencial → redirect para `/app/connections?instagram=sem_credencial`; senão `assinarState({ org: activeOrg.orgId, user: user.id, nonce: randomUUID(), exp: Date.now() + 10*60_000 }, appSecret)` e redirect para `urlDeLogin(appId, `${origem}/api/v1/channels/instagram/callback`, state)`. `origem` vem da URL pública configurada da instalação (mesmo helper que a rota do Google Agenda usa para montar o `redirect_uri`; procure `agenda/google` em `app/api/v1`).

`callback/route.ts` (GET): lê `code`, `state`, `error`. `error` → redirect `/app/connections?instagram=cancelado`. `lerState` nulo → `?instagram=link_vencido`. Confirma que o usuário logado é o do `state` e ainda é manager+ no org do `state` (`requireRole`), troca o token, `lerConta`, `assinarWebhookDaConta`, e grava com admin client:

```ts
const cifrado = await encryptWebhookSecret(admin, token);
await admin.from("channel_sessions").upsert({
  organization_id: dono.org, provider: "meta_instagram", status: "WORKING",
  ig_account_id: conta.igAccountId, ig_username: conta.username,
  ig_token_encrypted: cifrado, ig_token_expires_at: expiraEm.toISOString(),
  display_name: `@${conta.username}`, archived_at: null,
}, { onConflict: "ig_account_id" });
```

Se a conta já está ativa em OUTRA organização (índice único), responda `?instagram=conta_em_outra_organizacao` sem sobrescrever. Audita `channel.instagram_connected` (metadata: `username`, nunca o token). Redirect `/app/connections?instagram=conectado`.

Confira as colunas obrigatórias de `channel_sessions` (`webhook_path_token`, `engine`, etc.) no `baseline.sql` e preencha as NOT NULL com o valor neutro que o fluxo do canal oficial usa (`app/api/v1/channels/official/route.ts`).

- [ ] **Step 5: Rodar** — `npx vitest run lib/channels/instagram/oauth.test.ts tests/unit/audit-lista-do-painel-e-derivada.test.tsx && pnpm typecheck && pnpm lint:channels` → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(canais): conectar conta do Instagram pelo login da Meta"`

---

### Task 8: Renovar a chave (cron + aviso)

**Files:**
- Create: `app/api/v1/cron/instagram-token-refresh/route.ts`, `lib/channels/instagram/renovacao.ts`
- Modify: `docker/scheduler/entrypoint.sh`
- Test: `lib/channels/instagram/renovacao.test.ts`

**Interfaces:**
- Produces: `precisaRenovar(expiraEm: Date, agora: Date): boolean` (menos de 15 dias), `renovarToken(token): Promise<{ token: string; expiraEm: Date }>` (GET `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`, token no cabeçalho `Authorization`).

- [ ] **Step 1: Teste (falha)**

```ts
// lib/channels/instagram/renovacao.test.ts
import { describe, expect, it } from "vitest";
import { precisaRenovar } from "./renovacao";

const DIA = 86_400_000;
describe("renovação do token do Instagram", () => {
  it("renova com menos de 15 dias; não renova com mais", () => {
    const agora = new Date(0);
    expect(precisaRenovar(new Date(14 * DIA), agora)).toBe(true);
    expect(precisaRenovar(new Date(16 * DIA), agora)).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar** `renovacao.ts` com as duas funções e a rota do cron seguindo `app/api/v1/cron/agenda-google-refresh/route.ts` (mesma autenticação de cron, mesmo formato de resposta). Para cada sessão `meta_instagram` ativa com `ig_token_expires_at` a menos de 15 dias: decifra, renova, grava o novo token cifrado e a nova validade; audita `channel.instagram_token_refreshed` **só se renovou alguma** (`tests/unit/cron-audita-so-quando-ha-efeito.test.ts`). Falha de renovação: abre `agent_inbox_items` com kind `channel_session_offline` (já existe no CHECK), título "Instagram @conta precisa ser reconectado", e não repete o aviso se já há um aberto para a mesma sessão (siga o dedupe de `recover-stuck-messages`). Acrescente a chamada diária no `docker/scheduler/entrypoint.sh`, ao lado do `agenda-google-refresh`.

- [ ] **Step 4: Rodar** — `npx vitest run lib/channels/instagram/renovacao.test.ts tests/unit/cron-audita-so-quando-ha-efeito.test.ts && pnpm test:shell` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(canais): renova sozinho a chave do Instagram e avisa quando falha"`

---

### Task 9: Tela (Conexões e Inbox)

**Files:**
- Create: `components/connections/CanalInstagramClient.tsx`, `app/api/v1/channels/instagram/[id]/route.ts` (PATCH origem padrão, DELETE desconectar)
- Modify: `components/connections/ConnectionsClient.tsx` (ou `ConexoesShell.tsx`, onde os outros cartões entram), `components/inbox/ConversationListItem.tsx:127`, `components/inbox/ConversationHeader.tsx:75`, `components/inbox/ContactPickerDialog.tsx:82`, `lib/i18n/dicionario.ts`
- Test: `tests/unit/inbox-contato-sem-telefone.test.tsx`

**Interfaces:**
- Consumes: sessões `meta_instagram` do org (via rota de listagem existente de `channel_sessions` ou uma GET nova em `app/api/v1/channels/instagram/route.ts`, filtrada por `organization_id` da sessão).
- Produces: `rotuloDoCanal(conversa)`: texto "via @conta" montado a partir de `display_name` da sessão, sem nome de provider (a UI pergunta pela capacidade `groups === "none" && !requiresTemplates` só se precisar; prefira ler `conversations.channel`).

- [ ] **Step 1: Teste (falha)** — renderiza `ConversationListItem` com contato sem telefone e identidade `@maria`:

```tsx
// tests/unit/inbox-contato-sem-telefone.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationListItem } from "@/components/inbox/ConversationListItem";

describe("contato sem telefone no Inbox", () => {
  it("mostra o @ e o canal, nunca ??", () => {
    render(<ConversationListItem conversation={{ id: "c", channel: "instagram", contact: { display_name: null, phone_number: null, handle: "maria" }, session: { display_name: "@dr.andreluisc" }, last_message_preview: "Oi" } as never} />);
    expect(screen.queryByText("??")).toBeNull();
    expect(screen.getByText("@maria")).toBeTruthy();
    expect(screen.getByText(/via @dr\.andreluisc/)).toBeTruthy();
  });
});
```

Antes de escrever, abra `ConversationListItem.tsx` e ajuste os nomes de props do teste aos reais (o objeto de conversa já existe; acrescente `handle` ao contato pela identidade de canal na consulta do Inbox e `channel`/sessão onde faltar).

- [ ] **Step 2: Rodar e ver falhar.**

- [ ] **Step 3: Implementar**
  1. Inbox: quando o contato não tem telefone, o rótulo é `display_name` → `@handle` → "Contato do Instagram" (via `t()`), nunca `"??"`. Ícone do Instagram (Phosphor `InstagramLogo`) e "via @conta" quando `channel === "instagram"`. O `ContactPickerDialog` deixa de esconder contato sem telefone quando o destino não exige telefone.
  2. A consulta do Inbox (procure onde `ConversationListItem` recebe dados) traz `contact_channel_identities.handle` e `channel_sessions.display_name`.
  3. `CanalInstagramClient.tsx`: lista as contas (`@username`, status, "chave válida até dd/mm"), botão **Conectar Instagram** (link para `/api/v1/channels/instagram/connect`; desabilitado com o passo a passo quando `instagramPodeConectar` é falso), **Desconectar** (DELETE → `archived_at = now()`, audita `channel.instagram_disconnected`), e **Origem padrão**: dois selects (campo do funil padrão do tipo `select` + valor), salvando por PATCH em `channel_sessions.metadata.origem_padrao = { campo, valor }` (filtrado por `organization_id`). Mostra o resultado de `?instagram=` (conectado, cancelado, link_vencido, conta_em_outra_organizacao, sem_credencial) como aviso.
  4. Todas as frases novas com entrada `es` no dicionário.

- [ ] **Step 4: Rodar** — `npx vitest run tests/unit/inbox-contato-sem-telefone.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/vazamento-nome-de-provider.test.ts && pnpm typecheck && pnpm lint && pnpm lint:channels` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(inbox): conversas do Instagram no Inbox e cartão em Conexões"`

---

### Task 10: Prova pela tela, documentação e PR

**Files:**
- Create: `tests/e2e/instagram-receber.spec.ts`, `scripts/seed-e2e-instagram.ts`, `.changes/instagram-direct-receber.md`
- Modify: `.github/workflows/e2e.yml` (`SPECS_PARTE_2`), `docs/testing/user-journey-map.md`, `docs/architecture/` (mapa vivo), `docs/current-state.md`

- [ ] **Step 1: Seed** — `scripts/seed-e2e-instagram.ts` grava `platform_meta_app.ig_app_id`/`ig_app_secret_encrypted` (segredo `"segredo-e2e"`) e uma `channel_session` `meta_instagram` (`ig_account_id = "17841400000000001"`, `ig_username = "clinica_e2e"`, `metadata.origem_padrao = { campo: "origem", valor: "Instagram Dr. André" }`) no org do seed de credenciais, e o campo `origem` (select) no funil padrão. Só escreve em `localhost` (mesma guarda dos outros `seed-e2e-*`).

- [ ] **Step 2: Spec**

```ts
// tests/e2e/instagram-receber.spec.ts
/**
 * [P1] Direct do Instagram chega ao Inbox. O webhook é simulado com assinatura
 * real (HMAC do segredo do seed); o resto é o produto de verdade: contato, conversa,
 * card no funil com a Origem padrão, e a tela mostrando @ e "via @conta".
 */
import { createHmac } from "node:crypto";
import { test, expect } from "@playwright/test";
import { login } from "./helpers/auth";

test("um Direct novo aparece no Inbox com @, canal e origem", async ({ page, request }) => {
  const corpo = JSON.stringify({ object: "instagram", entry: [{ id: "17841400000000001", time: Date.now(), messaging: [{ sender: { id: `IGSID-${Date.now()}` }, recipient: { id: "17841400000000001" }, timestamp: Date.now(), message: { mid: `mid-${Date.now()}`, text: "Vim pelo Instagram do Dr. André" } }] }] });
  const assinatura = `sha256=${createHmac("sha256", "segredo-e2e").update(corpo).digest("hex")}`;
  const r = await request.post("/api/v1/webhooks/instagram", { data: corpo, headers: { "content-type": "application/json", "x-hub-signature-256": assinatura } });
  expect(r.status()).toBe(200);
  expect((await r.json()).received).toBe(1);

  const ruim = await request.post("/api/v1/webhooks/instagram", { data: corpo, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" } });
  expect(ruim.status()).toBe(401);

  await login(page, "manager");
  await page.goto("/app/inbox");
  const item = page.getByText("Vim pelo Instagram do Dr. André").first();
  await expect(item).toBeVisible();
  await expect(page.getByText(/via @clinica_e2e/).first()).toBeVisible();
  await expect(page.getByText("??")).toHaveCount(0);
  await page.screenshot({ path: "evidence/instagram-direct/01-inbox.png", fullPage: true });

  // O contato novo virou card em "Novo lead – interagir" e ganhou a Origem padrão.
  const contatos = await request.get("/api/v1/contacts?q=Instagram&limit=5");
  expect(contatos.ok()).toBe(true);
  const { data } = (await contatos.json()) as { data: { custom_fields?: Record<string, unknown> }[] };
  expect(data.some((c) => c.custom_fields?.origem === "Instagram Dr. André")).toBe(true);
  await page.goto("/app/kanban");
  await expect(page.getByText(/Contato do Instagram|@IGSID|Instagram/).first()).toBeVisible();
});
```

Ajuste o import de `login` ao helper real (`tests/e2e/helpers/auth.ts` ou o padrão da spec `followup-horario-de-envio.spec.ts`). Sem perfil real da Meta no e2e, o nome do contato é `null`: a lista mostra o fallback, e o teste confere a ausência de `"??"`.

- [ ] **Step 3: Rodar pela receita local** (`.agents/skills/deskcomm-contribuir/references/receita-e2e-local.md`) com o seed novo; guardar a evidência em `evidence/instagram-direct/`.
- [ ] **Step 4: Documentação** — spec na `SPECS_PARTE_2` do `e2e.yml`; jornada `J21 — Direct do Instagram no Inbox [P1]` no `user-journey-map.md`; nó do canal no mapa vivo (`docs/architecture/*.json`, arestas Conexões → webhook → Inbox/funil); `docs/current-state.md` ("Instagram: recebe; resposta na etapa 2"); fragmento:

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: Mensagens do Direct do Instagram chegam ao Inbox
---
Em Conexões dá para conectar contas profissionais do Instagram pelo login da Meta. Cada mensagem do Direct aparece no Inbox junto com as do WhatsApp, com o @ da pessoa e o perfil que recebeu, vira card no funil e pode preencher uma Origem padrão. Responder pelo CRM chega na próxima versão. Exige cadastrar o Instagram App ID e o App Secret na tela da Meta do admin.
```

- [ ] **Step 5: Suíte e pré-voo** — `pnpm typecheck; pnpm lint; pnpm lint:channels; pnpm test:unit; pnpm test:db; pnpm release:conferir; bash .agents/skills/deskcomm-contribuir/scripts/pre-voo.sh` (conferir `find . -path ./node_modules -prune -o -type f -flags +dataless -print | wc -l` = 0 antes de confiar em vermelho local).
- [ ] **Step 6: PR** para `main` do fork, com "O que medi" e "O que NÃO medi".

---

## Etapas seguintes (esboço, cada uma com plano próprio)

**Etapa 2 · Responder.** Capacidade nova na matriz, declarada para todos os providers: `foraDaJanela: "template" | "etiqueta_humana_7d" | "livre"` e `exigeTelefone`. `resolveRecipient` aceita identidade de canal (`RecipientInput.identidadeDeCanal`). `instagramAdapter.send`: POST `graph.instagram.com/{versão}/me/messages` com `{ recipient: { id }, message: { text } }` ou anexo por URL assinada do Storage; entre 24h e 7d só autor humano, com `messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT"`; depois de 7d bloqueia antes de enviar. Compositor mostra o relógio (`lib/channels/janela.ts`). Pre-go-live deixa de ser chave por telefone. Primeiro envio real confere se a tag exige aprovação (risco da spec §10).

**Etapa 3 · Follow-ups, agente e junção.** Envio automático em canal `etiqueta_humana_7d` só dentro de 24h; fora disso `skipped: 'fora_da_janela_automatica'` visível no dossiê. `validate-publish` para de exigir template em fluxo cujo gatilho é de canal sem template. `fn_mesclar_contatos` move `contact_channel_identities` (migration + baseline + teste de invariante). Ficha do contato lista os canais.

**Etapa 4 · Messenger.** Provider `meta_messenger`, `object: "page"`, identidade PSID em `contact_channel_identities.channel = 'messenger'` (CHECK ampliado no bloco único), conexão por Facebook Login (`pages_messaging`, token de Página), mesmo webhook-do-app com roteamento por `entry.id` = page id.
