# Biblioteca de mídias, fatia 2 (envio pelo WhatsApp) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma mensagem pode ser enviada apontando para um item da biblioteca (`media_library_item_id`) em vez de um arquivo da conversa; o handler de envio confere o termo de imagem NA HORA, escolhe a variante A/B fixa por contato, assina URL de 10 min no bucket `media-library` e manda pelo mesmo adapter de canal. A conversa mostra a mídia enviada.

**Architecture:** Coluna nova `messages.media_library_item_id` (FK `on delete set null`) e `metadata.media_variant`. `media_storage_path` fica NULO nesses envios: a anonimização LGPD só recolhe `media_storage_path`, então nunca enfileira o arquivo do acervo, e o gatilho `trg_attach_outbound_media` não interfere. Um ramo novo em `app/api/v1/messages/_handler.ts`, ao lado do ramo de `media_storage_path` (L831-859), e um ramo novo na rota `app/api/v1/messages/[id]/media/route.ts`.

**Tech Stack:** Next.js 16 Route Handlers, Supabase (Postgres + Storage), Zod, Vitest, invariantes `pnpm test:db`.

**Spec:** `docs/superpowers/specs/2026-10-06-biblioteca-de-midias-design.md` (§2.4, §2.5, §5, §6). Fatia 1 já na `main` (#156).

## Global Constraints

- Migration **0327** (reservada). Arquivo `supabase/migrations/20261007230000_0327_mensagem_com_midia_da_biblioteca.sql` + bloco no apêndice do `supabase/baseline.sql` logo DEPOIS da linha `-- ---- fim: biblioteca de mídias (migration 0326) ----` e ANTES de `-- ---- VARREDURA anon ...` + linha no `MANIFEST.md` depois da do 0326.
- Coluna: `messages.media_library_item_id uuid references public.media_library_items(id) on delete set null`, com índice parcial `where media_library_item_id is not null`.
- O item é SEMPRE resolvido com `organization_id` = organização da conversa (`c.organization_id`), com o admin client, e as variantes passam por `variantesDoItem(raw, orgId, itemId)` (fatia 1). Nunca aceitar caminho de arquivo vindo do chamador.
- Situação conferida na hora com `situacaoDaMidia(item, hojeNaClinica())`; só `pronta` sai.
- Erros de recusa (o chamador da fatia 3 os devolve ao modelo como erro de ensino): 422 `media_not_found` (item inexistente ou de outra org), 422 `media_not_ready` com `details: { situacao }` (sem termo, vencido, revogado, sem arquivo).
- Variante: `media_variant` explícito (`"A"|"B"`) se vier e existir; senão sorteio determinístico por contato com `pickReentryVariant(contactId, keys)` de `lib/agent-engine/agent/reentry-template.ts:108` sobre as chaves disponíveis ordenadas. Gravado em `metadata.media_variant`.
- `type` da mensagem = `image` se o mime da variante começa com `image/`, `video` se `video/`; o `type` do chamador é ignorado nesse ramo.
- `body` vira a legenda (`caption`) e é opcional.
- URL assinada: bucket `media-library`, 600 s, igual ao ramo existente.
- Português, sem travessão, nos textos novos.
- Fora desta fatia: tool `send_media` da IA (fatia 3), passo de follow-up (fatia 4), envio real com WAHA e vídeo de 30 MB (fatia 5), UI para o atendente escolher mídia da biblioteca.

## Review Focus

1. **Item de outra organização pelo id** (chamador com `media_library_item_id` da org B numa conversa da org A): 422 `media_not_found`, nenhuma assinatura de URL, nenhuma linha inserida. Teste na Task 2.
2. **Termo revogado entre a escolha e o envio**: a situação é lida no handler, não no chamador; revogado → 422 `media_not_ready`, nada vai ao canal. Teste na Task 2.
3. **Anonimizar o contato que recebeu mídia da biblioteca**: `storage_redaction_queue` não recebe NENHUM caminho do bucket `media-library` (nem pelo botão da tela, nem pelo pedido formal). Invariante na Task 1.
4. **Apagar o item depois do envio**: a mensagem fica com `media_library_item_id` nulo, o histórico continua, e a rota de mídia responde 404 em vez de 500. Invariante na Task 1 + teste na Task 3.
5. **Envio sem `body` e sem caminho** (só o item): o Zod aceita, e o preview da conversa mostra `[image]`/`[video]` em vez de vazio. Teste na Task 2.

---

### Task 1: Coluna, tipos e invariantes

**Files:**
- Create: `supabase/migrations/20261007230000_0327_mensagem_com_midia_da_biblioteca.sql`
- Modify: `supabase/baseline.sql`, `supabase/migrations/MANIFEST.md`
- Modify: `lib/database.types.ts` (tabela `messages`: Row/Insert/Update + Relationship `messages_media_library_item_id_fkey`, em ordem alfabética, como o commit `a138fad41` fez para outra coluna)
- Create: `tests/invariants/mensagem-com-midia-da-biblioteca.test.ts`

- [ ] **Step 1: Invariante (falha)**. Copie a forma de `tests/invariants/lgpd-anonimizar-pela-tela-redige-conversas.test.ts` (pool, `seedGov`, `contatoComConversa`, `naFila`) e de `tests/invariants/anexo-da-nota-interna-responde-a-lgpd.test.ts` (beforeEach com buckets, fila limpa, `lgpd_requests`). Casos:
  - a coluna existe, é `uuid`, tem FK para `media_library_items` com `confdeltype = 'n'` (set null);
  - inserir item na org do seed com uma variante `A` (`storage_path` = `<org>/<item>/A-x.png`), inserir mensagem outbound com `media_library_item_id` = item e `media_storage_path` nulo;
  - anonimizar o contato pelo caminho da tela (`update contacts set is_anonymized = true`) → `select count(*) from storage_redaction_queue where bucket = 'media-library'` = 0 e a linha do item continua existindo;
  - mesmo teste pelo pedido formal `fn_lgpd_cascade_redact_contact(org, contato, request_id)`;
  - apagar o item → a mensagem continua existindo com `media_library_item_id` nulo.
- [ ] **Step 2:** `pnpm test:db > /tmp/db.log 2>&1; echo exit=$?` → FAIL (coluna não existe).
- [ ] **Step 3: Migration**

```sql
-- Biblioteca de mídias, fatia 2: a mensagem que levou um item da biblioteca.
-- media_storage_path fica NULO nesses envios de propósito: a anonimização LGPD
-- recolhe só media_storage_path, então nunca enfileira o arquivo do acervo
-- (compartilhado por todas as conversas). Apagar o item preserva o histórico.
alter table public.messages
  add column if not exists media_library_item_id uuid
    references public.media_library_items(id) on delete set null;

create index if not exists messages_media_library_item_idx
  on public.messages (media_library_item_id) where media_library_item_id is not null;

comment on column public.messages.media_library_item_id is
  'Item da biblioteca de mídias enviado nesta mensagem (migration 0327). A variante sai em metadata.media_variant.';
```

- [ ] **Step 4:** mesmo corpo no baseline, entre `-- ---- mensagem com mídia da biblioteca (migration 0327) ----` e `-- ---- fim: mensagem com mídia da biblioteca (migration 0327) ----`, logo depois do fim do bloco 0326. Linha no MANIFEST: `` | `20261007230000` | `0327_mensagem_com_midia_da_biblioteca` | Biblioteca de mídias (Fase 2, fatia 2): `messages.media_library_item_id` (FK `on delete set null`, índice parcial). O envio aponta para o item em vez de copiar o arquivo; `media_storage_path` fica nulo, então a anonimização LGPD nunca alcança o acervo. Variante A/B em `metadata.media_variant`. | ``
- [ ] **Step 5:** tipos em `lib/database.types.ts`.
- [ ] **Step 6:** `pnpm test:db` exit 0; `pnpm exec vitest run tests/unit/manifest-x-migrations.test.ts tests/unit/apendice-do-baseline-nao-diverge-da-cadeia.test.ts tests/unit/baseline-reaplicavel.test.ts`; `pnpm typecheck`.
- [ ] **Step 7:** commit `feat(midias): mensagem aponta para o item da biblioteca (migration 0327)`.

---

### Task 2: Ramo de envio no handler

**Files:**
- Modify: `lib/schemas/messaging.ts` (`sendMessageSchema` L74-129): `media_library_item_id: z.string().uuid().optional()`, `media_variant: z.enum(["A","B"]).optional()`; a refine passa a aceitar `!!d.media_library_item_id`; recusar `media_library_item_id` junto com `media_storage_path` (mensagem "Envie o arquivo da conversa ou o item da biblioteca, não os dois.").
- Create: `lib/midias/envio.ts` + `lib/midias/envio.test.ts`
- Modify: `app/api/v1/messages/_handler.ts`: `MSG_COLS` (L137) ganha `media_library_item_id`; `previewFrom` (L258) trata o item como mídia; resolução antes do insert; `insertRow` (L544) grava `media_library_item_id`, `media_mime`, `media_size_bytes`, `type` derivado e `metadata.media_variant`; ramo de envio ao lado do de `media_storage_path` (L831).
- Modify: `lib/types/messaging.ts:71` (`Message` ganha `media_library_item_id: string | null`)
- Test: novo `tests/unit/messages-handler-midia-da-biblioteca.test.ts`, copiando a forma de `tests/unit/messages-handler-desfechos.test.ts`

**Interfaces:**
- Produces (`lib/midias/envio.ts`), puro, sem I/O:
  - `escolherVariante(variantes: Variante[], contactId: string, pedida?: "A" | "B"): Variante | null` — pedida se existir; senão `pickReentryVariant(contactId, keys ordenadas)`; `null` se não há variante.
  - `tipoDaMidia(mime: string): "image" | "video" | null`
- Produces (no handler, interno): função `resolverMidiaDaBiblioteca(orgId, itemId, contactId, pedida?)` que lê com `createAdminClient()` `media_library_items` filtrando `organization_id` e `id`, aplica `variantesDoItem`, `situacaoDaMidia(..., hojeNaClinica())`, `escolherVariante`, e devolve `{ variante, type }` ou lança `ApiError(422, "media_not_found" | "media_not_ready", { situacao }?, ctx.requestId, mensagem)`. Mensagens: "Mídia não encontrada na biblioteca." e "Esta mídia não pode ser enviada agora: {situação legível}." (situação legível: sem termo de uso de imagem / termo vencido / termo revogado / sem arquivo).

- [ ] **Step 1:** testes de `lib/midias/envio.ts` (pedida existente, pedida ausente cai no sorteio, sorteio estável para o mesmo contato, lista vazia → null; `tipoDaMidia` para jpeg/png/webp/mp4/3gpp e para pdf → null). RED, depois implementar, GREEN.
- [ ] **Step 2:** testes do handler (RED), cobrindo pelo menos: item de outra org → 422 `media_not_found` sem insert e sem assinatura; item `sem_termo` → 422 `media_not_ready` com `details.situacao`; item pronto → insert com `media_library_item_id`, `media_storage_path` nulo, `type: "image"` mesmo com `type: "text"` no input, `metadata.media_variant`; o adapter recebe `kind: "image"`, `media.url` assinada em `media-library` por 600 s e `caption` = body; sem body → preview `[image]`; `media_library_item_id` + `media_storage_path` juntos → validação recusa; falha ao assinar → mesmo tratamento do ramo existente (`storage_sign_failed`).
- [ ] **Step 3:** implementar. A resolução acontece DEPOIS de carregar a conversa (L333-348) e do bloqueio de contato, e ANTES do `insertRow`. No ramo de envio:

```ts
} else if (midiaDaBiblioteca) {
  const admin = createAdminClient();
  const { data: signed, error: signErr } = await admin.storage
    .from(BUCKET_DA_BIBLIOTECA)
    .createSignedUrl(midiaDaBiblioteca.variante.storage_path, 600);
  if (signErr || !signed?.signedUrl) {
    throw new Error(`storage_sign_failed: ${signErr?.message ?? "no_url"}`);
  }
  const filename = midiaDaBiblioteca.variante.storage_path.split("/").pop() ?? undefined;
  await checkBoundary();
  ({ externalId } = await adapter.send({
    /* mesmos campos do ramo de media_storage_path */
    kind: midiaDaBiblioteca.type,
    media: { url: signed.signedUrl, mime: midiaDaBiblioteca.variante.mime, filename, caption: input.body ?? null },
  }));
}
```

  Os campos omitidos acima são exatamente os do ramo vizinho (L840-858); copie-os de lá.
- [ ] **Step 4:** `pnpm exec vitest run lib/midias tests/unit/messages-handler-*.test.ts lib/schemas` + `pnpm typecheck` + `pnpm lint`.
- [ ] **Step 5:** commit `feat(midias): o envio de mensagem leva um item da biblioteca, com o termo conferido na hora`.

---

### Task 3: Ver a mídia enviada na conversa

**Files:**
- Modify: `app/api/v1/messages/[id]/media/route.ts`: selecionar também `media_library_item_id, metadata, type`; quando `media_library_item_id` existir e `media_storage_path` não, ler o item com admin client filtrando `organization_id` da org ativa, `variantesDoItem`, escolher `metadata.media_variant` se existir senão a primeira, assinar no `media-library` por 3600 s e responder 302 como o ramo existente. Item apagado (FK nulo) cai no 404 que já existe.
- Modify: `components/inbox/MessageBubble.tsx:74`: `hasMedia` inclui `message.media_library_item_id`.
- Test: estender o teste existente da rota (procure `app/api/v1/messages/[id]/media/route.test.ts`; se não existir, crie seguindo a forma de outro teste de rota com `requireRole`/session mocks): item da org → 302 para URL do `media-library`; item de outra org → 404; variante gravada em metadata é a assinada.

- [ ] **Step 1:** testes (RED). **Step 2:** implementar. **Step 3:** `pnpm exec vitest run app/api/v1/messages components/inbox` + typecheck + lint. **Step 4:** commit `feat(midias): a conversa mostra a mídia enviada da biblioteca`.

---

### Task 4: Fragmento, docs e suítes

**Files:**
- Create: `.changes/midia-da-biblioteca-no-envio.md` (formato dos fragmentos existentes; `capacidade_nova`; texto: a API de envio de mensagem aceita `media_library_item_id` e confere o termo de uso de imagem na hora; a IA e os follow-ups passam a usar isso nas próximas versões).
- Modify: `docs/architecture/acervo-de-conhecimento.architecture.json` (aresta do nó da tabela da biblioteca para o envio de mensagens, se o mapa tiver nó de mensagens; senão um nó `midiasEnvio` = `app/api/v1/messages/_handler.ts` com arestas para a tabela e o bucket), mantendo `tests/unit/mapas-de-arquitetura.test.ts` verde.
- Modify: `docs/testing/user-journey-map.md` (J30 ganha o caso "envio pela API", marcado como coberto por unit/invariante, prova com WAHA real pendente da fatia 5).

- [ ] **Step 1:** arquivos. **Step 2:** `pnpm release:conferir`. **Step 3:** `pnpm test:unit > /tmp/vt.log 2>&1; echo exit=$?` e rodapé (Test Files / Tests / Errors) — exit 0. **Step 4:** commit `docs(midias): fragmento e mapa do envio da biblioteca`.
