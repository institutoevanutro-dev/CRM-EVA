# Biblioteca de mídias, fatia 3 (a IA manda mídia) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O agente de IA ganha a tool `send_media { media_id, caption? }`, irmã de `send_message`, que manda um item PRONTO da biblioteca pelo mesmo caminho (guardrails → `sendTurnMessage` → ledger → handler da fatia 2), com no máximo 1 mídia por turno, contando no teto de envios; vê a lista de itens prontos no prompt; e recebe recusas como erro de ensino. Antes disso, quatro consertos para que mídia não se perca nem trave.

**Architecture:** Base = branch `feat/midias-envio` (PR #186, fatia 2). O handler `app/api/v1/messages/_handler.ts` já aceita `media_library_item_id` e lança `ApiError` 422 `media_not_found` / `media_not_ready` (`details.situacao`) antes do insert. Esta fatia liga a ponta do agente: `ChannelSendInput` ganha os campos de mídia, `sendTurnMessage` os repassa e traduz a 422 num erro tipado, a tool o devolve ao modelo como ensino.

**Tech Stack:** TypeScript, Vercel AI SDK `tool()`, Postgres (pg), Vitest, invariantes `pnpm test:db`.

**Spec:** `docs/superpowers/specs/2026-10-06-biblioteca-de-midias-design.md` §2.2 (decisão do André: a IA escolhe sozinha, teto de 1 mídia por turno, só itens `Pronta`).

## Global Constraints

- Sem migration nesta fatia. Sem toggle por agente: `send_media` existe no turno se e somente se a organização tem pelo menos 1 item `pronta`.
- Erro tipado novo `MidiaRecusadaError` (em `lib/agent-engine/edge/crm/send-message.ts`), com `code: 'media_not_found' | 'media_not_ready'`, `message: string` (a mensagem pt-br do handler) e `situacao?: string`.
- Na 422 `media_not_*`: o ledger da intenção é fechado como `failed` com `last_error = code` ANTES de lançar `MidiaRecusadaError`; nunca vira `CrmTransportError`/`unavailable` (isso reagendaria o job e repetiria a 422 até morrer).
- A tool devolve `{ ok: false, error: { code, message } }` para recusas (ensino, não exceção) com `code` = `media_not_found` | `media_not_ready` | `max_media_per_turn` | `max_sends_per_turn` | código do veto da cadeia.
- Teto: `seq >= maxSendsPerTurn` → `max_sends_per_turn` (mesma mensagem do `send_template`); segunda mídia no turno → `max_media_per_turn` com mensagem "você já enviou uma mídia neste turno. Não envie outra agora; continue em texto ou espere a resposta do lead."
- Legenda passa por `runBeforeSend` como `body`; legenda vazia → `enforceSpinning: false` (senão toda mídia sem legenda colide no spinning). A mídia NUNCA é quebrada em balões: copiar o `send` closure do `send_template` (`seq += 1` uma vez).
- `body` vazio não vai ao handler: `sendTurnMessage` manda `body: undefined` quando a legenda é vazia.
- Lista no prompt: bloco residente "BIBLIOTECA DE MÍDIAS" com até 30 itens prontos, ordenados por título, formato `- <id> · <title> · quando usar: <when_to_use> · etiquetas: <tags>`; só entra se a lista não for vazia. Texto do bloco em português, sem travessão.
- Ledger: `Intent` ganha `mediaLibraryItemId?: string` e `mediaVariant?: 'A'|'B'`; o hash vira `sha256(body + '\u0000' + (mediaLibraryItemId ?? '') + '\u0000' + (mediaVariant ?? ''))` só quando há mídia (sem mídia, hash idêntico ao de hoje).
- Reconciliador: `redriveQueued` NÃO reenvia linhas com `media_library_item_id` (filtro `and m.media_library_item_id is null` no select principal e na contagem). Mídia do turno de resposta nunca fica `queued` (o handler fecha `failed`/`canal_fora`, a tool diz `envio_falhou`); a do follow-up continua `queued` para o retry do follow-up (fatia 4).
- Handler: replay (`ctx.internalMessageId` presente) que cai na 422 `media_not_*` marca a linha existente `queued` desse id como `failed` com `error_code` = código, filtrando `organization_id`, e só então lança a 422.
- Fora desta fatia: passo "Enviar mídia" do follow-up (fatia 4), prova com WAHA real (fatia 5), toggle por agente na tela.

## Review Focus

1. **Item revogado depois que o prompt foi montado** (a lista no prompt diz pronto, o handler recusa): a tool devolve `media_not_ready` com a situação legível, o turno segue, nada é reagendado, o ledger fica `failed`. Teste na Task 3.
2. **Modelo pede duas mídias no mesmo turno**: a segunda recebe `max_media_per_turn` e nada sai. Teste na Task 3.
3. **Organização sem nenhum item pronto**: `send_media` não existe no turno e o bloco não entra no prompt (o prefixo cacheável não muda para quem não usa a biblioteca). Teste na Task 2.
4. **Mídia com o canal fora e o reconciliador**: não é reenviada como texto. A do turno de resposta nunca fica `queued` — falha honesta (`failed`/`canal_fora`, tool `envio_falhou`, job termina); a do follow-up continua `queued` para o retry do follow-up (fatia 4). Testes em `tests/unit/messages-handler-midia-da-biblioteca.test.ts` e `tests/invariants/agent-send-media-turn.test.ts`.
5. **Replay de mídia cujo termo foi revogado no meio**: a linha `queued` vira `failed` com o código, não fica presa. Teste na Task 1.

---

### Task 1: Consertos de base (ledger, envio do agente, replay, reconciliador)

**Files:**
- Modify: `lib/agent-engine/edge/crm/send-ledger.ts` (`Intent` L15; hash L38; catch L58-63)
- Modify: `lib/agent-engine/channel-adapter.ts` (`ChannelSendInput` L18-51: `mediaLibraryItemId?: string; mediaVariant?: 'A' | 'B'`)
- Modify: `lib/agent-engine/edge/channel/waha-adapter.ts` (`send` L45-70: repassar os campos; NÃO capturar `MidiaRecusadaError` como `unavailable` — deixar subir)
- Modify: `lib/agent-engine/edge/crm/send-message.ts` (`SendMessageInput` L49-70 ganha os campos; mapeamento ao handler L153-165: `media_library_item_id`, `media_variant`, `body: input.body || undefined`; novo ramo antes do 404: `ApiError` 422 com `code` começando por `media_not_` → fechar ledger e lançar `MidiaRecusadaError`)
- Modify: `app/api/v1/messages/_handler.ts` (no ponto em que `resolverMidiaDaBiblioteca` lança, se `ctx.internalMessageId`: `update messages set status='failed', error_code=<code>, error_message=<mensagem> where organization_id=<org da conversa> and id=<internalMessageId> and status='queued'`, depois relançar)
- Modify: `lib/agent-engine/edge/crm/session-reconciler.ts` (select L323-350 e contagem L355-364: `and m.media_library_item_id is null`)
- Tests: `tests/unit/followup-send-ledger.test.ts` (hash com e sem mídia; 422 media_not_* fecha `failed` e propaga), `tests/unit/waha-adapter-template-passthrough.test.ts` ou arquivo irmão novo (campos de mídia passam; `MidiaRecusadaError` sobe), `tests/unit/envio-leva-marca-de-origem.test.ts` ou irmão (input do handler leva `media_library_item_id`, `body` undefined quando vazio; 422 vira `MidiaRecusadaError`), `tests/unit/messages-handler-midia-da-biblioteca.test.ts` (replay com `internalMessageId` + 422 marca a linha `failed`), `lib/agent-engine/edge/crm/session-reconciler.test.ts` (select contém `media_library_item_id is null`).

**Interfaces:**
- Produces: `export class MidiaRecusadaError extends Error { code: 'media_not_found'|'media_not_ready'; situacao?: string }` exportada de `lib/agent-engine/edge/crm/send-message.ts`; `ChannelSendInput.mediaLibraryItemId?`, `.mediaVariant?`.

- [ ] Testes RED, implementação, GREEN; `pnpm typecheck`; `pnpm lint`; commit `fix(midias): ledger, envio do agente, replay e reconciliador prontos para mídia`.

---

### Task 2: Itens prontos para o agente (carregar, bloco do prompt, ligar a tool)

**Files:**
- Create: `lib/midias/disponiveis.ts` + `lib/midias/disponiveis.test.ts`
- Modify: `lib/agent-engine/agent/inbound-turn.ts` (montagem do system L2410-2448: carregar a lista uma vez por turno e empurrar o bloco em `blocosResidentes` só se não vazia; guardar a lista numa variável do turno para a Task 3 decidir se a tool existe)

**Interfaces:**
- Produces:
  - `export type MidiaDisponivel = { id: string; title: string; when_to_use: string; tags: string[] }`
  - `export async function carregarMidiasProntas(pool: Pool, orgId: string, hoje?: string): Promise<MidiaDisponivel[]>` — `select id, title, when_to_use, tags, variants, contains_person, consent_signed_at, consent_expires_at, consent_revoked_at from media_library_items where organization_id = $1 order by title limit 200`, filtra com `variantesDoItem(...).filter(v => tipoDaMidia(v.mime))` + `situacaoDaMidia(..., hoje ?? hojeNaClinica()) === 'pronta'`, devolve até 30.
  - `export function blocoDaBiblioteca(itens: MidiaDisponivel[]): string | null` — `null` se vazio; senão o bloco:

```
BIBLIOTECA DE MÍDIAS
Você pode mandar UMA destas imagens ou vídeos por resposta com a ferramenta send_media, quando ajudar a pessoa a decidir. Escolha pelo "quando usar". Nunca diga que vai mandar algo que não está nesta lista.
- <id> · <title> · quando usar: <when_to_use> · etiquetas: <tags separadas por vírgula>
```

- [ ] Testes de `disponiveis.ts` (pronta entra; sem termo/vencido/revogado/sem arquivo/caminho alheio não entram; limite de 30; bloco nulo para lista vazia; formato exato da linha) com pool falso; teste de wiring no turno (lista vazia → bloco ausente do system). RED/GREEN, typecheck, lint, commit `feat(midias): o agente vê as mídias prontas da biblioteca`.

---

### Task 3: A tool `send_media`

**Files:**
- Modify: `lib/agent-engine/agent/inbound-turn.ts`:
  - `AGENT_TOOL_DEFS` (L197-402): def `send_media` com descrição "Envia UMA imagem ou vídeo da BIBLIOTECA DE MÍDIAS ao lead desta conversa, com legenda opcional. Use só ids da lista da biblioteca. No máximo uma mídia por resposta." e `inputSchema: z.object({ media_id: z.string().uuid().describe('id do item, copiado da BIBLIOTECA DE MÍDIAS'), caption: z.string().max(1024).optional().describe('legenda curta em pt-br, opcional') })`.
  - Estado do turno (perto de L2737-2843): `let midiaEnviadaNoTurno = false`.
  - Execução copiando a forma de `send_template` (L2960-3075): teto de envios; teto de 1 mídia; `media_id` fora da lista carregada na Task 2 → `media_not_found` sem chamar a cadeia; `runBeforeSend` com `body: caption ?? ''`, `enforceSpinning: (caption ?? '').trim().length > 0`, demais argumentos iguais aos do `send_message`; `send` closure com `seq += 1; return liveChannel().send({ tenantId, leadId, jobId: liveJob().id, jobClaim: claimOfJob(liveJob()), agentOperation, seq, conversationId: input.conversationId, body: finalBody, mediaLibraryItemId: media_id })`; `catch (e) { if (e instanceof MidiaRecusadaError) return { ok: false, error: { code: e.code, message: e.message } } ... }` ANTES do catch genérico que chama `noteRunError`; marca `midiaEnviadaNoTurno = true` só em `sent`/`already_sent`/`queued`; mapeamento de outcome igual ao do `send_template`.
  - Ligar/desligar (perto de L3900-3923): `if (midiasProntas.length === 0) delete rawTools.send_media`.
- Modify: `lib/agent-engine/agent/preview.ts` (`applyPreviewPolicy` L145-235): `send_media` entra como proposta (mesmo tratamento que o arquivo dá a envios não-texto; se não houver padrão, tratar como `send_message` avaliando a legenda com `evaluateBeforeSend`).
- Modify: `tests/unit/send-template-wiring.test.ts` ou irmão novo `tests/unit/send-media-wiring.test.ts` (a def existe, não está em `READ_ONLY_TOOLS`).
- Test: novo invariante `tests/invariants/agent-send-media-turn.test.ts` copiando `tests/invariants/agent-send-template-turn.test.ts` + `tests/invariants/limite-de-envios-por-turno.test.ts`: (a) item pronto → canal recebe `mediaLibraryItemId`, `seq` avança 1; (b) duas chamadas → segunda `max_media_per_turn`; (c) item recusado pelo canal (`MidiaRecusadaError`) → tool devolve `media_not_ready`, run NÃO lança, job não é reagendado; (d) org sem itens prontos → a tool não é oferecida.

- [ ] RED/GREEN, typecheck, lint, `pnpm test:db`, commit `feat(midias): a IA manda uma mídia da biblioteca por resposta`.

---

### Task 4: Fragmento, docs e suítes

- Create: `.changes/ia-manda-midia-da-biblioteca.md` (formato dos fragmentos existentes; `capacidade_nova`; "O agente de IA passa a mandar imagens e vídeos prontos da Biblioteca de mídias, uma por resposta, escolhendo pelo 'quando usar'. Mídia sem termo válido é recusada na hora.").
- Modify: `docs/architecture/acervo-de-conhecimento.architecture.json` (aresta real do turno do agente para o envio da biblioteca, no esquema do arquivo).
- Modify: `docs/testing/user-journey-map.md` (J30: caso "IA manda mídia", coberto por invariante; prova com WAHA real pendente da fatia 5).
- [ ] `pnpm release:conferir`; FULL `pnpm test:unit` e FULL `pnpm test:db` com rodapés e exit; commit `docs(midias): fragmento e mapa da IA mandando mídia`.
