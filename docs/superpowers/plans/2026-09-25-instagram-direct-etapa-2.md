# Instagram Direct, etapa 2: responder pelo CRM. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A equipe responde Direct do Instagram pelo Inbox (texto e foto, janela 24h/7d), a tela distingue Instagram de WhatsApp, e o contato mostra nome ou @ em vez de "Contato do Instagram".

**Architecture:** O envio usa o caminho que já existe (`app/api/v1/messages/_handler.ts` → `getAdapter(provider).send`). O IGSID do cliente passa a morar em `conversations.provider_conversation_id` e chega ao adapter via `RecipientInput`. Regras por canal viram capabilities novas (`iaResponde`, `janelaHumanaMs`, `limiteDeTexto`, `midiaDeEnvio`), lidas pela tela e repetidas no servidor. A tela ganha um selo de canal com tokens de cor próprios.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript estrito, Supabase Postgres, Vitest, Playwright, Tailwind 4 (tokens em `app/globals.css`), ícones `@phosphor-icons/react` via `lib/ui/icons.ts`.

**Spec:** `docs/superpowers/specs/2026-09-25-instagram-direct-etapa-2-design.md` (continua `docs/superpowers/specs/2026-09-24-instagram-direct-no-crm-design.md`).

**Worktree:** `/Users/andreluislopescosta/CRM-EVA/wt-instagram-direct`, branch `feat/instagram-direct-etapa-2`. Todo comando roda nessa pasta.

## Global Constraints

- Nome de provider (`meta_instagram`, `waha`, `meta_cloud`…) e host `graph.instagram.com` só dentro de `lib/channels/` (`pnpm lint:channels`). O valor de coluna `conversations.channel` (`"instagram"`, `"whatsapp"`) pode aparecer na tela, como já aparece.
- Todo texto novo de tela com `t("...")` ganha entrada `es` em `lib/i18n/dicionario.ts` (guard `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`).
- Nada de travessão (—) em texto de tela novo; use ponto ou vírgula.
- Mudança de schema = migration `supabase/migrations/<timestamp>_0278_<slug>.sql` + apêndice idempotente no fim de `supabase/baseline.sql` (bloco `-- ---- <coisa> (migration 0278) ----`) + linha no `supabase/migrations/MANIFEST.md`.
- Envio que falha não reenvia sozinho (envio em dobro é pior que não-envio).
- A IA não responde no Instagram. Envio por ator que não é `user` em canal com `iaResponde: false` é recusado no servidor.
- Janela: até 24h livre; de 24h a 7 dias só humano, com `messaging_type: "MESSAGE_TAG"` e `tag: "HUMAN_AGENT"`; depois de 7 dias bloqueado. Limites exatos: `WINDOW_MS = 24h` e `7 * 24h`.
- Texto no Instagram: até 1000 caracteres. Mídia pelo CRM: só foto (`image/jpeg`, `image/png`).
- Texto do bloqueio de 7 dias (verbatim): "A Meta só deixa responder até 7 dias depois da última mensagem dessa pessoa. Responda pelo app do Instagram se ela escrever de novo."
- Texto de mídia recusada (verbatim): "Por enquanto o Instagram aceita só texto e foto pelo CRM."
- Texto de pessoa indisponível (verbatim): "Essa pessoa não pode receber mensagens deste perfil."
- Nunca sobrescrever `contacts.display_name` já preenchido (pode ter sido editado pela equipe).
- `console.log` proibido; use `logger` de `@/lib/logger`.
- Nunca `git stash`. Nunca `update.sh`. Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Suíte: `pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"` e ler o rodapé; o exit code é a autoridade.

## Review Focus

1. Conversa do Instagram cujo `provider_conversation_id` está vazio (conversa antiga, nascida antes da migration): o envio precisa falhar com erro claro (`instagram_sem_destinatario`), nunca ficar `queued` para sempre. Teste na Task 3.
2. Pessoa com duas conversas (uma por perfil) depois de uma junção futura: o destinatário tem de sair da CONVERSA, não do contato. Teste na Task 3 (duas conversas, mesmo contato, IGSIDs diferentes).
3. Eco do próprio envio: o webhook traz de volta a mensagem que o CRM enviou, com o mesmo `message_id`. Não pode duplicar nem virar "enviada pelo celular". Teste na Task 5.
4. Conversa em que a pessoa nunca escreveu (só eco do celular, `last_inbound_at` nulo): a tela e o servidor tratam como fechada (a Meta não deixa iniciar conversa). Teste na Task 1 e na Task 3.
5. Follow-up automático caindo numa conversa do Instagram: falha com código próprio e a sequência segue, sem erro fatal no worker. Teste na Task 3 (ator `system`/`ai_agent`).

---

### Task 1: Capabilities novas e janela humana

**Files:**
- Modify: `lib/channels/types.ts` (tipo `ChannelCapabilities`)
- Modify: `lib/channels/capabilities.ts` (todas as entradas da matriz; `meta_instagram`)
- Modify: `lib/channels/index.ts` (`providersDeEnvioAutomatico`)
- Modify: `lib/channels/janela.ts`
- Test: `tests/unit/janela-humana-instagram.test.ts` (novo)

**Interfaces:**
- Produces:
  - `ChannelCapabilities.iaResponde: boolean` (true em todos, false em `meta_instagram`)
  - `ChannelCapabilities.janelaHumanaMs: number | null` (null em todos, `7 * 24 * 60 * 60 * 1000` em `meta_instagram`)
  - `ChannelCapabilities.limiteDeTexto: number | null` (null em todos, `1000` em `meta_instagram`)
  - `ChannelCapabilities.midiaDeEnvio: "completa" | "so_foto"` (`"completa"` em todos, `"so_foto"` em `meta_instagram`)
  - `EstadoDaJanela` ganha `{ tipo: "humana"; restanteMs: number }` e o tipo `fechada` ganha `regra: "modelo" | "sete_dias"`
  - `providersDeEnvioAutomatico()` passa a filtrar `canSend && iaResponde`
  - `JANELA_HUMANA_PADRAO_MS` não existe; a regra vem só da capability.
- `canSend` do `meta_instagram` continua `false` nesta task (vira `true` na Task 3).

- [ ] **Step 1: Teste que falha**

```ts
// tests/unit/janela-humana-instagram.test.ts
import { describe, expect, it } from "vitest";
import { estadoDaJanela } from "@/lib/channels/janela";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import { providersDeEnvioAutomatico } from "@/lib/channels";

const H = 60 * 60 * 1000;
const agora = new Date("2026-09-25T12:00:00Z");
const ha = (ms: number) => new Date(agora.getTime() - ms).toISOString();

describe("janela do Instagram", () => {
  it("até 24h está aberta", () => {
    expect(estadoDaJanela("meta_instagram", ha(23 * H), agora)).toEqual({ tipo: "aberta", restanteMs: 1 * H });
  });
  it("exatamente 24h já é humana", () => {
    expect(estadoDaJanela("meta_instagram", ha(24 * H), agora)).toEqual({ tipo: "humana", restanteMs: 6 * 24 * H });
  });
  it("entre 24h e 7 dias é humana, com o restante até os 7 dias", () => {
    expect(estadoDaJanela("meta_instagram", ha(3 * 24 * H), agora)).toEqual({ tipo: "humana", restanteMs: 4 * 24 * H });
  });
  it("exatamente 7 dias fecha, pela regra dos sete dias", () => {
    expect(estadoDaJanela("meta_instagram", ha(7 * 24 * H), agora)).toEqual({ tipo: "fechada", fechadaHaMs: 0, regra: "sete_dias" });
  });
  it("sem mensagem da pessoa está fechada", () => {
    expect(estadoDaJanela("meta_instagram", null, agora)).toEqual({ tipo: "fechada", fechadaHaMs: null, regra: "sete_dias" });
  });
  it("WhatsApp oficial continua na regra do modelo", () => {
    expect(estadoDaJanela("meta_cloud", ha(25 * H), agora)).toEqual({ tipo: "fechada", fechadaHaMs: 1 * H, regra: "modelo" });
  });
  it("capabilities do Instagram", () => {
    const c = capabilitiesOf("meta_instagram");
    expect([c.iaResponde, c.janelaHumanaMs, c.limiteDeTexto, c.midiaDeEnvio]).toEqual([false, 7 * 24 * H, 1000, "so_foto"]);
  });
  it("Instagram nunca é envio automático", () => {
    expect(providersDeEnvioAutomatico()).not.toContain("meta_instagram");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/janela-humana-instagram.test.ts`
Expected: FAIL (tipo `humana` e campos novos não existem).

- [ ] **Step 3: Implementar**

Em `lib/channels/types.ts`, dentro de `ChannelCapabilities`, depois de `canSend`:

```ts
  /** A IA do CRM pode responder por este canal. `false` = só gente. */
  iaResponde: boolean;
  /**
   * Janela estendida para resposta HUMANA depois das 24h (a tag HUMAN_AGENT da
   * Meta no Instagram). `null` = o canal não tem essa extensão.
   */
  janelaHumanaMs: number | null;
  /** Máximo de caracteres de um texto enviado. `null` = sem limite próprio do canal. */
  limiteDeTexto: number | null;
  /** O que o CRM consegue anexar por este canal. */
  midiaDeEnvio: "completa" | "so_foto";
```

Em `lib/channels/capabilities.ts`, acrescentar `iaResponde: true, janelaHumanaMs: null, limiteDeTexto: null, midiaDeEnvio: "completa"` em TODA entrada da matriz, e na `meta_instagram`: `iaResponde: false, janelaHumanaMs: 7 * 24 * 60 * 60 * 1000, limiteDeTexto: 1000, midiaDeEnvio: "so_foto"`. Atualizar o comentário da entrada: etapa 2 responde (humano), a IA não.

Em `lib/channels/index.ts`, `providersDeEnvioAutomatico`:

```ts
  return PROVIDERS_DE_MENSAGEM.filter((p) => CHANNEL_CAPABILITIES[p].canSend && CHANNEL_CAPABILITIES[p].iaResponde);
```

Em `lib/channels/janela.ts`, o tipo:

```ts
  | { tipo: "aberta"; restanteMs: number }
  /** Passou das 24h, mas GENTE ainda pode responder até `restanteMs` acabar. */
  | { tipo: "humana"; restanteMs: number }
  | { tipo: "fechada"; fechadaHaMs: number | null; regra: "modelo" | "sete_dias" };
```

E o corpo de `estadoDaJanela` depois do `if (caps.freeformOutsideWindow)`:

```ts
  const regra = caps.janelaHumanaMs === null ? "modelo" : "sete_dias";
  if (!lastInboundAt) return { tipo: "fechada", fechadaHaMs: null, regra };

  const ultimo = new Date(lastInboundAt);
  const restanteMs = windowRemainingMs(agora, ultimo);
  if (restanteMs > 0) return { tipo: "aberta", restanteMs };

  const limite = caps.janelaHumanaMs ?? WINDOW_MS;
  const decorrido = agora.getTime() - ultimo.getTime();
  if (decorrido < limite) return { tipo: "humana", restanteMs: limite - decorrido };

  const fechadaHaMs = Math.max(0, decorrido - limite);
  return { tipo: "fechada", fechadaHaMs, regra };
```

Conferir `windowRemainingMs(agora, ultimo)` com 24h exatas: tem de devolver `0` (o teste "exatamente 24h já é humana" depende disso). Se devolver positivo, ajustar a comparação aqui (`restanteMs > 0`) e não a função compartilhada.

Consertar os consumidores que o `tsc` apontar: `components/inbox/JanelaSelo.tsx` (tipo `humana` só retorna `null` nesta task; a Task 6 desenha), `tests/unit/janela-de-atendimento.test.tsx` (acrescentar `regra: "modelo"` nas expectativas de `fechada`), e qualquer `switch` exaustivo.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/janela-humana-instagram.test.ts tests/unit/janela-de-atendimento.test.tsx && pnpm typecheck`
Expected: PASS, typecheck zerado.

- [ ] **Step 5: Commit**

```bash
git add lib/channels tests/unit/janela-humana-instagram.test.ts tests/unit/janela-de-atendimento.test.tsx components/inbox/JanelaSelo.tsx
git commit -m "feat(canais): janela humana de 7 dias e capabilities de envio por canal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Adapter do Instagram envia texto e foto

**Files:**
- Modify: `lib/channels/instagram/graph.ts` (base configurável)
- Modify: `lib/channels/adapters/instagram.ts`
- Modify: `lib/channels/types.ts` (`RecipientInput.providerConversationId`, `OutboundEnvelope.etiquetaHumana`)
- Modify: `lib/env.ts`, `.env.example` (`INSTAGRAM_GRAPH_BASE_URL`)
- Test: `tests/unit/canal-instagram-envio.test.ts` (novo)

**Interfaces:**
- Consumes: `resolveInstagramToken` (já existe no adapter), `graphVersion()`.
- Produces:
  - `RecipientInput.providerConversationId?: string | null`
  - `OutboundEnvelope.etiquetaHumana?: boolean` (true = mandar com `HUMAN_AGENT`)
  - `instagramAdapter.resolveRecipient(input)` → `input.providerConversationId ?? null` (grupo → `null`)
  - `instagramAdapter.isConfigured()` → `true` (a credencial é por sessão e é conferida no `send`)
  - `instagramAdapter.send(envelope)` → `{ externalId: message_id }`; erro lança `Error("instagram_<codigo>: <texto em português>")`
  - `baseDoInstagram(): string` em `lib/channels/instagram/graph.ts` (lê `INSTAGRAM_GRAPH_BASE_URL`, padrão `https://graph.instagram.com`); `BASE_DO_INSTAGRAM` deixa de ser usado dentro do adapter e do graph (manter o export como padrão, para não quebrar importadores).

- [ ] **Step 1: Teste que falha**

```ts
// tests/unit/canal-instagram-envio.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ is: () => ({ maybeSingle: async () => ({ data: { ig_token_encrypted: "cifrado" }, error: null }) }) }) }) }) }),
    }),
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: async () => "TOKEN" }));

import { instagramAdapter } from "@/lib/channels/adapters/instagram";

const base = { organizationId: "org-1", sessionRef: "17841400000000001", to: "IGSID-1" };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ recipient_id: "IGSID-1", message_id: "mid.1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const corpo = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

describe("instagramAdapter.send", () => {
  it("texto dentro de 24h sai sem tag e devolve o message_id", async () => {
    const r = await instagramAdapter.send({ ...base, kind: "text", body: "Oi" } as never);
    expect(r).toEqual({ externalId: "mid.1" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/17841400000000001\/messages$/);
    expect(init.headers.Authorization).toBe("Bearer TOKEN");
    expect(corpo()).toEqual({ recipient: { id: "IGSID-1" }, message: { text: "Oi" } });
  });
  it("com etiqueta humana manda HUMAN_AGENT", async () => {
    await instagramAdapter.send({ ...base, kind: "text", body: "Oi", etiquetaHumana: true } as never);
    expect(corpo()).toEqual({ recipient: { id: "IGSID-1" }, message: { text: "Oi" }, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  });
  it("foto vai como attachment image", async () => {
    await instagramAdapter.send({ ...base, kind: "image", media: { url: "https://x/y.jpg", mime: "image/jpeg" } } as never);
    expect(corpo().message).toEqual({ attachment: { type: "image", payload: { url: "https://x/y.jpg" } } });
  });
  it("áudio é recusado sem chamar a Meta", async () => {
    await expect(instagramAdapter.send({ ...base, kind: "audio", media: { url: "https://x/a.ogg", mime: "audio/ogg" } } as never))
      .rejects.toThrow(/^instagram_tipo_nao_suportado: Por enquanto o Instagram aceita só texto e foto pelo CRM\./);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("texto acima de 1000 caracteres é recusado sem chamar a Meta", async () => {
    await expect(instagramAdapter.send({ ...base, kind: "text", body: "a".repeat(1001) } as never)).rejects.toThrow(/^instagram_texto_longo:/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("551 vira a frase de pessoa indisponível", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 551, message: "x" } }), { status: 400 }));
    await expect(instagramAdapter.send({ ...base, kind: "text", body: "Oi" } as never))
      .rejects.toThrow("instagram_551: Essa pessoa não pode receber mensagens deste perfil.");
  });
  it("190 pede reconexão", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 190, message: "x" } }), { status: 401 }));
    await expect(instagramAdapter.send({ ...base, kind: "text", body: "Oi" } as never)).rejects.toThrow(/^instagram_190: .*Conexões/);
  });
  it("resolveRecipient usa o id da conversa", () => {
    expect(instagramAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: null, waIdentity: null, providerConversationId: "IGSID-9" })).toBe("IGSID-9");
    expect(instagramAdapter.resolveRecipient({ isGroup: false, groupChatId: null, phoneNumber: "5527", waIdentity: null })).toBeNull();
  });
});
```

Ajuste o mock encadeado do Supabase se a consulta de `resolveInstagramToken` tiver outra ordem de `.eq/.is`; o que importa é devolver `ig_token_encrypted`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/canal-instagram-envio.test.ts`
Expected: FAIL (`send` lança `instagram_envio_indisponivel`).

- [ ] **Step 3: Implementar**

`lib/channels/types.ts`: em `RecipientInput` acrescentar

```ts
  /** Id do cliente NA CONVERSA, quando o canal endereça por conversa (IGSID do Instagram). */
  providerConversationId?: string | null;
```

e em `OutboundEnvelope`

```ts
  /** Envio humano fora das 24h num canal com janela humana: o adapter marca a mensagem como atendimento humano. */
  etiquetaHumana?: boolean;
```

`lib/channels/instagram/graph.ts`:

```ts
export const BASE_DO_INSTAGRAM = "https://graph.instagram.com";

/** Base da Graph API do Instagram. A variável existe para o e2e apontar para um receptor local. */
export function baseDoInstagram(): string {
  return (process.env.INSTAGRAM_GRAPH_BASE_URL ?? "").trim().replace(/\/+$/, "") || BASE_DO_INSTAGRAM;
}
```

Trocar os usos de `BASE_DO_INSTAGRAM` em `graph.ts` e em `adapters/instagram.ts` (`checkHealth`) por `baseDoInstagram()`. Registrar `INSTAGRAM_GRAPH_BASE_URL` como opcional em `lib/env.ts` (mesmo padrão das outras opcionais) e em `.env.example` com o comentário "Só para teste local. Deixe vazio em produção."

`lib/channels/adapters/instagram.ts`, substituir `resolveRecipient`, `isConfigured` e `send`:

```ts
const LIMITE_DE_TEXTO = 1000;
const TIPOS_DE_FOTO = new Set(["image/jpeg", "image/png"]);

function erroDoInstagram(codigo: number | string, detalhe: string): Error {
  const frases: Record<string, string> = {
    "190": "A chave deste perfil venceu ou foi revogada. Reconecte o Instagram em Conexões.",
    "551": "Essa pessoa não pode receber mensagens deste perfil.",
  };
  return new Error(`instagram_${codigo}: ${frases[String(codigo)] ?? detalhe}`);
}

// dentro de instagramAdapter:
  resolveRecipient: (input) => (input.isGroup ? null : input.providerConversationId ?? null),
  isConfigured: () => true,
  async send(envelope) {
    let message: Record<string, unknown>;
    if (envelope.kind === "text") {
      const texto = envelope.body ?? "";
      if (texto.length > LIMITE_DE_TEXTO) {
        throw new Error(`instagram_texto_longo: O Instagram aceita até ${LIMITE_DE_TEXTO} caracteres por mensagem.`);
      }
      message = { text: texto };
    } else if (envelope.kind === "image" && envelope.media && TIPOS_DE_FOTO.has(envelope.media.mime ?? "")) {
      message = { attachment: { type: "image", payload: { url: envelope.media.url } } };
    } else {
      throw new Error("instagram_tipo_nao_suportado: Por enquanto o Instagram aceita só texto e foto pelo CRM.");
    }

    const token = await resolveInstagramToken(envelope);
    if (!token) throw erroDoInstagram(190, "sem chave");

    await envelope.beforeSend?.();
    const res = await fetch(`${baseDoInstagram()}/${graphVersion()}/${encodeURIComponent(envelope.sessionRef)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: envelope.to },
        message,
        ...(envelope.etiquetaHumana ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { message_id?: string; error?: { code?: number; message?: string } };
    if (!res.ok || body.error) throw erroDoInstagram(body.error?.code ?? `http_${res.status}`, body.error?.message ?? `http_${res.status}`);
    return { externalId: body.message_id ?? null };
  },
```

Conferir o nome real do campo de mime em `OutboundMedia` (`mime` ou `mimeType`) em `lib/channels/types.ts` e usar o real, no código e no teste. Atualizar o comentário do topo do arquivo (etapa 2 envia). `codes.sendFailed` passa a `"instagram_erro_de_envio"`.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/canal-instagram-envio.test.ts tests/unit/canal-instagram-saude.test.ts tests/unit/canal-instagram-midia.test.ts && pnpm typecheck && pnpm lint:channels`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/channels lib/env.ts .env.example tests/unit/canal-instagram-envio.test.ts
git commit -m "feat(instagram): adapter envia texto e foto pela Graph API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: O handler de mensagens envia pelo Instagram

**Files:**
- Create: `supabase/migrations/20260925150000_0278_instagram_destinatario_da_conversa.sql`
- Modify: `supabase/baseline.sql` (apêndice), `supabase/migrations/MANIFEST.md`
- Modify: `lib/channels/instagram/ingest.ts` (grava `provider_conversation_id`)
- Modify: `lib/channels/capabilities.ts` (`meta_instagram.canSend: true`)
- Modify: `app/api/v1/messages/_handler.ts`
- Test: `tests/unit/mensagens-envio-instagram.test.ts` (novo); ajustar testes que afirmavam `canSend: false` do Instagram (`grep -rln "instagram_envio_indisponivel\|chega na próxima versão" tests lib app components`)

**Interfaces:**
- Consumes: Task 1 (`estadoDaJanela`, `capabilitiesOf(p).iaResponde`), Task 2 (`RecipientInput.providerConversationId`, `OutboundEnvelope.etiquetaHumana`).
- Produces:
  - Toda conversa `channel = 'instagram'` tem `provider_conversation_id` = IGSID do cliente (ingest novo + backfill).
  - Códigos de falha gravados em `messages.error_code`: `envio_automatico_indisponivel` (ator não humano em canal sem IA), `fora_da_janela` (janela fechada em canal com `janelaHumanaMs`), `instagram_sem_destinatario`.

- [ ] **Step 1: Migration + baseline + MANIFEST**

```sql
-- supabase/migrations/20260925150000_0278_instagram_destinatario_da_conversa.sql
-- O envio pelo Instagram endereça o CLIENTE pelo IGSID, que é por perfil
-- conectado. Guardá-lo na conversa (e não só na identidade do contato) mantém
-- o destinatário certo quando um contato tiver conversas em dois perfis.
-- Backfill idempotente: só preenche onde está vazio e a identidade é única.
update public.conversations c
   set provider_conversation_id = i.external_id
  from public.contact_channel_identities i
 where c.channel = 'instagram'
   and c.provider_conversation_id is null
   and i.organization_id = c.organization_id
   and i.contact_id = c.contact_id
   and i.channel = 'instagram'
   and (select count(*) from public.contact_channel_identities i2
         where i2.organization_id = c.organization_id and i2.contact_id = c.contact_id and i2.channel = 'instagram') = 1;
```

Acrescentar o MESMO bloco no fim de `supabase/baseline.sql`, rotulado `-- ---- destinatário das conversas do Instagram (migration 0278) ----`. Linha no MANIFEST: `| 0278 | instagram_destinatario_da_conversa | backfill de conversations.provider_conversation_id (IGSID) para o envio pelo Instagram |` seguindo o formato das linhas vizinhas.

- [ ] **Step 2: Ingest grava o IGSID na conversa**

Em `lib/channels/instagram/ingest.ts`, logo depois de obter o id da conversa (retorno de `fn_upsert_conversa_de_canal`), gravar quando vazio:

```ts
  await admin
    .from("conversations")
    .update({ provider_conversation_id: pessoa })
    .eq("organization_id", orgId)
    .eq("id", conversationId)
    .is("provider_conversation_id", null);
```

`pessoa` é o IGSID do cliente (remetente no inbound, destinatário no eco), a mesma variável já usada para a identidade. Acrescentar o caso ao teste de ingestão existente (o update é chamado com o IGSID do cliente, inclusive no eco).

- [ ] **Step 3: Teste do handler que falha**

Escrever `tests/unit/mensagens-envio-instagram.test.ts` seguindo o padrão de mocks do teste de handler de mensagens que já existe (`grep -ln "sendMessageHandler" tests/unit | head`; copie o arranjo de Supabase falso e adapter falso de lá). Casos, cada um afirmando o `status`/`error_code` gravado e o envelope entregue ao adapter:

1. Ator `user`, conversa instagram, `last_inbound_at` há 2h, `provider_conversation_id = "IGSID-1"` → adapter recebe `to: "IGSID-1"`, `etiquetaHumana` falsy; mensagem `sent` com `external_id` devolvido.
2. Igual, `last_inbound_at` há 3 dias → `etiquetaHumana: true`.
3. Igual, `last_inbound_at` há 8 dias → adapter NÃO chamado; `failed`, `error_code: "fora_da_janela"`, `error_message` = texto verbatim dos 7 dias.
4. `last_inbound_at` nulo → `failed`, `fora_da_janela`.
5. Ator `ai_agent` (e outro com ator de sistema/follow-up, o tipo que `lib/followup/enviar-texto-fixo.ts` usa) → adapter NÃO chamado; `failed`, `error_code: "envio_automatico_indisponivel"`; o handler retorna normalmente (não lança).
6. `provider_conversation_id` nulo → `failed`, `error_code: "instagram_sem_destinatario"`, nunca `queued`.
7. Duas conversas do MESMO contato com IGSIDs diferentes → cada envio sai para o IGSID da sua conversa.
8. WhatsApp oficial (`meta_cloud`) fora das 24h segue o comportamento de hoje (este guard não se aplica: `janelaHumanaMs` nulo).

Run: `pnpm vitest run tests/unit/mensagens-envio-instagram.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implementar no handler**

Em `app/api/v1/messages/_handler.ts`:

a) No `select` da conversa (≈linha 313) acrescentar `last_inbound_at` e `channel` (se ainda não vierem). `provider_conversation_id` já vem.

b) Na chamada `adapter.resolveRecipient({...})` (≈599-605) acrescentar `providerConversationId: c.provider_conversation_id`.

c) Trocar o guard de `canSend` (≈646-662) por esta sequência, mantendo o mesmo jeito de gravar `failed` que o bloco atual usa (reaproveite o helper/trecho existente, não duplique a escrita):

```ts
  const caps = capabilitiesOf(provider);
  if (!caps.canSend) {
    // (bloco atual, sem mudança)
  }
  if (!caps.iaResponde && ctx.actor.type !== "user") {
    return falharAntesDeEnviar("envio_automatico_indisponivel", "Este canal só aceita resposta da equipe.");
  }
  let etiquetaHumana = false;
  if (caps.janelaHumanaMs !== null) {
    const janela = estadoDaJanela(provider, c.last_inbound_at, new Date());
    if (janela.tipo === "fechada") {
      return falharAntesDeEnviar(
        "fora_da_janela",
        "A Meta só deixa responder até 7 dias depois da última mensagem dessa pessoa. Responda pelo app do Instagram se ela escrever de novo.",
      );
    }
    etiquetaHumana = janela.tipo === "humana";
  }
```

`falharAntesDeEnviar(code, message)` é o nome para o trecho que o bloco `canSend` já usa para gravar `status: "failed"` e retornar; extraia-o para uma função local se hoje estiver inline, e faça o bloco `canSend` usá-la também.

d) Onde `chatId` é nulo (≈673-684): se `provider` é o do Instagram (`!caps.iaResponde` não serve de proxy; use `caps.janelaHumanaMs !== null` ou compare com `CHANNEL_PROVIDER_INSTAGRAM` importado de `lib/channels`), gravar `error_code: "instagram_sem_destinatario"` em vez de `missing_phone_number`. Prefira importar `CHANNEL_PROVIDER_INSTAGRAM` (o nome do provider fica em `lib/channels`).

e) Em todos os `adapter.send({...})` do arquivo (texto e mídia), acrescentar `etiquetaHumana` ao envelope.

f) `lib/channels/capabilities.ts`: `meta_instagram.canSend: true`.

g) `components/inbox/InboxLayout.tsx`: o `motivoSemEnvio` continua existindo (vale para qualquer canal futuro com `canSend: false`), mas o texto específico do Instagram sai. Troque por `t("Este canal ainda não envia pelo CRM; responda pelo app dele por enquanto.")` com entrada `es`, e remova a entrada antiga do dicionário se ficar sem uso.

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/mensagens-envio-instagram.test.ts && pnpm typecheck && pnpm lint:channels && pnpm test:db`
Expected: PASS (o `test:db` prova a 0278 no baseline em install e update).

- [ ] **Step 6: Commit**

```bash
git add supabase lib app components tests
git commit -m "feat(instagram): a equipe responde pelo Inbox, com janela de 24h e 7 dias

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: IA fora do Instagram, ritmo e avisos com o nome certo

**Files:**
- Modify: `workers/ai-response-worker.ts` (`buildContext`)
- Modify: `app/api/v1/ai/pacing/route.ts`
- Modify: `lib/channels/health.ts` (`avisoDaConexao`, `sincronizarSaudeDaConexao`)
- Modify: `lib/channels/capabilities.ts` ou `lib/channels/index.ts` (helper `nomeDoCanal`)
- Test: `tests/unit/ia-nao-responde-instagram.test.ts` (novo), e o teste existente de `avisoDaConexao` (`grep -ln avisoDaConexao tests`)

**Interfaces:**
- Consumes: Task 1 (`iaResponde`, `providersDeEnvioAutomatico`).
- Produces: `nomeDoCanal(provider: string | null | undefined): "WhatsApp" | "Instagram"` em `lib/channels` (Instagram para `meta_instagram`, WhatsApp para o resto); `avisoDaConexao(saude, apelido, provider?)`.

- [ ] **Step 1: Testes que falham**

1. IA: `processMessageReceived` (ou `buildContext`) com conversa cuja sessão é `meta_instagram` devolve `skip` com motivo `"canal_sem_ia"` e não chama o modelo. Siga o arranjo do teste existente do worker (`grep -ln "processMessageReceived\|buildContext" tests/unit | head -3`).
2. Ritmo: a rota de pacing consulta `channel_sessions` com a lista de `providersDeEnvioAutomatico()` (não contém `meta_instagram`).
3. Aviso: `avisoDaConexao({ reachable: true, status: "FAILED", ... }, "Instagram @clinica", "meta_instagram")` tem título que NÃO contém "WhatsApp" nem "QR"; o mesmo sem `provider` (ou `waha`) continua igual ao de hoje.

Run: `pnpm vitest run <os três arquivos>` → FAIL.

- [ ] **Step 2: Implementar**

- `workers/ai-response-worker.ts`: no `select` de `buildContext` (≈606-609) acrescentar `channel_sessions:channel_session_id(provider)`; logo depois do select, antes de `if (!c.contacts)`:

```ts
  const provider = (c.channel_sessions as { provider?: string } | null)?.provider;
  if (provider && !capabilitiesOf(provider as ChannelProvider).iaResponde) return skip("canal_sem_ia");
```

(use o `skip()` do arquivo e o tipo de motivo que ele aceita; acrescente `"canal_sem_ia"` à união se for tipada).
- `app/api/v1/ai/pacing/route.ts`: trocar `[...PROVIDERS_DE_MENSAGEM]` por `providersDeEnvioAutomatico()`.
- `lib/channels/health.ts`: `avisoDaConexao(saude, apelido, provider?: string | null)`. Nos três títulos que dizem "WhatsApp", usar `nomeDoCanal(provider)`. O ramo "desconectado, escanear o QR" só vale quando o canal é WhatsApp; para Instagram o título é `Instagram "${apelido}" desconectado, reconecte em Conexões`. `sincronizarSaudeDaConexao` repassa o provider da sessão (confira o campo em `SessaoParaVigiar`; se não tiver, acrescente e preencha nos chamadores, incluindo `lib/channels/instagram/renovacao.ts`).

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm vitest run <os três arquivos> && pnpm typecheck && pnpm lint:channels`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add workers app/api/v1/ai/pacing lib/channels tests/unit
git commit -m "fix(instagram): IA fora do Instagram e avisos sem falar em WhatsApp

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: O nome da pessoa aparece

**Files:**
- Modify: `lib/channels/instagram/ingest.ts`
- Create: `lib/channels/instagram/perfil-do-contato.ts`
- Modify: `lib/channels/instagram/renovacao.ts` (rodada diária também preenche nomes)
- Test: `tests/unit/instagram-perfil-do-contato.test.ts` (novo), teste de ingestão existente

**Interfaces:**
- Produces:

```ts
// lib/channels/instagram/perfil-do-contato.ts
export const INTERVALO_ENTRE_TENTATIVAS_MS = 24 * 60 * 60 * 1000;

/** Deve buscar o perfil agora? Identidade nova sempre; contato sem nome, no máximo 1×/24h. */
export function deveBuscarPerfil(input: {
  identidadeNova: boolean;
  nomeAtual: string | null;
  tentadoEm: string | null; // contacts.source_metadata.perfil_tentado_em
  agora: Date;
}): boolean;

/**
 * Busca o perfil e preenche SÓ o que está vazio em contacts
 * (display_name ← nome ?? @handle; source_metadata.handle), e marca perfil_tentado_em.
 * Best-effort: nunca lança.
 */
export async function preencherPerfilDoContato(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string; igsid: string; token: string; agora: Date },
): Promise<"preenchido" | "sem_perfil">;
```

- [ ] **Step 1: Testes que falham**

```ts
// tests/unit/instagram-perfil-do-contato.test.ts (parte pura)
import { describe, expect, it } from "vitest";
import { deveBuscarPerfil } from "@/lib/channels/instagram/perfil-do-contato";

const agora = new Date("2026-09-25T12:00:00Z");
const H = 3_600_000;

describe("deveBuscarPerfil", () => {
  it("identidade nova sempre busca", () => {
    expect(deveBuscarPerfil({ identidadeNova: true, nomeAtual: "Ana", tentadoEm: null, agora })).toBe(true);
  });
  it("contato com nome não busca", () => {
    expect(deveBuscarPerfil({ identidadeNova: false, nomeAtual: "Ana", tentadoEm: null, agora })).toBe(false);
  });
  it("sem nome e nunca tentou, busca", () => {
    expect(deveBuscarPerfil({ identidadeNova: false, nomeAtual: null, tentadoEm: null, agora })).toBe(true);
  });
  it("sem nome, tentou há 2h, não busca", () => {
    expect(deveBuscarPerfil({ identidadeNova: false, nomeAtual: null, tentadoEm: new Date(agora.getTime() - 2 * H).toISOString(), agora })).toBe(false);
  });
  it("sem nome, tentou há 25h, busca", () => {
    expect(deveBuscarPerfil({ identidadeNova: false, nomeAtual: null, tentadoEm: new Date(agora.getTime() - 25 * H).toISOString(), agora })).toBe(true);
  });
});
```

Mais casos de `preencherPerfilDoContato` com Supabase falso e `perfilDoRemetente` mockado: (a) perfil com nome preenche `display_name` com o nome e grava `perfil_tentado_em`; (b) só handle preenche `display_name = "@handle"`; (c) perfil vazio grava só `perfil_tentado_em` e devolve `"sem_perfil"`; (d) o update de `display_name` é condicionado a `display_name is null` (confira que o `.is("display_name", null)` está na chamada).

No teste de ingestão: eco como primeira mensagem de um contato novo chama a busca de perfil (hoje não chama); segunda mensagem de contato sem nome, 1h depois da tentativa, não chama.

Run: `pnpm vitest run tests/unit/instagram-perfil-do-contato.test.ts <teste de ingestão>` → FAIL.

- [ ] **Step 2: Implementar**

- `perfil-do-contato.ts` com as duas funções acima. `preencherPerfilDoContato` chama `perfilDoRemetente(token, igsid)`; o update de `contacts` usa `.eq("organization_id", ...)`, `.eq("id", contactId)`, `.is("display_name", null)` para o nome, e um update separado que mescla `source_metadata` (ler, mesclar `perfil_tentado_em` e `handle` se vazio, gravar), como o merge de `custom_fields` já feito em `ingest.ts`. Também atualiza a identidade (`contact_channel_identities`: handle/display_name/avatar_url só onde vazio).
- `ingest.ts`: depois do upsert do contato, ler `display_name` e `source_metadata` do contato; se `deveBuscarPerfil(...)` (com `identidadeNova` = não existia identidade antes), decifrar o token e chamar `preencherPerfilDoContato`. Isso vale para inbound E eco. Remover a busca antiga que só acontecia sem identidade, para não buscar duas vezes. O upsert passa a receber perfil nulo (a função SQL segue igual).
- `renovacao.ts`: ao fim da rodada por sessão (token válido em mãos), preencher até 50 contatos sem nome daquela sessão:

```ts
const { data: semNome } = await admin
  .from("conversations")
  .select("contact_id, provider_conversation_id, contacts:contact_id!inner(display_name, source_metadata)")
  .eq("organization_id", sessao.organization_id)
  .eq("channel_session_id", sessao.id)
  .not("provider_conversation_id", "is", null)
  .is("contacts.display_name", null)
  .limit(50);
```

Para cada linha que `deveBuscarPerfil` aprovar (`identidadeNova: false`), chamar `preencherPerfilDoContato`. Conte quantos foram preenchidos no resumo da rodada (campo novo `nomesPreenchidos` em `ResumoDaRenovacao`); a rota do cron já audita só quando houve efeito, então preencher nome conta como efeito.

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/instagram-perfil-do-contato.test.ts <teste de ingestão> <teste da renovação> && pnpm typecheck && pnpm lint:channels`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/channels/instagram tests/unit
git commit -m "fix(instagram): busca o nome de quem ficou sem nome, inclusive depois do eco

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Compositor e selo da janela no Instagram

**Files:**
- Modify: `components/inbox/InboxLayout.tsx` (motivo da janela, limite, mídia)
- Modify: `components/inbox/Composer.tsx` (limite de texto, só foto, sem gravador de áudio)
- Modify: `components/inbox/composer/AttachMenu.tsx` (prop `soFoto`)
- Modify: `components/inbox/JanelaSelo.tsx` (estado `humana`)
- Modify: `lib/i18n/dicionario.ts`
- Test: `tests/unit/composer-instagram.test.tsx` (novo), `tests/unit/janela-de-atendimento.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`EstadoDaJanela` com `humana` e `regra`; capabilities `limiteDeTexto`, `midiaDeEnvio`).
- Produces: props novas em `Composer`: `limiteDeTexto?: number | null`, `soFoto?: boolean`. Em `AttachMenu`: `soFoto?: boolean`.

- [ ] **Step 1: Testes que falham** (React Testing Library, como os testes vizinhos de `components/inbox`)

1. `JanelaSelo` com `{ tipo: "humana", restanteMs: 4 dias }` mostra "Resposta da equipe até 4d" (use `formatarDecorrido(restanteMs)` para o número).
2. `JanelaSelo` com `{ tipo: "fechada", regra: "sete_dias", ... }` mostra "Fora do prazo do Instagram".
3. Composer com `limiteDeTexto={1000}` e 1001 caracteres digitados: botão enviar desabilitado e contador "1001/1000" visível; com 999, contador visível e envio liberado; sem `limiteDeTexto`, nenhum contador.
4. Composer com `soFoto`: o botão do microfone não aparece; o menu "+" mostra só "Fotos" e o input tem `accept="image/jpeg,image/png"`; sem Documento nem Contato.

Run: `pnpm vitest run tests/unit/composer-instagram.test.tsx tests/unit/janela-de-atendimento.test.tsx` → FAIL.

- [ ] **Step 2: Implementar**

- `JanelaSelo.tsx`: estado `humana` desenha o mesmo selo da `aberta` com texto `${t("Resposta da equipe até")} ${formatarDecorrido(restanteMs)}` e title `t("Passou de 24h: só a equipe responde, até 7 dias depois da última mensagem da pessoa.")`. `fechada` com `regra: "sete_dias"` mostra `t("Fora do prazo do Instagram")`.
- `InboxLayout.tsx`: `motivoDaJanela` para `fechada` com `regra === "sete_dias"` usa o texto verbatim dos 7 dias; `regra === "modelo"` mantém os textos atuais. Estado `humana` não bloqueia. Passar ao `Composer` `limiteDeTexto={caps?.limiteDeTexto ?? null}` e `soFoto={caps?.midiaDeEnvio === "so_foto"}`, com `caps` vindo de `capabilitiesOf` do provider da conversa (protegido para provider nulo/desconhecido: sem provider, `null`/`false`).
- `Composer.tsx`: contador `"{n}/{limite}"` abaixo do campo quando `limiteDeTexto` existe; envio desabilitado acima do limite (inclui Enter). `soFoto` esconde o gravador de áudio e repassa `soFoto` ao `AttachMenu`.
- `AttachMenu.tsx`: `soFoto` mostra só a opção de fotos, rotulada `t("Fotos")`, com `accept="image/jpeg,image/png"`.
- Dicionário: entradas `es` para todo texto novo.

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/composer-instagram.test.tsx tests/unit/janela-de-atendimento.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components lib/i18n tests/unit
git commit -m "feat(inbox): compositor do Instagram com prazo de 7 dias, limite e só foto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Selo de canal na lista e no cabeçalho

**Files:**
- Modify: `app/globals.css` (tokens `--color-canal-instagram`, `--color-canal-whatsapp` nos três blocos + ponte no `@theme inline`)
- Modify: `lib/ui/icons.ts` (reexportar `WhatsappLogo` do phosphor, se ainda não estiver)
- Create: `components/inbox/SeloDoCanal.tsx`
- Modify: `components/inbox/ConversationListItem.tsx`, `components/inbox/ConversationHeader.tsx`
- Test: `tests/unit/selo-do-canal.test.tsx` (novo); `tests/unit/tailwind-tokens.test.ts` tem de continuar verde

**Interfaces:**
- Produces: `SeloDoCanal({ canal, tamanho }: { canal: "whatsapp" | "instagram"; tamanho: "pequeno" | "grande" })` com `aria-label` "Instagram" / "WhatsApp".

- [ ] **Step 1: Teste que falha**

```tsx
// tests/unit/selo-do-canal.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SeloDoCanal } from "@/components/inbox/SeloDoCanal";

describe("SeloDoCanal", () => {
  it("Instagram tem rótulo e cor próprios", () => {
    render(<SeloDoCanal canal="instagram" tamanho="pequeno" />);
    const selo = screen.getByLabelText("Instagram");
    expect(selo.className).toContain("bg-canal-instagram");
  });
  it("WhatsApp tem rótulo e cor próprios", () => {
    render(<SeloDoCanal canal="whatsapp" tamanho="pequeno" />);
    expect(screen.getByLabelText("WhatsApp").className).toContain("bg-canal-whatsapp");
  });
});
```

Acrescentar em teste de `ConversationListItem` (existente ou novo): item com `channel: "instagram"` renderiza `getByLabelText("Instagram")`; com `channel: "whatsapp"` renderiza `getByLabelText("WhatsApp")`; a bolinha de comando (`COR_DO_COMANDO`) continua no canto inferior direito.

Run: `pnpm vitest run tests/unit/selo-do-canal.test.tsx` → FAIL.

- [ ] **Step 2: Implementar**

- Tokens: `--color-canal-instagram: #d62976;` e `--color-canal-whatsapp: #25a244;` em `:root` e `[data-theme="light"]`; no escuro `#e1306c` e `#2fbf55`. Na ponte `@theme inline`, `--color-canal-instagram: var(--color-canal-instagram);` seguindo o padrão exato dos tokens vizinhos (confira como `--color-bg` faz a ponte e copie). Nome de classe resultante: `bg-canal-instagram`, `text-canal-instagram`.
- `SeloDoCanal.tsx`: círculo com fundo do token e ícone branco (`InstagramLogo` ou `WhatsappLogo`, `weight="fill"`). `pequeno` = `h-4 w-4` com ícone 10; `grande` = `h-5 w-5` com ícone 13. Borda `border-2 border-background` para destacar sobre a foto. `role="img"` e `aria-label`.
- Lista (`ConversationListItem.tsx`): selo `pequeno` no canto INFERIOR ESQUERDO do avatar (`absolute -bottom-0.5 -left-0.5`), porque o direito é da bolinha de comando. `canal = conversation.channel === "instagram" ? "instagram" : "whatsapp"`. A etiqueta "via @conta" do Instagram ganha `bg-canal-instagram/10 text-canal-instagram border-canal-instagram/30`; a etiqueta de telefone do WhatsApp ganha o mesmo com `canal-whatsapp`.
- Cabeçalho (`ConversationHeader.tsx`): selo `grande` antes do nome da pessoa; o "via @conta" e o telefone com as mesmas cores da lista.

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/selo-do-canal.test.tsx tests/unit/tailwind-tokens.test.ts <teste do item> && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/globals.css lib/ui/icons.ts components/inbox tests/unit
git commit -m "design(inbox): selo e cor de canal separam Instagram de WhatsApp

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Filtro "Só Instagram" e "Só WhatsApp"

**Files:**
- Modify: `components/inbox/InboxFilters.tsx`
- Modify: `lib/schemas/messaging.ts` (schema da listagem, ≈linha 316)
- Modify: `app/api/v1/conversations/_handler.ts` (≈linha 197)
- Modify: `hooks/inbox/useConversationsRealtime.ts`, `hooks/inbox/useConversationCounts.ts` (querystring)
- Modify: `lib/i18n/dicionario.ts`
- Test: `tests/unit/inbox-filtro-canal.test.ts(x)` (novo)

**Interfaces:**
- Produces: `InboxFiltersValue.canal?: "instagram" | "whatsapp"`; parâmetro de listagem `canal` (`z.enum(["instagram", "whatsapp"]).optional()`); filtro `query.eq("channel", q.canal)`.

- [ ] **Step 1: Testes que falham**

1. Handler de listagem com `canal: "instagram"` aplica `.eq("channel", "instagram")` (siga o arranjo do teste existente do handler de conversas: `grep -ln "conversations/_handler" tests/unit | head -3`).
2. `InboxFilters`: escolher "Só Instagram" chama `onChange` com `canal: "instagram"` e `channel_session_id: undefined`; escolher um número específico limpa `canal`; "Todos os números" limpa os dois.
3. Os hooks mandam `canal` na querystring quando definido (mesmo padrão de `channel_session_id`).

Run → FAIL.

- [ ] **Step 2: Implementar**

No `Select` do canal, o valor passa a codificar os dois filtros: `"all"`, `"canal:instagram"`, `"canal:whatsapp"` ou o id da sessão. Itens novos logo depois de "Todos os números": `t("Só Instagram")` e `t("Só WhatsApp")`. `onValueChange`:

```ts
(v) => {
  if (v === "all") return onChange({ ...value, channel_session_id: undefined, canal: undefined });
  if (v.startsWith("canal:")) return onChange({ ...value, channel_session_id: undefined, canal: v.slice(6) as "instagram" | "whatsapp" });
  onChange({ ...value, channel_session_id: v, canal: undefined });
}
```

`value` do Select: `value.canal ? \`canal:${value.canal}\` : value.channel_session_id ?? "all"`. O destaque visual de filtro ativo vale também para `canal`. Schema, handler e hooks conforme Interfaces. Entradas `es`.

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm vitest run <testes da task> tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/inbox lib hooks app/api/v1/conversations tests/unit
git commit -m "feat(inbox): filtro por canal, só Instagram ou só WhatsApp

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Prova pela tela, CI e entrega

**Files:**
- Create: `tests/e2e/instagram-responder.spec.ts`
- Modify: `scripts/seed-e2e-instagram.ts` (conversa com `provider_conversation_id`, uma recente e uma de 8 dias, e uma conversa de WhatsApp para o filtro)
- Modify: `.github/workflows/e2e.yml` (spec nova numa `SPECS_PARTE_*`, a mesma parte da `instagram-receber.spec.ts`)
- Modify: `docs/testing/user-journey-map.md` (casos da jornada "responder pelo Instagram")
- Create: `.changes/instagram-direct-responder.md`
- Modify: `docs/superpowers/specs/2026-09-24-instagram-direct-no-crm-design.md` (§5.5 aponta para a spec da etapa 2)

- [ ] **Step 1: Receptor local e spec**

A spec sobe um servidor HTTP local (Node `http.createServer`) numa porta livre ANTES do app; o app do e2e roda com `INSTAGRAM_GRAPH_BASE_URL=http://127.0.0.1:<porta>` (confira como `instagram-receber.spec.ts` e a config do Playwright passam env ao servidor; se a porta precisar ser fixa, use `47811` e declare no `playwright.config`/workflow). O receptor responde `POST /<versao>/<ig_account_id>/messages` com `{ "recipient_id": "<igsid>", "message_id": "mid.e2e.<n>" }` e guarda os corpos recebidos.

Casos, dirigindo a tela logado como a conta de teste:
1. Abrir o Inbox, filtro "Só Instagram": só conversas com selo Instagram; "Só WhatsApp": só com selo WhatsApp.
2. Abrir a conversa recente do Instagram, digitar "Olá, tudo bem?", enviar: a bolha aparece como enviada, e o receptor recebeu `{ recipient: { id: <igsid do seed> }, message: { text: "Olá, tudo bem?" } }` sem `tag`.
3. Abrir a conversa de 8 dias: compositor bloqueado com o texto verbatim dos 7 dias; selo "Fora do prazo do Instagram".
4. Na conversa recente, o menu "+" mostra só "Fotos" e não há microfone.
Screenshots em `.superpowers/evidence/instagram-responder/`.

- [ ] **Step 2: Rodar**

Run: `pnpm test:e2e tests/e2e/instagram-responder.spec.ts tests/e2e/instagram-receber.spec.ts` (ambiente fresco conforme `CLAUDE.md`: baseline pg15 + `next build && next start`)
Expected: PASS nas duas.

- [ ] **Step 3: Fragmento de release (curto, o changelog tem limite de tamanho na tela da VPS)**

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: Responder o Instagram pelo Inbox
---
Até 7 dias depois da última mensagem.
```

Run: `pnpm release:conferir` → ok; `pnpm vitest run tests/unit/changelog-cabe-na-tela-da-vps.test.ts` → PASS.

- [ ] **Step 4: Suíte inteira e gates**

```bash
pnpm typecheck && pnpm lint && pnpm lint:channels
pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests |Errors " /tmp/vt.log | tail -3
pnpm test:db
```

Expected: exit 0 nos três; falha local conhecida de iCloud/Redis é conferida contra o CI, não ignorada.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e scripts .github docs .changes
git commit -m "test(instagram): prova pela tela de responder, filtrar e bloquear depois de 7 dias

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Depois do merge (fora do plano de código, com o André)

1. Deploy na VPS: backup → `git pull --ff-only` → aplicar `supabase/baseline.sql` (tem a 0278) ANTES do `up -d` → `pull` + `up -d app worker scheduler` → conferir 307 e versão no `/api/v1/health`.
2. Prova real: responder um Direct de teste pelo CRM nos dois perfis, dentro de 24h. Depois, numa conversa entre 24h e 7 dias, conferir se a Meta aceita a tag `HUMAN_AGENT`; se recusar, abrir ajuste para `janelaHumanaMs: null` até a aprovação (spec §7).
3. Conferir no dia seguinte, depois do cron de renovação, que os contatos "Contato do Instagram" ganharam nome ou @.
