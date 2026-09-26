# Instagram Direct, etapa 3: follow-ups e contato único. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Follow-up automático no Instagram só dentro das 24h (passo fora disso é pulado e o fluxo segue), follow-up preferindo WhatsApp, junção automática de contatos com o mesmo @, sugestão Instagram × WhatsApp por nome, e a ficha do contato mostrando os canais.

**Architecture:** Uma capability nova (`janelaAutomaticaMs`) diz quanto tempo depois da última mensagem da pessoa o envio automático pode sair; a regra mora em `lib/channels/janela.ts` e é lida pelo servidor de mensagens (recusa) e pelo motor de follow-up (pula e segue). A escolha da conversa do follow-up passa o `p_session` que `fn_service_begin` já aceita. A junção por @ reusa `fn_mesclar_contatos` (service role pode executar) com auditoria própria.

**Tech Stack:** Next.js 16, TypeScript estrito, Supabase Postgres, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-26-instagram-direct-etapa-3-design.md`

**Worktree:** `/Users/andreluislopescosta/CRM-EVA/wt-instagram-direct`, branch `feat/instagram-direct-etapa-3`.

## Global Constraints

- Nome de provider (`meta_instagram`, `waha`, `meta_cloud`…) só dentro de `lib/channels/` (`pnpm lint:channels`); fora dali, decida por capability ou pelas constantes exportadas de `lib/channels`. O valor de coluna `conversations.channel` (`"instagram"`, `"whatsapp"`) pode aparecer fora.
- Follow-up no Instagram só sai até 24h depois da última mensagem RECEBIDA da pessoa (`conversations.last_inbound_at`); `last_inbound_at` nulo = não sai. Sem tag `HUMAN_AGENT` em envio automático.
- Passo fora das 24h é PULADO e a inscrição avança para o próximo nó. Nunca cancela a sequência, nunca reagenda, nunca reenvia.
- Motivo do pulo (verbatim): `fora_das_24h_do_instagram`; texto legível (verbatim): "Passo pulado: fora das 24h do Instagram."
- A IA de atendimento continua sem responder no Instagram. Envio automático que não é follow-up continua recusado (`envio_automatico_indisponivel`).
- Conversa do follow-up: a 1:1 mais recente de canal `whatsapp`; se não houver, a 1:1 mais recente de `instagram`. Conversas de grupo nunca.
- Junção automática só entre identidades de Instagram com o mesmo @ (sem diferenciar maiúsculas), principal = contato mais antigo (`created_at`), via `fn_mesclar_contatos`, auditada (`contact.merged`). Nunca junta por nome sozinho.
- Sugestão por nome: contato com identidade de Instagram e sem telefone × contato com telefone, nome normalizado igual (minúsculas, sem acento, espaços colapsados), nome com pelo menos duas palavras. Rótulo (verbatim): "mesmo nome no Instagram e no WhatsApp".
- Service role sempre filtra `organization_id`. Cron audita só quando teve efeito.
- Texto de tela novo com `t()` ganha entrada `es` em `lib/i18n/dicionario.ts`; sem travessão (—) em texto de tela novo.
- Nunca `git stash`; nunca `git add -A`; commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Contato do Instagram em que a pessoa nunca escreveu (só eco do celular, `last_inbound_at` nulo): follow-up não sai e o passo é pulado, sem erro. Teste nas Tasks 1 e 3.
2. Contato com conversa de GRUPO no WhatsApp e conversa 1:1 no Instagram: o follow-up vai para o Instagram (grupo não conta). Teste na Task 2.
3. Recusa do servidor por `fora_das_24h_do_instagram` depois que o motor já decidiu enviar (corrida de minutos): vira passo pulado, não `job_dead` nem reenvio. Teste na Task 3.
4. @ com maiúsculas diferentes (`Maria.Silva` e `maria.silva`) junta; @ nulo nunca junta; contato já absorvido (`is_merged_into` preenchido) é ignorado. Teste na Task 4.
5. Nome de uma palavra só ("Ana") e nomes iguais só depois de tirar acento ("José Souza" × "Jose Souza") no par Instagram × WhatsApp. Teste na Task 5.

---

### Task 1: Janela do envio automático e o servidor de mensagens

**Files:**
- Modify: `lib/channels/types.ts` (`ChannelCapabilities`)
- Modify: `lib/channels/capabilities.ts` (todas as entradas)
- Modify: `lib/channels/janela.ts`
- Modify: `lib/api/handlers/types.ts` (`HandlerCtx.origemDoEnvio`)
- Modify: `app/api/v1/messages/_handler.ts` (guarda ≈611-660)
- Modify: `lib/followup/enviar-texto-fixo.ts` e `lib/agent-engine/edge/crm/send-message.ts` (passar `origemDoEnvio: "followup"` quando o envio é de follow-up)
- Test: `tests/unit/janela-automatica-instagram.test.ts` (novo), `tests/unit/mensagens-envio-instagram.test.ts` (acrescentar casos)

**Interfaces:**
- Produces:
  - `ChannelCapabilities.janelaAutomaticaMs: number | null` (`WINDOW_MS` = 24h em `meta_instagram`; `null` nos outros)
  - `fimDaJanelaAutomatica(provider: string | null | undefined, lastInboundAt: string | null): Date | null` em `lib/channels/janela.ts` (`null` = canal sem essa regra; para o Instagram com `lastInboundAt` nulo devolve `new Date(0)`, isto é, já vencida)
  - `automaticoPodeEnviar(provider, lastInboundAt, agora: Date): boolean` (true quando o canal não tem a regra ou `agora < fim`)
  - `HandlerCtx.origemDoEnvio?: "followup"`
  - Código de recusa `fora_das_24h_do_instagram` com mensagem "Passo pulado: fora das 24h do Instagram."

- [ ] **Step 1: Testes que falham**

```ts
// tests/unit/janela-automatica-instagram.test.ts
import { describe, expect, it } from "vitest";
import { automaticoPodeEnviar, fimDaJanelaAutomatica } from "@/lib/channels/janela";
import { capabilitiesOf } from "@/lib/channels/capabilities";

const H = 3_600_000;
const agora = new Date("2026-09-26T12:00:00Z");
const ha = (ms: number) => new Date(agora.getTime() - ms).toISOString();

describe("janela do envio automático", () => {
  it("Instagram: 23h pode, 24h exatas não", () => {
    expect(automaticoPodeEnviar("meta_instagram", ha(23 * H), agora)).toBe(true);
    expect(automaticoPodeEnviar("meta_instagram", ha(24 * H), agora)).toBe(false);
  });
  it("Instagram sem mensagem da pessoa nunca pode", () => {
    expect(automaticoPodeEnviar("meta_instagram", null, agora)).toBe(false);
    expect(fimDaJanelaAutomatica("meta_instagram", null)).toEqual(new Date(0));
  });
  it("fim é a última mensagem + 24h", () => {
    expect(fimDaJanelaAutomatica("meta_instagram", ha(2 * H))).toEqual(new Date(agora.getTime() + 22 * H));
  });
  it("WhatsApp não tem essa regra", () => {
    expect(fimDaJanelaAutomatica("waha", ha(48 * H))).toBeNull();
    expect(automaticoPodeEnviar("waha", ha(48 * H), agora)).toBe(true);
    expect(capabilitiesOf("meta_cloud").janelaAutomaticaMs).toBeNull();
  });
});
```

Em `tests/unit/mensagens-envio-instagram.test.ts`, acrescentar (seguindo o arranjo do arquivo):
1. ator `webhook_source` com `origemDoEnvio: "followup"`, Instagram, `last_inbound_at` há 2h → adapter chamado, `etiquetaHumana` falsy, mensagem `sent`.
2. mesmo, `last_inbound_at` há 30h → adapter NÃO chamado; `failed`, `error_code: "fora_das_24h_do_instagram"`.
3. ator `ai_agent` com `origemDoEnvio: "followup"`, 2h → envia.
4. ator `ai_agent` SEM `origemDoEnvio`, 2h → `envio_automatico_indisponivel` (comportamento de hoje).
5. WhatsApp com `origemDoEnvio: "followup"` → sem mudança.

Run: `pnpm vitest run tests/unit/janela-automatica-instagram.test.ts tests/unit/mensagens-envio-instagram.test.ts` → FAIL.

- [ ] **Step 2: Implementar**

- `types.ts`/`capabilities.ts`: campo `janelaAutomaticaMs` com comentário ("até quando, depois da última mensagem recebida, um envio AUTOMÁTICO pode sair; `null` = sem regra própria"), `WINDOW_MS` no Instagram, `null` nos outros.
- `janela.ts`:

```ts
export function fimDaJanelaAutomatica(provider: string | null | undefined, lastInboundAt: string | null): Date | null {
  if (!provider) return null;
  const ms = capabilitiesOf(provider as ChannelProvider).janelaAutomaticaMs;
  if (ms === null) return null;
  if (!lastInboundAt) return new Date(0);
  return new Date(new Date(lastInboundAt).getTime() + ms);
}

export function automaticoPodeEnviar(provider: string | null | undefined, lastInboundAt: string | null, agora: Date): boolean {
  const fim = fimDaJanelaAutomatica(provider, lastInboundAt);
  return fim === null || agora.getTime() < fim.getTime();
}
```

- `HandlerCtx`: `origemDoEnvio?: "followup"` com comentário (marca explícita; não se deduz do tipo de ator porque o agente de atendimento também é `ai_agent`).
- `_handler.ts`, no bloco da recusa: trocar

```ts
if (!caps.iaResponde && ctx.actor.type !== "user") {
  recusa = { code: "envio_automatico_indisponivel", ... };
}
```

por

```ts
if (!caps.iaResponde && ctx.actor.type !== "user") {
  if (ctx.origemDoEnvio !== "followup" || caps.janelaAutomaticaMs === null) {
    recusa = { code: "envio_automatico_indisponivel", /* mensagem de hoje */ };
  } else if (!automaticoPodeEnviar(provider, c.last_inbound_at, new Date())) {
    recusa = { code: "fora_das_24h_do_instagram", message: "Passo pulado: fora das 24h do Instagram." };
  }
  // dentro das 24h: segue, sem etiqueta humana
} else if (caps.janelaHumanaMs !== null) {
  // (bloco de hoje, sem mudança)
}
```

(adapte aos nomes reais do bloco; o formato do objeto `recusa` é o que já existe).
- `enviar-texto-fixo.ts`: no `ctx` de `sendMessageHandler`, `origemDoEnvio: "followup"`.
- `send-message.ts` (edge do agente): passar `origemDoEnvio: "followup"` SÓ quando o turno é de follow-up. Descubra como o turno de follow-up (`lib/agent-engine/agent/followup-turn.ts`) chama esta edge e faça o sinal chegar por parâmetro explícito dessa chamada (não por variável global); o turno de atendimento (inbound) não passa nada.

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/janela-automatica-instagram.test.ts tests/unit/mensagens-envio-instagram.test.ts lib/followup/enviar-texto-fixo.test.ts && pnpm typecheck && pnpm lint:channels`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/channels lib/api/handlers/types.ts app/api/v1/messages/_handler.ts lib/followup/enviar-texto-fixo.ts lib/agent-engine tests/unit
git commit -m "feat(instagram): follow-up sai no Instagram só dentro das 24h

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Follow-up escolhe a conversa do WhatsApp

**Files:**
- Create: `lib/followup/conversa-do-followup.ts`
- Modify: `lib/followup/enroll.ts` (≈150), `lib/followup/retorno-crm.ts` (≈95)
- Test: `tests/unit/followup-conversa-preferida.test.ts` (novo)

**Interfaces:**
- Produces:

```ts
// lib/followup/conversa-do-followup.ts
export interface ConversaCandidata { channel: string; channel_session_id: string | null; is_group: boolean; last_message_at: string | null; created_at: string }
/** WhatsApp 1:1 mais recente; senão Instagram 1:1 mais recente; senão undefined. Puro. */
export function sessaoPreferidaParaFollowup(conversas: ConversaCandidata[]): string | undefined;
/** Lê as conversas 1:1 do contato (org-filtrado) e aplica a regra. */
export async function sessaoDoFollowup(admin: SupabaseClient, org: string, contactId: string): Promise<string | undefined>;
```

- [ ] **Step 1: Teste que falha**

```ts
// tests/unit/followup-conversa-preferida.test.ts
import { describe, expect, it } from "vitest";
import { sessaoPreferidaParaFollowup, type ConversaCandidata } from "@/lib/followup/conversa-do-followup";

const conv = (channel: string, sess: string, lastMsg: string, is_group = false): ConversaCandidata =>
  ({ channel, channel_session_id: sess, is_group, last_message_at: lastMsg, created_at: "2026-09-01T00:00:00Z" });

describe("sessaoPreferidaParaFollowup", () => {
  it("prefere WhatsApp mesmo com Instagram mais recente", () => {
    expect(sessaoPreferidaParaFollowup([conv("instagram", "ig", "2026-09-26T10:00:00Z"), conv("whatsapp", "wa", "2026-09-20T10:00:00Z")])).toBe("wa");
  });
  it("entre dois WhatsApp, o mais recente", () => {
    expect(sessaoPreferidaParaFollowup([conv("whatsapp", "wa1", "2026-09-10T00:00:00Z"), conv("whatsapp", "wa2", "2026-09-20T00:00:00Z")])).toBe("wa2");
  });
  it("sem WhatsApp, Instagram", () => {
    expect(sessaoPreferidaParaFollowup([conv("instagram", "ig", "2026-09-26T10:00:00Z")])).toBe("ig");
  });
  it("grupo de WhatsApp não conta", () => {
    expect(sessaoPreferidaParaFollowup([conv("whatsapp", "grupo", "2026-09-26T00:00:00Z", true), conv("instagram", "ig", "2026-09-20T00:00:00Z")])).toBe("ig");
  });
  it("sem conversa, undefined", () => {
    expect(sessaoPreferidaParaFollowup([])).toBeUndefined();
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implementar**

`sessaoPreferidaParaFollowup`: filtra `!is_group && channel_session_id`, ordena por `last_message_at` desc (nulo por último) e `created_at` desc, devolve o primeiro `whatsapp`, senão o primeiro `instagram`, senão `undefined`. `sessaoDoFollowup`: `admin.from("conversations").select("channel, channel_session_id, is_group, last_message_at, created_at").eq("organization_id", org).eq("contact_id", contactId).eq("is_group", false)`; em erro, `logger.warn` e devolve `undefined` (cai no comportamento de hoje). Em `enroll.ts` e `retorno-crm.ts`: `beginServiceAtOrigin(admin, org, contactId, await sessaoDoFollowup(admin, org, contactId))`. Acrescente aos testes existentes de enroll/retorno (se houver arranjo de Supabase falso) um caso que confere o `p_session` repassado.

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/followup-conversa-preferida.test.ts lib/followup && pnpm typecheck && pnpm lint:channels`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/followup tests/unit/followup-conversa-preferida.test.ts
git commit -m "feat(followup): follow-up vai pelo WhatsApp quando o contato tem

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Passo fora das 24h é pulado e o fluxo segue

**Files:**
- Modify: `lib/followup/bloqueios-obrigatorios.ts` (`MotivoDoBloqueio`, `TEXTO_DO_BLOQUEIO`, `DecisaoDoEnvio`, `FatosDoEnvio`, `lerFatosDoEnvio`, `decidirEnvio`)
- Modify: `lib/agent-engine/agent/followup-turn.ts` (tratamento da decisão e da recusa do servidor)
- Modify: `lib/followup/enviar-texto-fixo.ts` (conferir a janela antes de enviar; recusa do servidor vira pulo)
- Modify: `lib/followup/eventos-legiveis.ts` (se o evento do pulo precisar de texto novo)
- Modify: `lib/i18n/dicionario.ts`
- Test: `lib/followup/bloqueios-obrigatorios.test.ts`, `lib/followup/enviar-texto-fixo.test.ts`, teste do followup-turn existente (`grep -rln "followup-turn" tests lib | head`)

**Interfaces:**
- Consumes: Task 1 `fimDaJanelaAutomatica(provider, lastInboundAt)`.
- Produces:
  - `FatosDoEnvio.fim_da_janela_automatica: string | null` (ISO; `null` = canal sem a regra)
  - `MotivoDoBloqueio` ganha `'fora_das_24h_do_instagram'`, `TEXTO_DO_BLOQUEIO.fora_das_24h_do_instagram = "Passo pulado: fora das 24h do Instagram."`
  - `DecisaoDoEnvio` ganha `{ envia: false; motivo: 'fora_das_24h_do_instagram'; pula: true }`

- [ ] **Step 1: Confirmar como um passo é pulado SEM encerrar a sequência**

Antes de escrever código, leia `lib/followup/turn-bridge.ts` e o motor (`lib/followup/engine.ts`, `lib/followup/node-handlers.ts`) e descubra o que `complete(..., { result: { kind: 'skipped', reason } })` faz com a inscrição: se ela AVANÇA para o próximo nó ou TERMINA. Registre a resposta no relatório com arquivo:linha. O requisito é avançar para o próximo nó (a sequência continua). Se `skipped` hoje encerra, use o resultado que avança (por exemplo, o mesmo caminho de `sent` com um marcador de que não enviou), sem mudar o que `skipped` significa para os motivos que já existem.

- [ ] **Step 2: Testes que falham**

Em `lib/followup/bloqueios-obrigatorios.test.ts` (usando o construtor de fatos do próprio arquivo):
1. `fim_da_janela_automatica` 1h no passado → `{ envia:false, motivo:'fora_das_24h_do_instagram', pula:true }`.
2. `fim_da_janela_automatica` 5h no futuro e sem janela da organização → `{ envia: true }`.
3. janela da organização fechada, próxima abertura DEPOIS do `fim_da_janela_automatica` → pula (não adia).
4. janela da organização fechada, próxima abertura ANTES do fim → adia como hoje (`fora_da_janela`, `adiarPara`).
5. `fim_da_janela_automatica: null` (WhatsApp) → decisões de hoje intactas (rode os testes existentes).
6. motivos irrevogáveis (opt-out, anonimizado) continuam vencendo o pulo (ordem por gravidade).

No teste do followup-turn: decisão `pula:true` → `complete` chamado com o resultado que avança (Step 1), evento legível "Passo pulado: fora das 24h do Instagram.", nenhum envio, nenhum `rescheduleReentry`, nenhum throw. E: `sendMessageHandler`/edge devolvendo recusa `fora_das_24h_do_instagram` → mesmo tratamento (pulo), não erro.

Em `enviar-texto-fixo.test.ts`: conversa do Instagram com `last_inbound_at` há 30h → não chama `sendMessageHandler`, completa como pulo e o passo avança; recusa do servidor com `fora_das_24h_do_instagram` → pulo, não `settle` de falha.

Run → FAIL.

- [ ] **Step 3: Implementar**

- `lerFatosDoEnvio`: ler também o provider da sessão da conversa e `last_inbound_at` (join `channel_sessions` pela `channel_session_id` da conversa, filtrado por org) e preencher `fim_da_janela_automatica = fimDaJanelaAutomatica(provider, last_inbound_at)?.toISOString() ?? null`.
- `decidirEnvio`: depois das checagens irrevogáveis e ANTES do bloco da janela da organização:

```ts
const fimAuto = fatos.fim_da_janela_automatica === null ? null : Date.parse(fatos.fim_da_janela_automatica);
if (fimAuto !== null && agora.getTime() >= fimAuto) {
  return { envia: false, motivo: 'fora_das_24h_do_instagram', pula: true };
}
```

e dentro do bloco da janela da organização, ao lado do `prazoDoSinal`:

```ts
if (fimAuto !== null && abre.getTime() >= fimAuto) {
  return { envia: false, motivo: 'fora_das_24h_do_instagram', pula: true };
}
```

- `followup-turn.ts`: tratar `bloqueio.motivo === 'fora_das_24h_do_instagram'` antes do ramo `invalida`, com o resultado que avança (Step 1) e `reason: TEXTO_DO_BLOQUEIO.fora_das_24h_do_instagram`; e onde o envio pela edge volta recusado, se o código for `fora_das_24h_do_instagram`, o mesmo tratamento. Os outros tipos de decisão que fazem `switch`/narrowing em `DecisaoDoEnvio` precisam compilar (tsc aponta).
- `enviar-texto-fixo.ts`: antes de `sendMessageHandler`, ler provider + `last_inbound_at` da conversa (se já não estiverem em mãos) e, se `!automaticoPodeEnviar(...)`, completar como pulo (mesmo resultado do Step 1, com a razão verbatim) e seguir para o próximo job; se `sendMessageHandler` devolver a mensagem `failed` com `error_code === "fora_das_24h_do_instagram"`, mesmo tratamento, sem lançar.
- `eventos-legiveis.ts`: garantir que o evento do pulo mostra "Passo pulado: fora das 24h do Instagram." (se a razão já é exibida, só o teste).
- Dicionário: `es` para o texto novo.

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm vitest run lib/followup lib/agent-engine tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck && pnpm lint:channels`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/followup lib/agent-engine lib/i18n tests
git commit -m "feat(followup): passo fora das 24h do Instagram é pulado e o fluxo segue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Mesmo @ vira um contato só

**Files:**
- Create: `lib/channels/instagram/juntar-por-arroba.ts`
- Modify: `lib/channels/instagram/ingest.ts` (depois do preenchimento do perfil)
- Modify: `lib/channels/instagram/renovacao.ts` (passada diária; `ResumoDaRenovacao.contatosJuntados`; condição de auditoria)
- Test: `tests/unit/instagram-juntar-por-arroba.test.ts` (novo); `tests/invariants/instagram-canal.test.ts` (caso com banco real)

**Interfaces:**
- Produces:

```ts
// lib/channels/instagram/juntar-por-arroba.ts
/** Contatos vivos (não absorvidos) da org com identidade de Instagram de mesmo @ (case-insensitive). Principal = created_at mais antigo. */
export function escolherPrincipal(contatos: { id: string; created_at: string }[]): { principal: string; secundarios: string[] } | null;
/** Junta o contato ao(s) de mesmo @. Best-effort: nunca lança. Audita contact.merged com ator de sistema. */
export async function juntarPorArroba(
  admin: SupabaseClient,
  input: { organizationId: string; contactId: string },
): Promise<"juntou" | "nada">;
/** Passada da rodada diária: até `limite` grupos de mesmo @ com mais de um contato vivo. */
export async function juntarDuplicadosPorArroba(admin: SupabaseClient, organizationId: string, limite: number): Promise<number>;
```

- [ ] **Step 1: Testes que falham**

Unidade (`escolherPrincipal`): um contato → `null`; dois → principal o mais antigo; empate de `created_at` → menor `id` (determinístico).

Unidade (`juntarPorArroba`, Supabase falso no padrão dos testes de `lib/channels/instagram`): identidade do contato com handle `Maria.Silva`, outra identidade de outro contato com `maria.silva` → chama `rpc("fn_mesclar_contatos", { p_organization_id, p_contato_principal: <mais antigo>, p_contatos_secundarios: [<outro>] })` e audita `contact.merged` com `metadata.motivo = "mesmo_arroba_instagram"`; handle nulo → `"nada"` sem rpc; outro contato já absorvido (`is_merged_into` preenchido) → ignorado; rpc devolvendo erro → `"nada"`, `logger.warn`, sem lançar.

Invariante (`tests/invariants/instagram-canal.test.ts`, banco real do `test:db`): dois contatos da mesma org, cada um com uma identidade de Instagram de mesmo @ (maiúsculas diferentes) e uma conversa em sessões diferentes; chamar `fn_mesclar_contatos` como o código chama → o secundário fica `is_merged_into = principal` e as DUAS conversas apontam para o principal (prova que `uniq_conversations_1to1_per_contact_session` não colide com sessões diferentes).

Ingestão: depois de `preencherPerfilDoContato` devolver `"preenchido"`, `juntarPorArroba` é chamado com o contato; falha nele não impede o resto da ingestão.

Renovação: a rodada chama `juntarDuplicadosPorArroba(admin, org, 50)` por organização com sessão ativa; `contatosJuntados > 0` entra na condição de auditoria; rodada sem nada não audita.

Run → FAIL.

- [ ] **Step 2: Implementar**

- `juntarPorArroba`: ler o handle da identidade de Instagram do contato (`contact_channel_identities`, org + `contact_id` + `channel = 'instagram'`, `handle` não nulo); se nenhum, `"nada"`. Buscar identidades da org com `channel='instagram'` e `handle` igual sem diferenciar maiúsculas (`.ilike("handle", handle)` — escape `%` e `_` do handle antes), `contact_id` diferente; carregar esses contatos com `.is("is_merged_into", null)` e `created_at`; `escolherPrincipal` com o próprio contato incluído; chamar o rpc com o admin (service role: a função aceita sem `auth.uid()`); auditar com o helper de auditoria que a rota `app/api/v1/contacts/merge/route.ts` usa, `action: "contact.merged"`, `actorUserId: null`, metadata `{ merged_contact_ids, motivo: "mesmo_arroba_instagram" }` (se o helper exigir ator, siga o padrão de auditoria de sistema já usado em `renovacao.ts`).
- `juntarDuplicadosPorArroba`: buscar identidades de Instagram com handle da org, agrupar por `lower(handle)` em memória, pegar grupos com 2+ contatos distintos, até `limite`, e chamar `juntarPorArroba` para o contato mais novo de cada grupo. Contar os `"juntou"`.
- `ingest.ts`: logo depois de `preencherPerfilDoContato` devolver `"preenchido"`, `await juntarPorArroba(admin, { organizationId, contactId })`. Se a junção absorveu o contato da ingestão, o restante da ingestão continua funcionando (as FKs foram repontadas); confira que o `contactId` usado adiante não quebra (recarregue o `is_merged_into` e use o principal, se for o caso).
- `renovacao.ts`: `contatosJuntados` no resumo; somar os retornos por organização distinta; condição de auditoria `renovadas > 0 || nomesPreenchidos > 0 || contatosJuntados > 0`.

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/instagram-juntar-por-arroba.test.ts tests/unit/instagram-perfil-do-contato.test.ts lib/channels/instagram tests/unit/cron-audita-so-quando-ha-efeito.test.ts && pnpm test:db && pnpm typecheck && pnpm lint:channels`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/channels/instagram tests
git commit -m "feat(instagram): quem escreve para os dois perfis vira um contato só

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: "Duplicados" sugere Instagram × WhatsApp pelo nome

**Files:**
- Modify: `lib/contacts/duplicados.ts`
- Modify: `app/api/v1/contacts/duplicates/route.ts` (select com `source` e a marca de Instagram)
- Modify: `components/contacts/MergeDialog.tsx` (`ROTULO_DO_MOTIVO`)
- Modify: `lib/i18n/dicionario.ts`
- Test: `tests/unit/contatos-duplicados-deteccao.test.ts`

**Interfaces:**
- Produces: `MotivoDeDuplicidade` ganha `"mesmo_nome_instagram_whatsapp"`; `ContatoParaDeduplicar` ganha `do_instagram: boolean` (tem identidade de Instagram); `chaveDeNome(nome: string | null): string | null` (normaliza; `null` se menos de duas palavras).

- [ ] **Step 1: Testes que falham**

1. `chaveDeNome("  José   Souza ")` → `"jose souza"`; `chaveDeNome("Ana")` → `null`; `chaveDeNome(null)` → `null`.
2. contato A `do_instagram: true`, sem telefone, `display_name "José Souza"`; contato B com telefone, `name "Jose Souza"` → um grupo com motivo `mesmo_nome_instagram_whatsapp`.
3. dois contatos do Instagram com o mesmo nome e sem telefone → NÃO agrupa por nome (a junção deles é por @, Task 4).
4. dois contatos com telefone e o mesmo nome → NÃO agrupa por nome (regra de hoje).
5. "Ana" × "Ana" → não agrupa.

Run → FAIL.

- [ ] **Step 2: Implementar**

`chaveDeNome`: `normalize("NFD")`, remover diacríticos, minúsculas, colapsar espaços, `trim`; `null` se menos de duas palavras. Em `encontrarContatosDuplicados`, depois das chaves de hoje: mapear por nome os contatos com telefone e unir cada contato `do_instagram && !phone_number` aos de mesmo nome, com o motivo novo. Nome usado: `display_name ?? name`. Na rota: acrescentar `source` ao select e marcar `do_instagram` pelos contatos que têm identidade de Instagram (uma consulta a `contact_channel_identities` filtrada por org e `channel = 'instagram'`, só `contact_id`), sem estourar o teto de varredura de hoje. `ROTULO_DO_MOTIVO.mesmo_nome_instagram_whatsapp = "mesmo nome no Instagram e no WhatsApp"` + `es`.

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/contatos-duplicados-deteccao.test.ts tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/contacts app/api/v1/contacts/duplicates components/contacts lib/i18n tests/unit
git commit -m "feat(contatos): duplicados sugere Instagram e WhatsApp com o mesmo nome

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: A ficha do contato mostra os canais

**Files:**
- Create: `components/contacts/CanaisDoContato.tsx`
- Modify: `app/app/contacts/[id]/_client.tsx`
- Modify: rota de listagem de conversas, só se precisar de filtro por contato (confira antes se `GET /api/v1/conversations` já aceita `contact_id`; se não, acrescente `contact_id: z.string().uuid().optional()` ao schema de listagem em `lib/schemas/messaging.ts` e `.eq("contact_id", …)` no handler, org-filtrado como o resto)
- Modify: `lib/i18n/dicionario.ts`
- Test: `tests/unit/contato-canais.test.tsx` (novo)

**Interfaces:**
- Consumes: `SeloDoCanal({ canal, tamanho, className })` de `components/inbox/SeloDoCanal.tsx`.
- Produces: `CanaisDoContato({ contactId }: { contactId: string })`.

- [ ] **Step 1: Teste que falha**

Com a busca de dados mockada no padrão dos testes de componentes vizinhos: contato com uma conversa `whatsapp` (sessão com número) e uma `instagram` (sessão `@instit.eva`, identidade `@maria.silva`) → duas linhas; a do Instagram tem `getByLabelText("Instagram")`, mostra "@maria.silva" e "via @instit.eva", e o link tem `href="/app/inbox?id=<id da conversa>"`; a do WhatsApp tem `getByLabelText("WhatsApp")` e o telefone formatado. Sem conversas → a seção não aparece. Conversas de grupo não entram.

Run → FAIL.

- [ ] **Step 2: Implementar**

`CanaisDoContato` busca as conversas 1:1 do contato (com `channel`, `channel_sessions(display_name, phone_number)` e, para o Instagram, o `@` da identidade do contato — traga `contact_channel_identities.handle` pela rota que já devolve conversa, ou por uma consulta org-filtrada; escolha a de menor mudança e explique no relatório) e renderiza uma lista titulada `t("Canais")`: selo pequeno, identificador (telefone via `phoneForDisplay` ou `@handle`), `t("via")` + nome/número da sessão, e link `/app/inbox?id=…`. Entra em `_client.tsx` logo abaixo do bloco de detalhes. Textos novos com `es`.

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm vitest run tests/unit/contato-canais.test.tsx tests/unit/i18n-espanhol-cobre-a-tela.test.ts && pnpm typecheck && pnpm lint && pnpm lint:channels`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add components/contacts app/app/contacts lib tests/unit
git commit -m "feat(contatos): a ficha mostra por quais canais a pessoa fala

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Prova pela tela e entrega

**Files:**
- Modify/Create: `tests/e2e/instagram-contato-unico.spec.ts` (novo) e o seed `scripts/seed-e2e-instagram.ts`
- Modify: `.github/workflows/e2e.yml` (spec nova na mesma `SPECS_PARTE_*` das outras do Instagram)
- Modify: `docs/testing/user-journey-map.md`
- Create: `.changes/instagram-direct-contato-unico.md`

- [ ] **Step 1: Spec pela tela**

Mesmo ambiente das specs do Instagram (baseline pg15 + `next build`/`next start`, receptor local na porta 47811 via `scripts/gerar-env-e2e.sh`). Casos:
1. Seed com um contato que tem conversa de WhatsApp e de Instagram: a ficha do contato mostra "Canais" com as duas linhas (selos e "via"), e o link do Instagram abre a conversa certa no Inbox.
2. Seed com dois contatos do Instagram de mesmo @ em perfis diferentes; disparar a rodada diária pelo endpoint do cron (como as outras specs disparam cron) → a lista de contatos passa a ter um só, e a ficha mostra as duas conversas.
3. "Duplicados" mostra o par Instagram × WhatsApp de mesmo nome com o rótulo "mesmo nome no Instagram e no WhatsApp".
Screenshots em `.superpowers/evidence/instagram-contato-unico/`.

(O follow-up dentro das 24h fica provado nas Tasks 1 e 3 por testes de unidade; dirigir um fluxo de follow-up inteiro pela tela não entra aqui.)

- [ ] **Step 2: Fragmento de release (curto)**

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: Instagram no contato único e no follow-up
---
Mesmo @ vira um contato só.
```

Run: `pnpm release:conferir` e `pnpm vitest run tests/unit/changelog-cabe-na-tela-da-vps.test.ts` → ok.

- [ ] **Step 3: Suíte e gates**

```bash
pnpm typecheck && pnpm lint && pnpm lint:channels
pnpm test:unit > /tmp/vt-e3.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests |Errors " /tmp/vt-e3.log | tail -3
pnpm test:db
pnpm test:e2e tests/e2e/instagram-contato-unico.spec.ts tests/e2e/instagram-responder.spec.ts tests/e2e/instagram-receber.spec.ts
```

Expected: tudo verde, exceto a falha local conhecida de `lib/ai/dispatcher/rate-limit.test.ts` (Redis local).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e scripts .github docs .changes
git commit -m "test(instagram): prova pela tela do contato único e dos canais na ficha

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Depois do merge (com o André)

1. Deploy como nas etapas 1 e 2 (esta etapa não tem migration; aplicar o baseline mesmo assim é inofensivo).
2. No dia seguinte: conferir se o contato de teste do André (que escreveu para os dois perfis) virou um só.
3. Acompanhar por uma semana quantos passos de follow-up no Instagram foram pulados; se quase todos, abrir o plano B (lembrete para a equipe).
