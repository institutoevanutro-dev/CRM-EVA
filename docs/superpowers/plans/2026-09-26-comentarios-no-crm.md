# Comentários do Instagram no CRM — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** responder comentário de vídeo do Instagram pelo CRM — palavra combinada vira Direct + card no funil quando a pessoa responder; comentário solto ganha resposta pública no jeito do dono, mas só quando é obviamente seguro.

**Architecture:** o webhook do Instagram que já existe passa a aceitar `entry[].changes[]` além de `entry[].messaging[]`; cada comentário vira linha em `instagram_comments`. O que fazer com ele é decidido por duas funções PURAS (o casador de palavra e o classificador de segurança), fora do caminho do webhook — que só grava e responde rápido. Quem age é um worker, usando dois métodos novos do adapter do Instagram (resposta privada e resposta pública).

**Tech Stack:** Next.js 16 App Router, TypeScript estrito, Supabase (Postgres + RLS), Graph API do Instagram (`graph.instagram.com`), Vitest (unit + invariantes), Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-09-26-comentarios-no-crm-design.md`

## Global Constraints

- **Resposta privada:** `POST https://graph.instagram.com/<versão>/<IG_ID>/messages` com `recipient: {"comment_id": "<id>"}`. **Uma única por comentário**, dentro de **7 dias** do comentário.
- **Permissão:** o webhook `comments` e a resposta privada pedem `instagram_business_basic` + **`instagram_business_manage_comments`**. A resposta privada NÃO usa a permissão de mensagens.
- **Nome de provider não sai de `lib/channels/`** — invariante 1 de `docs/doctrine/restricao-de-canal.md`, vigiado pelo `pnpm lint:channels`. Componente e rota falam por capability.
- **A IA só publica sozinha no que é obviamente seguro.** Preço, medicação, dose, sintoma, agendamento e reclamação viram sugestão esperando toque. Nunca link, nunca preço na resposta pública.
- **Migration exige a TRIPLA:** arquivo em `supabase/migrations/` + apêndice idempotente no `supabase/baseline.sql` + linha no `supabase/migrations/MANIFEST.md`.
- **`situacao` é `text` + CHECK, nunca enum** (doutrina do `CLAUDE.md`).
- **Toda tabela tenant-aware:** `organization_id uuid not null references organizations(id) on delete cascade` + RLS `tenant_isolation_<tabela>_all` via `fn_user_org_ids()`.
- **Texto novo de tela tem espanhol** em `lib/i18n/dicionario.ts`; o guard de i18n reprova sem.
- **Tela nova tem porta** em `lib/navigation/catalogo.ts`.
- **Fragmento `.changes/`** com efeito `exige_acao`: o escopo novo pede reconexão dos dois perfis.
- **Nada disso funciona em produção antes do Acesso Avançado da Meta** (spec §10). O código é construído e testado contra receptor local; a liberação é ato do dono no painel da Meta.

## Review Focus

Cinco coisas que a spec implica, que nenhuma task cobriria sozinha, e que morderiam quem usa:

1. **Comentário com mais de 7 dias** (a Meta reentrega, ou o worker atrasou): tentar o privado devolve erro; o certo é não tentar, publicar só a frase pública e dizer por quê — Task 5.
2. **A mesma pessoa comenta a palavra duas vezes** no mesmo vídeo: a Meta permite uma resposta privada por COMENTÁRIO, então o segundo comentário é um comentário novo — mas mandar dois Directs iguais em sequência é spam. O segundo recebe só a resposta pública — Task 5.
3. **Comentário só com emoji** (sem texto): não pode quebrar o casador nem o classificador, e é o caso mais comum de "obviamente seguro" — Tasks 4 e 6.
4. **Palavra-chave dentro de outra palavra** ("cardápio" em "cardápios"): casar por palavra inteira, senão o CRM manda Direct para quem não pediu — Task 4.
5. **Duas organizações com o mesmo `media_id`** (impossível na prática, trivial de errar no SQL): a regra de uma organização nunca pode agir no comentário da outra — Task 1 (invariante de RLS) e Task 4.

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/<ts>_0279_comentarios_do_instagram.sql` (criar) | as duas tabelas, RLS, CHECK, índices |
| `lib/channels/instagram/webhook.ts` (modificar) | passa a devolver também eventos de comentário |
| `lib/channels/instagram/comentarios/ingest.ts` (criar) | grava o comentário, idempotente |
| `lib/comentarios/regra.ts` (criar) | PURO: qual regra casa este texto |
| `lib/comentarios/seguranca.ts` (criar) | PURO: obviamente seguro, ou precisa de você |
| `lib/channels/adapters/instagram.ts` (modificar) | `responderComentario` e `respostaPrivada` |
| `lib/comentarios/acao.ts` (criar) | aplica a decisão e grava o desfecho |
| `workers/comentarios-worker.ts` (criar) | tira da fila e chama a ação |
| `lib/comentarios/voz.ts` (criar) | perfil de voz a partir do histórico |
| `components/inbox/comentarios/*` (criar) | a aba e a tela de regras |

---

### Task 1: as duas tabelas

**Files:**
- Create: `supabase/migrations/20260926120000_0279_comentarios_do_instagram.sql`
- Modify: `supabase/baseline.sql` (apêndice, ANTES do bloco final de varredura anon)
- Modify: `supabase/migrations/MANIFEST.md`
- Test: `tests/invariants/comentarios-do-instagram.test.ts`

**Interfaces:**
- Produces: tabelas `public.instagram_comments` e `public.instagram_comment_rules`, com as colunas que as tasks 3 a 8 usam pelo nome.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { comBanco, duasOrgs } from "../helpers/banco";   // helpers já usados pelos invariantes vizinhos

describe("instagram_comments", () => {
  it("isola por organização (RLS)", async () => {
    await comBanco(async (db) => {
      const { orgA, orgB } = await duasOrgs(db);
      await db.comoOrg(orgA).from("instagram_comments").insert({ organization_id: orgA, external_id: "c1", media_id: "m1", texto: "oi", autor_igsid: "i1", comentado_em: new Date().toISOString(), situacao: "novo" });
      const { data } = await db.comoOrg(orgB).from("instagram_comments").select("id");
      expect(data ?? []).toHaveLength(0);
    });
  });

  it("o mesmo external_id não entra duas vezes na mesma organização", async () => {
    await comBanco(async (db) => {
      const { orgA } = await duasOrgs(db);
      const linha = { organization_id: orgA, external_id: "c-repetido", media_id: "m1", texto: "oi", autor_igsid: "i1", comentado_em: new Date().toISOString(), situacao: "novo" };
      await db.comoOrg(orgA).from("instagram_comments").insert(linha);
      const { error } = await db.comoOrg(orgA).from("instagram_comments").insert(linha);
      expect(error?.code).toBe("23505");
    });
  });

  it("situacao fora do vocabulário é recusada pelo CHECK", async () => {
    await comBanco(async (db) => {
      const { orgA } = await duasOrgs(db);
      const { error } = await db.comoOrg(orgA).from("instagram_comments").insert({ organization_id: orgA, external_id: "c2", media_id: "m1", texto: "oi", autor_igsid: "i1", comentado_em: new Date().toISOString(), situacao: "inventado" });
      expect(error?.code).toBe("23514");
    });
  });
});
```

Antes de escrever, abrir um invariante vizinho (`tests/invariants/instagram-canal.test.ts`) e usar os MESMOS helpers e o mesmo estilo — os nomes acima (`comBanco`, `duasOrgs`, `comoOrg`) são os do repo; se divergirem, vale o do repo.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:db`
Expected: FAIL — `relation "public.instagram_comments" does not exist`.

- [ ] **Step 3: Write the migration**

```sql
create table if not exists public.instagram_comments (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid references public.channel_sessions(id) on delete set null,
  external_id text not null,
  media_id text not null,
  texto text,
  autor_igsid text not null,
  autor_handle text,
  contact_id uuid references public.contacts(id) on delete set null,
  comentado_em timestamptz not null,
  situacao text not null default 'novo'
    check (situacao in ('novo','respondido_pela_regra','respondido_pela_ia','esperando_voce','ignorado')),
  regra_id uuid,
  resposta_publica_id text,
  private_reply_message_id text,
  sugestao_de_resposta text,
  motivo_do_toque text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists instagram_comments_externo
  on public.instagram_comments(organization_id, external_id);
create index if not exists instagram_comments_fila
  on public.instagram_comments(organization_id, situacao, comentado_em desc);

create table if not exists public.instagram_comment_rules (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete cascade,
  media_id text not null,
  palavra text not null,
  texto_do_direct text not null,
  frase_publica text not null,
  ativa boolean not null default true,
  criada_por uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists instagram_comment_rules_video
  on public.instagram_comment_rules(organization_id, media_id) where ativa;

alter table public.instagram_comments enable row level security;
alter table public.instagram_comment_rules enable row level security;

drop policy if exists tenant_isolation_instagram_comments_all on public.instagram_comments;
create policy tenant_isolation_instagram_comments_all on public.instagram_comments
  for all using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));

drop policy if exists tenant_isolation_instagram_comment_rules_all on public.instagram_comment_rules;
create policy tenant_isolation_instagram_comment_rules_all on public.instagram_comment_rules
  for all using (organization_id in (select public.fn_user_org_ids()))
  with check (organization_id in (select public.fn_user_org_ids()));
```

Copiar o MESMO bloco para o apêndice do `baseline.sql`, rotulado `-- ---- comentários do Instagram (migration 0279) ----`, **antes** do bloco final de varredura anon (o cabeçalho daquele bloco diz que ele é o último de propósito). Acrescentar a linha no MANIFEST.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:db`
Expected: PASS, 3 casos novos, e o baseline aplica limpo em `install` e em `update`.

- [ ] **Step 5: Commit**

```bash
git add supabase/ tests/invariants/comentarios-do-instagram.test.ts
git commit -m "feat(comentarios): tabelas de comentário e de regra, com RLS"
```

---

### Task 2: o webhook entende comentário

**Files:**
- Modify: `lib/channels/instagram/webhook.ts`
- Test: `lib/channels/instagram/webhook.test.ts`

**Interfaces:**
- Produces:
  - `export interface ComentarioDoInstagram { igAccountId: string; externalId: string; mediaId: string; texto: string | null; autorIgsid: string; autorHandle: string | null; comentadoEm: Date; eco: boolean }`
  - `export function parseComentariosDoInstagram(corpo: unknown): ComentarioDoInstagram[]`
- `parseWebhookDoInstagram` NÃO muda de assinatura: mensagem e comentário são listas separadas, e quem chama decide o que fazer com cada uma.

- [ ] **Step 1: Write the failing test**

```ts
import { parseComentariosDoInstagram, parseWebhookDoInstagram } from "./webhook";

const payloadDeComentario = {
  object: "instagram",
  entry: [{
    id: "IG-CONTA-1",
    time: 1790000000,
    changes: [{
      field: "comments",
      value: {
        id: "COMENTARIO-1",
        text: "CARDAPIO",
        media: { id: "MEDIA-9", media_product_type: "REELS" },
        from: { id: "IGSID-7", username: "fulana" },
        timestamp: "2026-09-26T12:00:00+0000",
      },
    }],
  }],
};

it("lê o comentário do campo changes", () => {
  const [c] = parseComentariosDoInstagram(payloadDeComentario);
  expect(c).toMatchObject({
    igAccountId: "IG-CONTA-1", externalId: "COMENTARIO-1", mediaId: "MEDIA-9",
    texto: "CARDAPIO", autorIgsid: "IGSID-7", autorHandle: "fulana", eco: false,
  });
});

it("comentário do próprio perfil vem marcado como eco", () => {
  const meu = structuredClone(payloadDeComentario);
  meu.entry[0]!.changes[0]!.value.from.id = "IG-CONTA-1";
  expect(parseComentariosDoInstagram(meu)[0]!.eco).toBe(true);
});

it("campo que não é comments é ignorado", () => {
  const outro = structuredClone(payloadDeComentario);
  outro.entry[0]!.changes[0]!.field = "live_comments";
  expect(parseComentariosDoInstagram(outro)).toEqual([]);
});

it("payload de MENSAGEM não vira comentário, e continua virando mensagem", () => {
  const msg = {
    object: "instagram",
    entry: [{ id: "IG-CONTA-1", messaging: [{
      sender: { id: "IGSID-7" }, recipient: { id: "IG-CONTA-1" }, timestamp: 1790000000000,
      message: { mid: "MID-1", text: "oi" },
    }] }],
  };
  expect(parseComentariosDoInstagram(msg)).toEqual([]);
  expect(parseWebhookDoInstagram(msg)).toHaveLength(1);
});

it("comentário só com emoji é lido, não descartado", () => {
  const emoji = structuredClone(payloadDeComentario);
  emoji.entry[0]!.changes[0]!.value.text = "🔥";
  expect(parseComentariosDoInstagram(emoji)[0]!.texto).toBe("🔥");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/channels/instagram/webhook.test.ts`
Expected: FAIL — `parseComentariosDoInstagram is not a function`.

- [ ] **Step 3: Implement**

Acrescentar ao `corpoSchema` o campo `changes: z.array(z.unknown()).optional()` (o objeto já é `.passthrough()`), um `comentarioSchema` com `id`, `text` opcional, `media.id`, `from.id`, `from.username` opcional e `timestamp`, e a função nova. `eco` é `value.from.id === entry.id`. Texto ausente vira `null`, e o comentário **não** é descartado por isso (uma foto em resposta é um comentário).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/channels/instagram/webhook.test.ts`
Expected: PASS, 5 casos novos, e os casos de mensagem que já existiam continuam verdes.

- [ ] **Step 5: Commit**

```bash
git add lib/channels/instagram/webhook.ts lib/channels/instagram/webhook.test.ts
git commit -m "feat(comentarios): o webhook do Instagram lê o campo comments"
```

---

### Task 3: gravar o comentário

**Files:**
- Create: `lib/channels/instagram/comentarios/ingest.ts`
- Modify: `app/api/v1/webhooks/instagram/route.ts`
- Test: `lib/channels/instagram/comentarios/ingest.test.ts`

**Interfaces:**
- Consumes: `ComentarioDoInstagram` e `parseComentariosDoInstagram` (Task 2); `sessaoDoInstagramPorConta` (já existe, `lib/channels/instagram/sessao.ts`).
- Produces: `export async function ingerirComentario(admin, comentario, sessao): Promise<{ status: "gravado"; id: string } | { status: "ignorado"; motivo: string } | { status: "falhou"; motivo: string }>`

- [ ] **Step 1: Write the failing test**

```ts
it("grava o comentário como novo", async () => {
  const r = await ingerirComentario(fake, comentario, sessao);
  expect(r).toMatchObject({ status: "gravado" });
  expect(linhaGravada()).toMatchObject({ situacao: "novo", external_id: "COMENTARIO-1", media_id: "MEDIA-9" });
});

it("eco do próprio perfil não é gravado", async () => {
  const r = await ingerirComentario(fake, { ...comentario, eco: true }, sessao);
  expect(r).toMatchObject({ status: "ignorado", motivo: "eco" });
  expect(linhaGravada()).toBeUndefined();
});

it("reentrega da Meta não duplica: 23505 é desfecho normal", async () => {
  fake.erroDoInsert = { code: "23505", message: "duplicate key" };
  const r = await ingerirComentario(fake, comentario, sessao);
  expect(r).toMatchObject({ status: "ignorado", motivo: "ja_recebido" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/channels/instagram/comentarios/ingest.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implement**

`ingerirComentario` insere a linha com `situacao: 'novo'`, `organization_id` e `channel_session_id` da sessão. Eco sai antes do insert. `23505` devolve `ignorado/ja_recebido` — reentrega é esperada e não é erro.

Na rota do webhook, depois do laço de mensagens, um laço igual para `parseComentariosDoInstagram(corpo)`, com o MESMO tratamento de falha que o laço de mensagens já tem: exceção e erro de infraestrutura marcam `falhaDeInfraestrutura`; falha determinística só loga. **Nada de responder comentário aqui** — a rota grava e responde rápido, senão a Meta reenvia.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/channels/instagram/comentarios/ingest.test.ts`
Expected: PASS, 3 casos.

- [ ] **Step 5: Commit**

```bash
git add lib/channels/instagram/comentarios/ app/api/v1/webhooks/instagram/route.ts
git commit -m "feat(comentarios): o webhook grava o comentário recebido"
```

---

### Task 4: o casador de palavra (puro)

**Files:**
- Create: `lib/comentarios/regra.ts`
- Test: `lib/comentarios/regra.test.ts`

**Interfaces:**
- Produces:
  - `export interface RegraDeComentario { id: string; mediaId: string; palavra: string; textoDoDirect: string; frasePublica: string; criadaEm: string }`
  - `export function regraQueCasa(texto: string | null, regras: RegraDeComentario[]): RegraDeComentario | null`

- [ ] **Step 1: Write the failing test**

```ts
const r = (palavra: string, extra: Partial<RegraDeComentario> = {}): RegraDeComentario => ({
  id: palavra, mediaId: "m1", palavra, textoDoDirect: "link", frasePublica: "te mandei",
  criadaEm: "2026-09-01T00:00:00Z", ...extra,
});

it("casa sem acento e sem caixa", () => {
  expect(regraQueCasa("CARDAPIO", [r("cardápio")])?.id).toBe("cardápio");
  expect(regraQueCasa("quero o cardápio!", [r("CARDAPIO")])?.id).toBe("CARDAPIO");
});

it("casa PALAVRA INTEIRA: não dispara dentro de outra palavra", () => {
  expect(regraQueCasa("cardápios da vovó", [r("cardápio")])).toBeNull();
  expect(regraQueCasa("descardapio", [r("cardapio")])).toBeNull();
});

it("pontuação colada não atrapalha", () => {
  expect(regraQueCasa("CARDÁPIO, por favor", [r("cardapio")])?.id).toBe("cardapio");
});

it("duas regras casando: vence a palavra mais longa; empate, a mais antiga", () => {
  expect(regraQueCasa("quero o plano premium", [r("plano"), r("plano premium")])?.palavra).toBe("plano premium");
  const a = r("plano", { id: "antiga", criadaEm: "2026-01-01T00:00:00Z" });
  const b = r("guia", { id: "nova", criadaEm: "2026-05-01T00:00:00Z" });
  expect(regraQueCasa("plano e guia", [b, a])?.id).toBe("antiga");
});

it("texto vazio, nulo ou só emoji não casa nada", () => {
  expect(regraQueCasa(null, [r("cardapio")])).toBeNull();
  expect(regraQueCasa("   ", [r("cardapio")])).toBeNull();
  expect(regraQueCasa("🔥🔥", [r("cardapio")])).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run lib/comentarios/regra.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implement**

Normalizar com `String.prototype.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()`, dos dois lados. Casar com fronteira de palavra construída sobre o texto normalizado, escapando a palavra antes de virar regex (palavra do usuário vai para dentro de um `RegExp`: sem escapar, um `(` cadastrado derruba a função). Ordenar os candidatos por comprimento da palavra (desc) e depois por `criadaEm` (asc). **O chamador já passa só as regras ativas daquele `media_id`** — esta função não filtra por vídeo nem por organização, e por isso não pode vazar entre organizações: quem consulta é quem filtra.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run lib/comentarios/regra.test.ts`
Expected: PASS, 5 casos.

- [ ] **Step 5: Commit**

```bash
git add lib/comentarios/regra.ts lib/comentarios/regra.test.ts
git commit -m "feat(comentarios): o casador de palavra-chave, puro"
```

---

### Task 5: responder — privada e pública

**Files:**
- Modify: `lib/channels/adapters/instagram.ts`
- Create: `lib/comentarios/acao.ts`
- Test: `lib/channels/adapters/instagram.test.ts`, `lib/comentarios/acao.test.ts`

**Interfaces:**
- Consumes: `regraQueCasa` (Task 4), `resolveInstagramToken` e `baseDoInstagram()` (já existem no adapter).
- Produces:
  - no adapter: `respostaPrivadaAoComentario(input: { organizationId: string; sessionRef: string; commentId: string; texto: string }): Promise<{ messageId: string | null }>` e `responderComentario(input: { organizationId: string; sessionRef: string; commentId: string; texto: string }): Promise<{ replyId: string | null }>`
  - `export const JANELA_DA_RESPOSTA_PRIVADA_MS = 7 * 24 * 60 * 60 * 1000`
  - `export async function aplicarRegra(admin, comentario, regra, agora): Promise<Desfecho>`

- [ ] **Step 1: Write the failing test (adapter)**

```ts
it("resposta privada endereça pelo comment_id", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    { ok: true, status: 200, json: async () => ({ message_id: "mid-1" }) } as unknown as Response);
  await instagramAdapter.respostaPrivadaAoComentario!({ organizationId: "org", sessionRef: "IG-1", commentId: "C-1", texto: "oi" });
  const [url, init] = (globalThis.fetch as never as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(String(url)).toContain("/IG-1/messages");
  expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
    recipient: { comment_id: "C-1" }, message: { text: "oi" },
  });
});

it("resposta pública vai no endpoint de replies do comentário", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    { ok: true, status: 200, json: async () => ({ id: "reply-1" }) } as unknown as Response);
  const r = await instagramAdapter.responderComentario!({ organizationId: "org", sessionRef: "IG-1", commentId: "C-1", texto: "te mandei 💚" });
  expect(r.replyId).toBe("reply-1");
  expect(String((globalThis.fetch as never as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain("/C-1/replies");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/channels/adapters/instagram.test.ts`
Expected: FAIL — os dois métodos não existem.

- [ ] **Step 3: Implement no adapter**

Os dois métodos entram como opcionais em `ChannelAdapter` (só o Instagram os tem) e reusam `resolveInstagramToken`, `baseDoInstagram()` e o mesmo tratamento de erro do `send` (`erroDoInstagram`). Privada: `POST {base}/{versão}/{sessionRef}/messages` com `recipient: { comment_id }`. Pública: `POST {base}/{versão}/{commentId}/replies` com `message`.

- [ ] **Step 4: Write the failing test (ação)**

```ts
const seteDiasEUmMinuto = new Date("2026-10-03T12:01:00Z");

it("dentro dos 7 dias: manda o privado, depois a frase pública, e marca atendido", async () => {
  const d = await aplicarRegra(fake, comentario, regra, new Date("2026-09-27T12:00:00Z"));
  expect(d.ordem).toEqual(["privada", "publica"]);
  expect(linha().situacao).toBe("respondido_pela_regra");
});

it("passou de 7 dias: NÃO tenta o privado, publica a frase e diz por quê", async () => {
  const d = await aplicarRegra(fake, comentario, regra, seteDiasEUmMinuto);
  expect(d.ordem).toEqual(["publica"]);
  expect(linha().motivo_do_toque).toContain("7 dias");
});

it("mesma pessoa comentou de novo no mesmo vídeo: só a frase pública", async () => {
  fake.jaMandouPrivadoPara = { mediaId: "MEDIA-9", autorIgsid: "IGSID-7" };
  const d = await aplicarRegra(fake, comentario, regra, new Date("2026-09-27T12:00:00Z"));
  expect(d.ordem).toEqual(["publica"]);
});

it("privado recusado (perfil fechado): a pública ainda sai, e a linha pede seu toque", async () => {
  fake.erroDaPrivada = new Error("instagram_551: Essa pessoa não pode receber mensagens deste perfil.");
  const d = await aplicarRegra(fake, comentario, regra, new Date("2026-09-27T12:00:00Z"));
  expect(d.ordem).toEqual(["publica"]);
  expect(linha().situacao).toBe("esperando_voce");
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `pnpm vitest run lib/comentarios/acao.test.ts`
Expected: FAIL — `aplicarRegra` não existe.

- [ ] **Step 6: Implement a ação**

Ordem: privada (se dentro de 7 dias E esta pessoa ainda não recebeu privado por este vídeo) → pública → grava desfecho. A privada vem primeiro porque é a que tem prazo e é única. Falha da privada não impede a pública. Auditar `comment.private_reply_sent` e `comment.replied` (acrescentar os dois a `lib/audit/actions.ts`).

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm vitest run lib/comentarios/acao.test.ts lib/channels/adapters/instagram.test.ts`
Expected: PASS, 6 casos novos.

- [ ] **Step 8: Commit**

```bash
git add lib/channels/adapters/instagram.ts lib/comentarios/acao.ts lib/audit/actions.ts lib/comentarios/acao.test.ts lib/channels/adapters/instagram.test.ts
git commit -m "feat(comentarios): resposta privada e pública ao comentário"
```

---

### Task 6: o classificador de segurança (puro)

**Files:**
- Create: `lib/comentarios/seguranca.ts`
- Test: `lib/comentarios/seguranca.test.ts`

**Interfaces:**
- Produces: `export type Veredito = { seguro: true } | { seguro: false; gatilho: string }` e `export function ehObviamenteSeguro(texto: string | null): Veredito`

Espelha `lib/opt-out/deteccao.ts`, que já faz exatamente este tipo de julgamento de texto neste repo — abrir aquele arquivo antes de escrever.

- [ ] **Step 1: Write the failing test**

```ts
const inseguros: [string, string][] = [
  ["quanto custa?", "preço"], ["qual o valor da consulta", "preço"], ["tem desconto?", "preço"],
  ["posso tomar mounjaro?", "medicação"], ["qual a dose de tirzepatida", "medicação"],
  ["serve pra quem tem tireoide?", "sintoma"], ["senti tontura, é normal?", "sintoma"],
  ["como agendo?", "agendamento"], ["tem horário amanhã?", "agendamento"],
  ["paguei e ninguém me respondeu", "reclamação"], ["que golpe é esse", "reclamação"],
];

it.each(inseguros)("%s precisa de você (%s)", (texto) => {
  expect(ehObviamenteSeguro(texto).seguro).toBe(false);
});

const seguros = ["top!", "amei 😍", "🔥🔥🔥", "parabéns doutor", "que vídeo bom"];
it.each(seguros)("%s é obviamente seguro", (texto) => {
  expect(ehObviamenteSeguro(texto)).toEqual({ seguro: true });
});

it("na dúvida, é inseguro: pergunta que não é elogio não passa", () => {
  expect(ehObviamenteSeguro("e para quem tem 60 anos?").seguro).toBe(false);
});

it("texto vazio ou nulo não é publicável", () => {
  expect(ehObviamenteSeguro(null).seguro).toBe(false);
  expect(ehObviamenteSeguro("   ").seguro).toBe(false);
});

it("elogio com pergunta retórica continua inseguro (a régua é conservadora)", () => {
  expect(ehObviamenteSeguro("amei! onde compro?").seguro).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run lib/comentarios/seguranca.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implement**

Determinístico, não LLM: uma lista de gatilhos por assunto (preço, medicação, sintoma, agendamento, reclamação) e uma lista curta de padrões seguros (elogio, emoji, interjeição). Regra final: é seguro **só** se nenhum gatilho casou E o texto casa um padrão seguro E não termina em `?`. Tudo o mais é `{ seguro: false }`. A normalização é a mesma da Task 4 (sem acento, sem caixa).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run lib/comentarios/seguranca.test.ts`
Expected: PASS, todos os casos.

- [ ] **Step 5: Commit**

```bash
git add lib/comentarios/seguranca.ts lib/comentarios/seguranca.test.ts
git commit -m "feat(comentarios): o classificador conservador de segurança"
```

---

### Task 7: o worker e a resposta no jeito do dono

**Files:**
- Create: `workers/comentarios-worker.ts`
- Create: `lib/comentarios/voz.ts`
- Modify: `docker-compose.prod.yml` (agendamento no `scheduler`)
- Test: `tests/unit/comentarios-worker.test.ts`, `lib/comentarios/voz.test.ts`

**Interfaces:**
- Consumes: `regraQueCasa` (4), `aplicarRegra` (5), `ehObviamenteSeguro` (6).
- Produces: `export async function processarComentariosNovos(admin, agora, teto = 50): Promise<{ atendidos: number; esperando: number }>` e `export async function perfilDeVoz(admin, sessionId): Promise<{ frases: string[]; emojis: string[]; tratamento: string } | null>`

- [ ] **Step 1: Write the failing test do worker**

```ts
it("comentário que casa regra vai para a ação", async () => {
  const r = await processarComentariosNovos(fake, agora);
  expect(r.atendidos).toBe(1);
  expect(fake.acoesAplicadas).toHaveLength(1);
});

it("comentário seguro sem regra: a IA escreve e publica", async () => {
  fake.comentarios = [{ ...comentario, texto: "amei 😍" }];
  await processarComentariosNovos(fake, agora);
  expect(linha().situacao).toBe("respondido_pela_ia");
});

it("comentário inseguro sem regra: NADA é publicado, fica esperando", async () => {
  fake.comentarios = [{ ...comentario, texto: "quanto custa?" }];
  await processarComentariosNovos(fake, agora);
  expect(linha().situacao).toBe("esperando_voce");
  expect(linha().motivo_do_toque).toBe("preço");
  expect(fake.publicacoes).toHaveLength(0);
});

it("a IA falhou: fica esperando, sem publicar vazio", async () => {
  fake.erroDaIa = new Error("modelo fora do ar");
  fake.comentarios = [{ ...comentario, texto: "top!" }];
  await processarComentariosNovos(fake, agora);
  expect(linha().situacao).toBe("esperando_voce");
  expect(fake.publicacoes).toHaveLength(0);
});

it("teto por rodada é respeitado", async () => {
  fake.comentarios = Array.from({ length: 80 }, (_, i) => ({ ...comentario, external_id: `c${i}`, texto: "top!" }));
  const r = await processarComentariosNovos(fake, agora, 50);
  expect(r.atendidos + r.esperando).toBe(50);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/comentarios-worker.test.ts`
Expected: FAIL — worker não existe.

- [ ] **Step 3: Implement o worker**

Lê `situacao = 'novo'` por organização, mais antigos primeiro, com teto. Para cada um: regra casa → `aplicarRegra`; não casa → `ehObviamenteSeguro`; seguro → gera pelo agente com o perfil de voz e publica (`responderComentario`); inseguro ou geração falhou → `esperando_voce` com a sugestão (quando houver) e o gatilho em `motivo_do_toque`. **Nunca publica texto vazio.** Teto de tamanho na resposta gerada, e recusa se ela contiver link (`http`) ou algarismo com `R$`.

- [ ] **Step 4: Write the failing test da voz**

```ts
it("monta o perfil das respostas anteriores do dono", async () => {
  fake.respostasAnteriores = ["Que bom que gostou! 🌿", "Obrigado, viu! 🌿", "Fico feliz 🌿"];
  const p = await perfilDeVoz(fake, "s1");
  expect(p!.emojis).toContain("🌿");
  expect(p!.frases.length).toBeGreaterThan(0);
});

it("sem histórico devolve null, e o worker não publica sozinho sem perfil", async () => {
  fake.respostasAnteriores = [];
  expect(await perfilDeVoz(fake, "s1")).toBeNull();
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `pnpm vitest run lib/comentarios/voz.test.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 6: Implement a voz**

Lê os comentários do próprio perfil já respondidos (as respostas do dono nos próprios posts, via Graph, com o mesmo token da sessão) e extrai: emojis mais usados, tratamento predominante (você/senhor), e até 20 frases típicas. Sem histórico → `null`, e sem perfil o worker **não** publica sozinho (cai em `esperando_voce`): escrever "no jeito dele" sem saber o jeito dele é justamente o que a spec quer evitar.

- [ ] **Step 7: Run to verify it passes**

Run: `pnpm vitest run tests/unit/comentarios-worker.test.ts lib/comentarios/voz.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add workers/comentarios-worker.ts lib/comentarios/voz.ts docker-compose.prod.yml tests/unit/comentarios-worker.test.ts lib/comentarios/voz.test.ts
git commit -m "feat(comentarios): worker que responde, e o perfil de voz do dono"
```

---

### Task 8: a aba Comentários

**Files:**
- Create: `components/inbox/comentarios/ListaDeComentarios.tsx`, `components/inbox/comentarios/FormularioDeRegra.tsx`
- Create: `app/api/v1/comentarios/route.ts`, `app/api/v1/comentarios/[id]/publicar/route.ts`, `app/api/v1/comentarios/regras/route.ts`
- Modify: `components/inbox/InboxFilters.tsx`, `lib/navigation/catalogo.ts`, `lib/i18n/dicionario.ts`
- Test: `tests/unit/comentarios-aba.test.tsx`, `tests/unit/comentarios-rota.test.ts`

**Interfaces:**
- Consumes: as tabelas da Task 1.
- Produces: aba `comentarios` no Inbox; `POST /api/v1/comentarios/:id/publicar` (publica a sugestão, editada ou não).

- [ ] **Step 1: Write the failing test**

```tsx
it("mostra primeiro o que espera você, com a sugestão e os dois botões", () => {
  render(<ListaDeComentarios comentarios={[atendido, esperando]} />);
  const itens = screen.getAllByRole("listitem");
  expect(itens[0]).toHaveTextContent("quanto custa");
  expect(screen.getByRole("button", { name: "Publicar" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Editar" })).toBeTruthy();
});

it("diz por que o comentário está esperando", () => {
  render(<ListaDeComentarios comentarios={[esperando]} />);
  expect(screen.getByText(/preço/i)).toBeTruthy();
});

it("comentário atendido pela regra não oferece Publicar", () => {
  render(<ListaDeComentarios comentarios={[atendido]} />);
  expect(screen.queryByRole("button", { name: "Publicar" })).toBeNull();
});
```

E, para a rota, um teste que prova que publicar **exige** papel `agent+` e que a organização do comentário é conferida (não basta a RLS: a rota usa o cliente do usuário, mas o filtro explícito é a doutrina do repo).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/unit/comentarios-aba.test.tsx tests/unit/comentarios-rota.test.ts`
Expected: FAIL — componentes e rotas não existem.

- [ ] **Step 3: Implement**

Aba no `InboxFilters` (seguir `visibleInboxTabs`, que já decide por papel), lista ordenada com `esperando_voce` primeiro, e o formulário de regra. Porta em `lib/navigation/catalogo.ts`. Todo texto novo com espanhol no dicionário.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/unit/comentarios-aba.test.tsx tests/unit/comentarios-rota.test.ts`
Expected: PASS.

- [ ] **Step 5: o guard de i18n**

Run: `pnpm lint:channels` e o guard de i18n.
Expected: PASS — texto sem espanhol reprova aqui.

- [ ] **Step 6: Commit**

```bash
git add components/inbox/comentarios/ app/api/v1/comentarios/ lib/navigation/catalogo.ts lib/i18n/dicionario.ts tests/unit/comentarios-aba.test.tsx tests/unit/comentarios-rota.test.ts
git commit -m "feat(comentarios): aba no Inbox, com as regras e o toque de publicar"
```

---

### Task 9: escopo novo, prova de ponta a ponta e entrega

**Files:**
- Modify: `lib/channels/instagram/oauth.ts:18`, `lib/channels/instagram/oauth.test.ts`
- Create: `tests/e2e/comentarios-do-instagram.spec.ts`, `.changes/comentarios-do-instagram.md`
- Modify: `.github/workflows/e2e.yml` (`SPECS_PARTE_*`), `docs/architecture/`

- [ ] **Step 1: escopo novo, com teste**

```ts
it("pede também a permissão de comentários", () => {
  const u = new URL(urlDeAutorizacao({ appId: "1", redirect: "https://x/cb", state: "s" }));
  expect(u.searchParams.get("scope"))
    .toBe("instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments");
});
```

Run: `pnpm vitest run lib/channels/instagram/oauth.test.ts` → FAIL, depois a constante `ESCOPOS` ganha o terceiro escopo → PASS.

- [ ] **Step 2: Write the failing e2e**

Banco fresco do baseline: webhook assinado com um comentário que casa a regra → a aba mostra atendido, o Direct sai no receptor local (`INSTAGRAM_GRAPH_BASE_URL=http://127.0.0.1:47811`, o mesmo do spec do Direct) e a frase pública é postada; segundo caso, comentário "quanto custa" → `esperando você` e **zero publicações** no receptor.

- [ ] **Step 3: registrar a spec no CI**

Acrescentar `comentarios-do-instagram.spec.ts` a uma `SPECS_PARTE_*` de `.github/workflows/e2e.yml` — `tests/unit/e2e-cobertura-completa.test.ts` reprova spec nova que não esteja lá.

- [ ] **Step 4: fragmento de release**

`.changes/comentarios-do-instagram.md` com efeito **`exige_acao`**: o escopo novo pede que o dono reconecte os dois perfis, e a Meta precisa liberar Acesso Avançado para `comments`. Conferir com `pnpm release:conferir`.

- [ ] **Step 5: os gates todos**

```bash
pnpm typecheck && pnpm lint && pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests |Errors " /tmp/vt.log | tail -3
pnpm test:db
pnpm test:e2e tests/e2e/comentarios-do-instagram.spec.ts
```
Expected: `exit=0`, rodapé sem `failed`, linha `Errors` vazia, `test:db` verde.

- [ ] **Step 6: Commit e PR**

```bash
git add -A && git show --stat HEAD   # conferir que não entrou lixo do ambiente
git commit -m "feat(comentarios): comentários do Instagram no CRM"
git push -u origin feat/comentarios-do-instagram
```

- [ ] **Step 7: o que só o dono pode fazer**

No painel da Meta: acrescentar `instagram_business_manage_comments` ao app "CRM - EVA", assinar o campo `comments` no webhook, pedir **Acesso Avançado** (o vídeo da submissão é a gravação desta tela), e reconectar os dois perfis. **A feature não funciona em produção antes disso**, e o PR não deve afirmar o contrário.
