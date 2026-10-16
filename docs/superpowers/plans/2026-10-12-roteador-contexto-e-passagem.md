# Roteador com contexto e passagem pelo agente Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Num roteador com o modo novo ligado, o roteador escolhe quem começa a conversa e só interrompe para assuntos marcados; a troca no meio é feita pelo agente que está atendendo, por uma ferramenta que faz o agente de destino responder a mesma mensagem; e o classificador vê o trecho recente da conversa.

**Architecture:** Um interruptor por roteador em `ai_routers.config` (`permanencia: 'agente'`, `interrompe: string[]`), lido por `router-config.ts`. Com ele ligado, `resolveTurnAgent` só troca um agente em andamento para assunto de `interrompe`, e entrega ao classificador o histórico recente do atendimento e o assunto atual. O turno ganha a ferramenta interna `transfer_to_subject`: ela grava o novo dono da conversa, para o loop do modelo, e `runAgentTurn` reexecuta o turno UMA vez, no mesmo job, com o agente de destino. Mesmo job quer dizer mesmo `send_ledger`, então retry não envia em dobro. Sem o interruptor, nada muda.

**Tech Stack:** TypeScript, pg, Zod, AI SDK (`tool`, `pararQuando`), Vitest, invariantes `pnpm test:db`.

**Spec:** `docs/superpowers/specs/2026-10-12-roteador-com-contexto-e-troca-pelo-agente-design.md`.

**Fatos conferidos no código (origin/main `6dae682d2`), que encurtam o desenho:**

- Fechar e reabrir a conversa já esquece o agente: `fn_service_inbound` (reabertura) e o trigger `trg_service_stamp_status` zeram `active_ai_agent_id`. "Reiniciar teste" fecha a conversa, então a mensagem seguinte já começa pelo roteador. O item "Reiniciar teste apaga o agente" do desenho não precisa de código.
- `ai_routers.config` é `z.record` livre nas rotas e mesclado no PATCH: o interruptor entra sem mudar API nem banco.
- `pararQuando` (parada do loop por predicado) já existe em `run-model-call.ts` e hoje só é usado na prévia assistida.
- `runAgentTurn` aceita `resolvedAgent` pronto; o núcleo só resolve o agente de novo quando ele não vem.

**Desvios do desenho, decididos aqui:**

1. **Sem mudança de banco.** A passagem pelo agente é gravada em `ai_router_decisions` com `outcome = 'reclassified'` e `confidence = null` (o roteador sempre grava um número; nulo identifica a passagem). Evita migration para alargar um CHECK.
2. **Conversa simulada só na rota de teste, não na tela.** A bateria roda pela rota. O campo na tela fica para depois.
3. **Histórico no classificador só com o modo novo ligado.** Assim roteadores existentes mantêm exatamente o prompt de hoje.

## Global Constraints

- Sem migration, sem env var nova, sem dependência nova.
- Branch nova de `origin/main` atualizada, em worktree próprio com `node_modules` real. Nunca rebase.
- **Roteador sem `permanencia: 'agente'`:** prompt do classificador byte a byte o de hoje, mesmas decisões, mesma lista de ferramentas do turno, mesmo system prompt. Há teste para cada um.
- A ferramenta `transfer_to_subject` só existe quando TODAS valem: não é prévia nem modo assistido; o turno veio de um roteador (`routed.routerId !== null`) com `permanencia: 'agente'`; o agente do turno é membro desse roteador; há ao menos um outro membro; o turno não é a reexecução de uma passagem; o job é `inbound_turn`.
- No máximo uma passagem por mensagem recebida. A reexecução nunca oferece a ferramenta.
- Reexecução só se o turno de origem não enviou nada (`seq === 0`). Se enviou, o dono novo assume na mensagem seguinte.
- Toda consulta nova filtra `organization_id`. Histórico só do atendimento atual (mesma fronteira de `get-lead-context.ts`), no máximo 6 mensagens, cada uma em uma linha e cortada em 300 caracteres. Nunca mídia, nunca anexos.
- Leitura de histórico e de fatos sob o mesmo teto de 500 ms que já existe; falha ou estouro: `log.warn` e classificação segue sem eles.
- `ai_router_decisions` continua sem texto do lead (comentário da tabela: "SEM PII").
- Textos em português sem travessão. Sem `console.log`. Comentários no tom dos vizinhos.
- **Suíte inteira em TODA task**, antes do commit: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (inteira, saída em arquivo, exit lido). Na Task 1 a 3 que tocam SQL ou o turno, também `pnpm test:db`. (Na entrega anterior um defeito só apareceu na suíte inteira, na última task.)
- Merge: PR verde + OK do dono no chat, e então o PR é entregue à sessão "Memória central", que faz merge, versão e instalação.

## Review Focus

1. **Retry do job depois da passagem**: o job morre no meio da reexecução e roda de novo. Esperado: o agente de destino responde uma vez só, nada em dobro. Invariante na Task 3.
2. **Passou e enviou no mesmo passo**: o modelo chama `send_message` e `transfer_to_subject` juntos. Esperado: sem reexecução, uma resposta só, dono novo gravado. Invariante na Task 3.
3. **Vai e volta**: o destino tenta passar de volta. Esperado: a ferramenta não existe na reexecução. Invariante na Task 3.
4. **Destino sem versão publicada, pausado ou arquivado**: a ferramenta devolve erro, o dono não muda, o agente de origem responde. Invariante na Task 3.
5. **Resposta curta com conversa em andamento**: "Quarta" classificada em outro assunto com 0,95 não troca; "está doendo" classificada em assunto de `interrompe` troca. Unit na Task 1.
6. **Histórico de atendimento anterior**: mensagens de antes da reabertura da conversa não entram no histórico do classificador. Invariante na Task 2.
7. **Roteador legado**: tudo igual a hoje. Unit nas Tasks 1, 2 e 3.

---

### Task 1: Modo de permanência no roteador

**Files:**
- Modify: `lib/agent-engine/agent/router-config.ts` (`LoadedRouter`, `montar`)
- Modify: `lib/agent-engine/agent/resolve-turn-agent.ts` (ramo `stickyMember`)
- Test: `lib/agent-engine/agent/router-config.test.ts`, `lib/agent-engine/agent/resolve-turn-agent.test.ts`

**Interfaces:**
- Produces, em `LoadedRouter`: `permanencia: 'roteador' | 'agente'` e `interrompe: string[]`.
- Produces, exportado de `resolve-turn-agent.ts`:

```ts
/** Regra única de troca com conversa em andamento. A rota de teste usa a mesma. */
export function mudouDeAssunto(
  router: Pick<LoadedRouter, 'permanencia' | 'interrompe' | 'minConfidence'>,
  assuntoAtual: string | null,
  verdict: IntentVerdict,
): boolean;
```

- [ ] **Step 1: Testes de `router-config` (RED).** `config: {}` → `permanencia: 'roteador'`, `interrompe: []`. `config: { permanencia: 'agente', interrompe: ['queixa_clinica', 7, ''] }` → `'agente'` e `['queixa_clinica']` (só strings não vazias). `permanencia: 'qualquer'` → `'roteador'`. `interrompe` que não é array → `[]`. Assunto em `interrompe` que não é membro do roteador fica na lista (não quebra; nunca casa).
- [ ] **Step 2: Implementar a leitura defensiva** em `montar`, no padrão de `sticky`/`min_confidence`.
- [ ] **Step 3: Testes de `mudouDeAssunto` e do ramo sticky (RED)**, no `describe('resolveTurnAgent')`, com `makeDeps`:
  - modo `'roteador'` (hoje): os 16 casos existentes passam sem alteração;
  - modo `'agente'`, agente atual membro, classificador devolve outro assunto com 0,95 que NÃO está em `interrompe` → outcome `'sticky'`, agente atual mantido;
  - modo `'agente'`, classificador devolve assunto de `interrompe` com 0,95 → outcome `'reclassified'`, agente do assunto que interrompe;
  - modo `'agente'`, assunto de `interrompe` com confiança abaixo do mínimo → `'sticky'`;
  - modo `'agente'`, o assunto atual já É o de `interrompe` e o classificador repete → `'sticky'`;
  - modo `'agente'`, sem agente atual → classifica e escolhe como hoje (`'classified'` ou fallback);
  - modo `'agente'`, classificador falha → `'sticky'` (regra 4, sem mudança).
- [ ] **Step 4: Implementar.** `mudouDeAssunto` = `verdict.intentName !== null && verdict.intentName !== assuntoAtual && verdict.confidence >= router.minConfidence && (router.permanencia === 'roteador' || router.interrompe.includes(verdict.intentName))`. O ramo `stickyMember` passa a chamá-la. Atualize o cabeçalho de regras do arquivo com a regra nova, numerada.
- [ ] **Step 5: Suítes** (`typecheck`, `lint`, `test:unit` inteira). **Commit** `feat(roteador): modo em que só assunto marcado interrompe a conversa em andamento`.

### Task 2: O classificador vê a conversa recente

**Files:**
- Create: `lib/agent-engine/agent/historico-recente.ts` + `historico-recente.test.ts`
- Modify: `lib/agent-engine/agent/intent-classifier.ts` (+ teste), `lib/agent-engine/agent/resolve-turn-agent.ts` (+ teste)
- Test: `tests/invariants/roteador-historico-recente.test.ts`

**Interfaces:**
- Produces:

```ts
export const MAXIMO_DE_MENSAGENS_NO_HISTORICO = 6;
export interface MensagemRecente { direction: 'inbound' | 'outbound'; texto: string }
/** As últimas mensagens do atendimento ATUAL, da mais antiga para a mais nova, SEM a inbound mais recente (ela é o sinal). */
export async function historicoRecente(db: Queryable, organizationId: string, conversationId: string): Promise<MensagemRecente[]>;
export function renderHistoricoRecente(msgs: readonly MensagemRecente[]): string; // '' quando vazio
```

- `buildClassifierPrompt(members, signal, fatos?, contexto?: { historico?: string | null; assuntoAtual?: string | null })`
- `classifyIntent(..., input: { ...; fatos?; historico?: string | null; assuntoAtual?: string | null }, deps)`
- `ResolveTurnAgentDeps.historicoRecente?: typeof historicoRecente`

- [ ] **Step 1: `historico-recente.ts` com unit e invariante (RED primeiro).** SQL com a MESMA fronteira de `lib/agent-engine/edge/crm/get-lead-context.ts:230-247` (copie o predicado `exists(...)` e deixe um comentário apontando para lá: as duas consultas têm de andar juntas), `limit 7`, ordenado `sent_at desc, id desc`, depois invertido; se a mais nova for `inbound`, ela sai (é o sinal). O texto de cada mensagem vem de `corpoDaMensagem` (já exportado do mesmo arquivo), passa por `.replace(/\s+/g, ' ').trim().slice(0, 300)`; mensagem que fica vazia é descartada. Render:

```
Conversa recente deste atendimento (da mais antiga para a mais nova):
Lead: <texto>
Atendimento: <texto>
```

  Unit: render vazio é `''`; quebra de linha vira espaço; corte em 300; rótulos por direção. Invariante (seed de `tests/invariants/roteador-fatos-do-contato.test.ts` como modelo): conversa com 9 mensagens → 6 devolvidas, sem a última inbound; mensagens de um atendimento anterior (antes de fechar e reabrir a conversa: use `fn_service_status(..., 'closed', null)` e uma inbound nova, como faz `tests/invariants/reiniciar-teste-do-contato.test.ts`) NÃO aparecem; `organization_id` de outra organização → lista vazia; mensagem só de mídia sem transcrição não quebra.
- [ ] **Step 2: Prompt (RED/GREEN).** Sem `contexto`, ou com os dois campos vazios, o prompt é byte a byte o de hoje (compare com o texto por extenso que o arquivo de teste já tem, com e sem fatos). Com contexto, a ordem é: intenções, `- none`, fatos (se houver), histórico (se houver), linha `Assunto atual da conversa: <nome>` (se houver), instrução, mensagem, instrução de JSON. A instrução depois do bloco, quando há assunto atual:

```
Se a mensagem só continua a conversa (resposta curta, confirmação, um dado pedido), responda none. Só escolha outra intenção se a última mensagem do lead mudar claramente de assunto.
```

  Teste de igualdade com o prompt inteiro por extenso, nos casos: só histórico; só assunto atual; os dois com fatos.
- [ ] **Step 3: Ligação em `resolveTurnAgent` (RED/GREEN).** Só quando `router.permanencia === 'agente'`: histórico e fatos são lidos juntos (`Promise.all`) dentro do `Promise.race` de 500 ms que já existe; cada um falha sozinho sem derrubar o outro (use `Promise.allSettled`). `assuntoAtual` = `input.stickyIntent` quando há agente atual membro. Testes: modo `'roteador'` não chama `historicoRecente` e não passa `historico`/`assuntoAtual`; modo `'agente'` passa os dois; histórico rejeita e fatos resolve → classificador recebe fatos e `historico: null`, com `log.warn`; estouro do teto → os dois nulos.
- [ ] **Step 4: Suítes** (`typecheck`, `lint`, `test:unit` inteira, `pnpm test:db`). **Commit** `feat(roteador): no modo novo o classificador vê a conversa recente e o assunto atual`.

### Task 3: A ferramenta `transfer_to_subject` e a reexecução

**Files:**
- Modify: `lib/agent-engine/agent/resolve-turn-agent.ts` (`TurnAgentResolution`)
- Create: `lib/agent-engine/agent/passagem-de-assunto.ts` + teste (schema estrito, bloco de sistema, função de efeito)
- Modify: `lib/agent-engine/agent/inbound-turn.ts` (`AGENT_TOOL_DEFS`, `rawTools`, blocos residentes, `pararQuando`, correção de turno mudo, `runAgentTurn`)
- Test: `tests/invariants/agent-transfer-to-subject-turn.test.ts` (modelo: `tests/invariants/agent-send-media-turn.test.ts`)

**Interfaces:**
- `TurnAgentResolution` ganha `assuntos?: Array<{ intentName: string; description: string; agentId: string }>` (todos os membros do roteador) e `permanencia?: 'roteador' | 'agente'`, preenchidos sempre que há roteador.
- `AgentTurnInput` ganha `passagem?: { deAgentId: string; deIntent: string | null }` (marca a reexecução).
- Em `passagem-de-assunto.ts`:

```ts
export const transferToSubjectInputSchema = z.strictObject({ subject: z.string().min(1).max(120), reason: z.string().min(1).max(300) });
export function blocoDaPassagem(outros: ReadonlyArray<{ intentName: string; description: string }>): string;
export async function gravarPassagem(db: pg.Pool, a: { tenantId: string; conversationId: string; routerId: string; jobId: string; destino: { agentId: string; intentName: string } }): Promise<void>;
```

- [ ] **Step 1: Módulo `passagem-de-assunto.ts` com unit (RED/GREEN).** `blocoDaPassagem` produz:

```
## Outros assuntos deste atendimento
Você atende um assunto. Se o que a pessoa quer agora é de outro assunto da lista abaixo, chame `transfer_to_subject` ANTES de responder e não envie nenhuma mensagem neste turno: outro atendente, com o roteiro certo, responde a mesma mensagem. Não conduza você o atendimento de outro assunto. Na dúvida entre ficar e passar, pergunte à pessoa.
- <intentName>: <descrição cortada em 240 caracteres>
```

  `gravarPassagem`: `update conversations set active_ai_agent_id=$3, active_intent=$4, active_agent_set_at=now() where organization_id=$1 and id=$2`, e `insert into ai_router_decisions (organization_id, router_id, conversation_id, intent_name, confidence, agent_id, outcome, job_id) values (..., null, ..., 'reclassified', ...)`. Comentário `ponytail:` dizendo que `confidence` nulo marca a passagem pelo agente e que um outcome próprio pede migration.
- [ ] **Step 2: Invariante do turno completo (RED).** No modelo de `agent-send-media-turn.test.ts` (modelo fake com script de tool calls, Postgres real, roteador ativo com `config: { permanencia: 'agente', interrompe: [], min_confidence: 0.8 }` e dois membros publicados A e B, conversa com `active_ai_agent_id = A`). Casos:
  1. A chama `transfer_to_subject({ subject: 'b', reason: '...' })` sem enviar: a conversa passa a ter B como dono e `active_intent = 'b'`; existe uma linha em `ai_router_decisions` com `outcome='reclassified'`, `confidence is null`, `agent_id = B`; o turno é reexecutado com o system prompt de B; a mensagem enviada é a de B; há UMA linha `accepted` em `send_ledger` para o job; a correção de turno mudo não rodou para A.
  2. Na reexecução, a lista de ferramentas de B não tem `transfer_to_subject` e o system de B não tem o bloco "Outros assuntos".
  3. A envia texto e chama a ferramenta no mesmo passo: sem reexecução; uma mensagem enviada (a de A); dono novo é B.
  4. Destino sem versão publicada: a ferramenta devolve `{ ok:false, error:{ code:'destino_indisponivel' } }`; dono continua A; A responde.
  5. `subject` que não é membro, ou é o próprio assunto de A: `{ ok:false, error:{ code:'assunto_invalido' } }` com a lista dos válidos na mensagem.
  6. Retry: rode o handler do MESMO job duas vezes depois de uma passagem bem-sucedida (simule falha após o envio aceito, como o teste vizinho de retry faz): continua UMA mensagem aceita.
  7. Roteador com `permanencia` ausente: a ferramenta e o bloco não existem para A.
  8. Turno de follow-up (`followup_turn`) e prévia: a ferramenta não existe.
- [ ] **Step 3: Implementar em `inbound-turn.ts`.**
  - `AGENT_TOOL_DEFS.transfer_to_subject`: descrição "Passa esta conversa para o atendente de outro assunto. Use quando o que a pessoa quer agora não é o seu assunto. Depois de chamar, não envie nada: o outro atendente responde esta mesma mensagem."; schema largo `z.object({ subject: z.string(), reason: z.string() }).passthrough()`; validação real com `transferToSubjectInputSchema`.
  - Condição de existência conforme Global Constraints; acrescente a ferramenta a `rawTools` junto das condicionais (perto de `open_human_case`) e `blocoDaPassagem(outros)` aos blocos residentes sob a MESMA condição (regra do arquivo: bloco só nomeia ferramenta que o agente tem).
  - `execute`: valida. Se o turno já enviou algo (`seq > 0`), a passagem é aceita do mesmo jeito; só não há reexecução (caso 3). Carrega o destino com `loadPublishedAgentConfigById`; nulo ou `pausedAt` → `destino_indisponivel`. Chama `gravarPassagem`. Marca a closure `passagemPedida = { agentId, intentName }`. Devolve `{ ok:true, status:'conversa_passada', message:'Conversa passada. Encerre o turno AGORA sem enviar nada.' }`. Exceção: `noteRunError` e `internal_error`, como as vizinhas.
  - Parada: `pararQuando` passa a ser `() => passagemPedida !== null || (prévia assistida ? ... : false)`, preservando o predicado atual da prévia.
  - `passagemPedida !== null` entra em `turnoMudoPedeCorrecao` como motivo para NÃO corrigir (ao lado de `passouParaAEquipe`).
  - O núcleo devolve a passagem a quem chamou (campo no resultado do turno; siga a forma do retorno existente). Em `runAgentTurn`: se veio passagem, `seq === 0` e `input.passagem === undefined`, reexecuta uma vez com `{ ...input, resolvedAgent: { config: <destino>, routerId, intentName: <destino>, confidence: null, outcome: 'reclassified', assuntos, permanencia }, passagem: { deAgentId, deIntent } }`. Na reexecução o bloco de gravação de decisão (`IT:2370-2402`) NÃO grava de novo (a passagem já gravou): pule quando `input.passagem` existe.
  - Operador: se o turno de origem entregaria ferramentas ao Operador (`enqueueJob` de `operator_turn`, `IT:4813`), isso não deve acontecer num turno que passou a conversa. Confira a ordem e pule o enfileiramento quando `passagemPedida !== null`; cubra com um caso no invariante se o caminho for alcançável.
- [ ] **Step 4: Suítes** (`typecheck`, `lint`, `test:unit` inteira, `pnpm test:db`). **Commit** `feat(agente): passar a conversa para outro assunto do roteador, com o destino respondendo a mesma mensagem`.

### Task 4: Rota de teste com conversa simulada

**Files:**
- Modify: `app/api/v1/ai/routers/[id]/test/route.ts` + `route.test.ts`, `hooks/ai/useRouters.ts` (só os tipos)

**Interfaces:**
- Corpo: `{ message, contact_id?, history?: Array<{ direction: 'inbound' | 'outbound'; body: string }> /* máx. 6, body máx. 1000 */, current_intent?: string }`
- Resposta ganha: `kept_current: boolean` (a conversa ficaria com o assunto atual) e `mode: 'roteador' | 'agente'`. `agent_id`/`agent_name` passam a refletir o agente FINAL (o do assunto atual, quando `kept_current`).

- [ ] **Step 1: Testes (RED).** Sem `history` nem `current_intent`: resposta igual à de hoje, mais `kept_current: false` e `mode`. Com `current_intent` que não é membro: 422 `validation_failed`. Roteador `'agente'`, `current_intent: 'a'`, classificador devolve `'b'` (0,95) fora de `interrompe`: `kept_current: true`, agente de `'a'`. Mesmo cenário com `'b'` em `interrompe`: `kept_current: false`, agente de `'b'`. Roteador `'roteador'` com `current_intent`: aplica a regra antiga (troca com 0,95). `history` com 7 itens: 422. O `history` vai ao classificador pelo mesmo `renderHistoricoRecente` (afirme o texto recebido) e só quando o modo é `'agente'`.
- [ ] **Step 2: Implementar** usando `mudouDeAssunto` (Task 1) e `renderHistoricoRecente` (Task 2). Nada é gravado; cabeçalho da rota atualizado.
- [ ] **Step 3: Suítes** (`typecheck`, `lint`, `test:unit` inteira). **Commit** `feat(roteador): o teste aceita conversa simulada e assunto atual`.

### Task 5: Fragmento, documentação e suítes finais

**Files:**
- Create: `.changes/roteador-passagem-pelo-agente.md`
- Modify: `docs/architecture/agent-turn.workflow.json`, `docs/testing/user-journey-map.md`, `docs/superpowers/specs/2026-10-12-roteador-com-contexto-e-troca-pelo-agente-design.md` (registrar os três desvios e os fatos conferidos), `.agents/skills/deskcomm-cliente-novo/references/pela-tela.md` §10 (uma linha sobre o modo novo, e regerar o espelho `.claude/skills` como o repo faz)

- [ ] **Step 1: Fragmento:**

```markdown
---
impacto: capacidade_nova
secao: adicionado
titulo: O agente pode passar a conversa para outro assunto do roteador
---
Roteadores ganham um modo opcional em que a troca de agente no meio da conversa deixa de ser decidida mensagem a mensagem. Com ele ligado, o roteador escolhe quem começa a conversa e só interrompe um atendimento em andamento para os assuntos marcados como urgentes; fora disso, é o próprio agente que passa a conversa para outro assunto, e o agente de destino responde a mesma mensagem, sem o cliente precisar repetir. Nesse modo o classificador também vê as últimas mensagens da conversa, que passam a ser enviadas ao provedor de IA configurado para o roteador. O teste do roteador aceita uma conversa simulada pela API. Roteadores que não ligarem o modo novo continuam exatamente como estavam; nada precisa ser feito ao atualizar.
```

- [ ] **Step 2: Mapa** (nó ou arestas da passagem, com ≥2 arestas, e `pnpm exec vitest run tests/unit/mapas-de-arquitetura.test.ts`), jornada (linha não marcada, prova pela tela e em conversa real pendentes), desenho e guia.
- [ ] **Step 3: Suítes inteiras**, uma de cada vez, saída em arquivo e exit lido: `pnpm release:conferir`, `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:db`. Antes de `test:db`, `docker ps`: se outra sessão estiver rodando um `test-db`, espere terminar.
- [ ] **Step 4: Commit** `docs(roteador): fragmento, mapa e desenho da passagem pelo agente`. PR com o que foi medido e o que não foi (conversa real e tela pendentes). O PR não é mergeado por esta sessão: com o OK do dono, é entregue à Memória central.
