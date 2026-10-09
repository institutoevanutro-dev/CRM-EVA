# Biblioteca de mídias, fatia 4 (passo "Enviar mídia" no follow-up) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O passo "Ação" do follow-up ganha o modo `media` (`{ mode: 'media', media_id, caption? }`), sem LLM: o motor envia o item da biblioteca pelo mesmo caminho do texto fixo, confere o termo na hora, e recusa vira passo pulado com motivo legível no histórico e aviso na Central. O editor do fluxo deixa escolher a mídia, e publicar avisa (não bloqueia) se a mídia não está pronta. É o que o anti-resfriamento com 2 fotos usa.

**Architecture:** O modo entra em `actionConfigSchema` (`lib/followup/graph-schema.ts:213`). O motor (`lib/followup/engine.ts` `turnPayloadExtras` L253) põe `media_id` e `media_caption` no payload do job (NUNCA `mode`, que já existe no payload com outro sentido). O worker (`lib/agent-engine/agent/followup-turn.ts`) ganha um ramo ANTES de `resolveFlowSendBody` (que devolveria `null` e cairia no turno de IA) e reaproveita `sendFixedOutbound` com o id da mídia. O caminho até o canal já existe (fatias 2 e 3): `ChannelSendInput.mediaLibraryItemId`, `MidiaRecusadaError` na 422, handler mantém `queued` quando `origemDoEnvio === 'followup'` e o retry do job reenvia.

**Tech Stack:** TypeScript, Zod, React, Vitest, invariantes `pnpm test:db`.

**Spec:** `docs/superpowers/specs/2026-10-06-biblioteca-de-midias-design.md` §2.3.

## Global Constraints

- Sem migration. Sem kind novo de aviso: o aviso na Central reaproveita `insertDeadInboxItem` (kind `followup_dead`, `ref_kind` `followup_enrollment`) com título próprio "Um follow-up parou: a mídia não pode ser enviada" e corpo = motivo legível + nome do fluxo/passo quando disponível.
- Schema: `z.strictObject({ mode: z.literal('media'), media_id: z.string().uuid(), caption: z.string().max(1024).optional() })`.
- Payload do job: `media_id: string`, `media_caption?: string` (com `{{volta}}` interpolado como o `body` do modo texto). `followupTurnPayloadSchema` ganha os dois campos opcionais.
- Envio: legenda passa por `{{nome}}`/`{{primeiro_nome}}` como o texto fixo (`interpolarNomeDoContato`); legenda vazia → `enforceSpinning: false` no `runBeforeSend`; `channel.send({..., body: legenda, mediaLibraryItemId: media_id, origemDoEnvio: 'followup' })`.
- Recusa (`MidiaRecusadaError` 422 `media_not_found`/`media_not_ready`): resultado `{ kind: 'skipped', reason: err.message, midiaRecusada: true }` (a sequência PARA: turn_skipped, status cancelled) + aviso na Central. Decisão do André em 09/10: a sequência para (antes era `pulado`, o fluxo seguia). Nunca deixar a 422 subir (o job repetiria uma recusa que não muda).
- `queued` (canal fora): comportamento atual do texto fixo (lança, o job tenta de novo e o ledger reenvia a mesma mensagem). Não mudar.
- Drenagem inline (`lib/followup/enviar-texto-fixo.ts`): NÃO drena mídia nesta fatia; jobs com `media_id` ficam com o agent-worker (presente em toda instalação self-host). Comentário `ponytail:` no ponto em que a drenagem filtra `fixed_body`.
- Publicar: a rota `app/api/v1/ai/followup-flows/[id]/publish/route.ts` devolve `warnings: Array<{ node_id, message }>` no sucesso para cada passo de mídia cujo item não existe na org ou não está `pronta` (situação legível); a `PublishBar` mostra um aviso (toast de aviso, não de erro) listando-os. Publicação NÃO é bloqueada.
- Textos de tela em português sem travessão, com entrada em espanhol em `lib/i18n/dicionario.ts`.
- Rótulos: `MODOS_DA_ACAO.media = "Imagem ou vídeo da biblioteca"`; `resumoDoNo` → "envia uma imagem ou vídeo da biblioteca"; `describeNodeConfig` → título do item se conhecido, senão "Mídia da biblioteca".

## Review Focus

1. **Passo de mídia caindo no turno de IA**: job com `media_id` e sem `fixed_body` NUNCA chama o LLM. Teste na Task 2.
2. **Termo revogado entre a publicação e o envio**: sequência encerrada com o motivo legível no histórico, aviso na Central, job não fica repetindo. Teste/invariante na Task 2.
3. **Canal fora no passo de mídia**: o job tenta de novo e o reenvio é a MESMA mensagem (sem duplicar). Teste na Task 2.
4. **Publicar fluxo com mídia sem termo**: publica, e a resposta traz o aviso com o `node_id`. Teste na Task 3.
5. **Mídia sem legenda duas vezes no mesmo contato**: o spinning não veta (legenda vazia não entra no spinning). Teste na Task 2.

---

### Task 1: Modo `media` no schema, no motor e nos rótulos

**Files:** `lib/followup/graph-schema.ts` (+ `graph-schema.test.ts`), `lib/followup/vocabulario.ts` (`MODOS_DA_ACAO`), `lib/followup/engine.ts` (`FollowupJobRequest.payload` L84-96 com `media_id?`, `media_caption?`; `turnPayloadExtras` L253-271 com o ramo `media`), `lib/followup/eventos-legiveis.ts` (`resumoDoNo` L177-186), `app/app/ai/followups/[id]/_components/nodes/nodeVisuals.ts` (`describeNodeConfig` L162-166), `lib/i18n/dicionario.ts` (es das strings novas).
- [ ] Testes (RED): schema aceita/recusa (uuid inválido, caption > 1024, campo extra); `turnPayloadExtras` do modo media devolve `{ media_id, media_caption }` com `{{volta}}` interpolado e sem `fixed_body`/`prompt_hint`; `resumoDoNo` do media não fala de modelo nem de agente; `vocabulario.test.ts` verde. GREEN, typecheck, lint, `tests/unit/i18n-espanhol-cobre-a-tela.test.ts`. Commit `feat(midias): o passo de follow-up ganha o modo mídia`.

### Task 2: O worker envia o passo de mídia

**Files:** `lib/agent-engine/agent/followup-turn.ts` (`followupTurnPayloadSchema` L73-115; `runFlowDrivenTurn` L536-626: ramo de mídia depois de `conferirAntesDoEnvio` e ANTES de `resolveFlowSendBody`; `sendFixedOutbound` L880-990 ganha parâmetro opcional `mediaLibraryItemId?: string` repassado ao `channel.send` e `enforceSpinning: false` quando há mídia e a legenda é vazia; catch de `MidiaRecusadaError` → `'midia_recusada'` com a mensagem), `lib/followup/turn-bridge.ts` ou o ponto que completa o turno (aviso na Central via `insertDeadInboxItem` quando o motivo vem de mídia recusada), `lib/followup/enviar-texto-fixo.ts` (só o comentário `ponytail:`).
**Tests:** unit no estilo de `tests/unit/followup-instagram-24h.test.ts` ("turno de fluxo — texto fixo"): mídia pronta → `channel.send` com `mediaLibraryItemId` e legenda com nome interpolado, `complete` `sent`, LLM nunca chamado; legenda vazia → `enforceSpinning: false`; `MidiaRecusadaError` → `skipped` (midiaRecusada) com a mensagem + aviso na Central; `queued` → lança (retry). Invariante no estilo de `tests/invariants/followup-turn-bridge.test.ts` ("nó action, ciclo completo"): passo de mídia com item revogado → evento `turn_skipped` com o motivo, enrollment `cancelled` com `cancel_reason`, sem próximo nó, há um `agent_inbox_items` `followup_dead` para o enrollment.
- [ ] RED/GREEN, typecheck, lint, `pnpm test:db`. Commit `feat(midias): o follow-up envia a mídia do passo, e a recusa vira passo pulado com aviso`.

### Task 3: Editor do passo e aviso ao publicar

**Files:** `app/app/ai/followups/[id]/_components/forms/ActionForm.tsx` (opção do modo; `SeletorDeMidia` copiando a forma de `SeletorDeModelo` L27-76 com `useMidias()` de `hooks/ai/useMidias.ts`, mostrando título e situação legível, itens não prontos visíveis mas marcados "não pode ser enviada agora: <situação>"; campo de legenda opcional `#action-caption`; `commit()` com o candidato `media`), `app/api/v1/ai/followup-flows/[id]/publish/route.ts` (lookup dos itens referenciados por passos de mídia, filtrando `organization_id`, com `situacaoDaMidia`/`variantesDoItem`/`hojeNaClinica`; `warnings` no payload de sucesso), `app/app/ai/followups/[id]/_components/PublishBar.tsx` (ler `warnings` do sucesso e mostrar toast de aviso), `hooks/followup/useFollowupFlow.ts` se o tipo do retorno do publish precisar do campo.
**Tests:** novo `forms/ActionForm.test.tsx` (com `QueryClientProvider` e `useMidias` mockado: escolher mídia e legenda chama `onChange` com o config `media`; item não pronto aparece marcado); teste da rota de publish (mídia sem termo → 200 com `warnings[0].node_id`; mídia pronta → sem warnings; item de outra org → warning "não encontrada"); `PublishBar.test.tsx` (warning vira toast de aviso, publicação segue).
- [ ] RED/GREEN, typecheck, lint, i18n es. Commit `feat(midias): escolher a mídia no passo do follow-up e aviso ao publicar`.

### Task 4: Fragmento, docs e suítes

- `.changes/followup-envia-midia.md` (formato dos existentes; `capacidade_nova`: "O passo de mensagem do follow-up pode enviar uma imagem ou vídeo da Biblioteca de mídias. Se a mídia não puder sair (sem termo, vencida ou revogada), o passo é pulado com o motivo no histórico e um aviso na Central, e o fluxo segue.").
- `docs/architecture/acervo-de-conhecimento.architecture.json`: nó do passo de follow-up de mídia (ou aresta do nó de follow-up existente, se houver) para `midiasEnvio`, no esquema do arquivo.
- `docs/testing/user-journey-map.md` J30: linha "follow-up manda mídia" `[ ]` com "coberto por unit/invariante; prova com WAHA real pendente (fatia 5)".
- [ ] `pnpm release:conferir`; FULL `pnpm test:unit` e FULL `pnpm test:db` (rodapés e exit). Commit `docs(midias): fragmento e mapa do follow-up com mídia`.
