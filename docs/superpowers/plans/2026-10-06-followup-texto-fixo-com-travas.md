# Plano TDD: follow-up com as mesmas travas por qualquer caminho

Spec: [`docs/superpowers/specs/2026-10-06-followup-texto-fixo-com-travas-design.md`](../specs/2026-10-06-followup-texto-fixo-com-travas-design.md).
Os nomes D1–D7 abaixo remetem às decisões da spec.

## Regras para quem executa

- Trabalhe só no worktree `/Users/andreluislopescosta/crm-f2-followup-envio`, branch `fix/followup-texto-fixo-com-travas`. Use caminhos absolutos ou `git -C`.
- Cada passo segue a mesma ordem:
  1. escreva o teste;
  2. rode e veja **vermelho pelo motivo certo**;
  3. faça a mudança mínima;
  4. rode e veja verde;
  5. faça a **sabotagem** indicada, veja o teste ficar vermelho e desfaça;
  6. commit próprio.
- Commits em conventional commits, em português, terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Adicione arquivo por nome. Nada de `git add -A` ou `git add .`.
  - Confira `git status --short` antes de cada commit.
- Sem `console.log`. Não crie `.env.local`.
- Não toque em `lib/channels/pos-entrada.ts` nem em `components/inbox/Composer.tsx`.
- Nenhuma migration. Se algum passo parecer exigir schema, **pare e escale**: este item não tem número reservado.
- Comando de um arquivo, usado em cada passo:

  ```bash
  cd /Users/andreluislopescosta/crm-f2-followup-envio && pnpm vitest run <arquivo>
  ```

  O alias `V <arquivo>` nos passos significa este comando.

---

## Passo 0: ponto de partida

```bash
git -C /Users/andreluislopescosta/crm-f2-followup-envio fetch -q origin main
git -C /Users/andreluislopescosta/crm-f2-followup-envio merge --ff-only origin/main   # sem commits próprios além dos docs: FF; senão `git merge origin/main`
cd /Users/andreluislopescosta/crm-f2-followup-envio && pnpm install --frozen-lockfile
```

Grave a linha de base dos arquivos que o plano vai tocar, para separar vermelho pré-existente:

```bash
cd /Users/andreluislopescosta/crm-f2-followup-envio && pnpm vitest run \
  lib/followup lib/dev/kick-local-pipeline.test.ts tests/unit/template-vars.test.ts \
  tests/unit/followup-instagram-24h.test.ts tests/unit/camada-semantica-no-envio-fixo.test.ts \
  tests/unit/followup-canal-arquivado.test.ts tests/unit/followup-silencio-de-roteamento.test.ts \
  > /private/tmp/claude-501/-Users-andreluislopescosta-CRM-EVA/593e1a6a-d6d4-440d-bbe0-937b5ad1210e/scratchpad/b-base.log 2>&1; echo "exit=$?"
```

Qualquer falha aqui é pré-existente: registre nome e motivo no PR.

---

## Passo 1: ordem do webhook, com o porte de `f90f236aa` (defeito 2, D5)

**Testes primeiro.** Porte os testes do commit, com `git show f90f236aa -- <arquivo>` como fonte.

1. `lib/dev/kick-local-pipeline.test.ts`: aplique o hunk do commit. O teste exige que `applyReactivityEvent` rode **antes** do `select` de `waiting_reply` de `aplicarTextoNosFollowups`.
2. `lib/followup/node-handlers.test.ts`: aplique o hunk do commit. Um `match_reply` acordado sem texto desta pergunta fica em `wait`/`waiting_reply`.
3. `lib/followup/engine-match-reply-inbound.test.ts` (arquivo novo).
   - Fonte: os casos de `git show f90f236aa:lib/followup/engine-match-reply-inbound.test.ts`.
   - Ajuste os imports para o fork.
   - O caso: a ocupação de `wait_started` recém-gravada não vira timeout.
4. `lib/followup/reactivity-acordar.test.ts` (arquivo novo).
   - Fonte: os casos de `git show f90f236aa:lib/followup/reactivity-dormente.test.ts`.
   - O caso: um inbound com `sent_at` anterior ao `updated_at` da inscrição não acorda.

Rode `V` em cada um dos quatro. Todos devem falhar.

**Mudança mínima.**

```bash
cd /Users/andreluislopescosta/crm-f2-followup-envio && git show f90f236aa --format= -- \
  lib/dev/kick-local-pipeline.ts lib/followup/engine.ts lib/followup/node-handlers.ts | git apply -3
```

- Em `lib/followup/reactivity.ts`, aplique os hunks à mão:
  - `import { inboundEhDestaPergunta }`;
  - `updated_at?` em `LiveEnrollmentRef`;
  - a guarda no começo de `acordarPorInbound`;
  - `updated_at` no `select` (aqui o filtro é `LIVE_STATUSES`).
- Copie o fragmento do original para `.changes/followup-nao-dispara-tudo-de-uma-vez.md` (`git show f90f236aa:.changes/followup-nao-dispara-tudo-de-uma-vez.md`).
- Confira que `lib/channels/pos-entrada.ts` não mudou: `git diff --stat`.

**Verificação.** Rode `V` nos quatro arquivos e em `lib/followup`.

**Sabotagem.** Em `kick-local-pipeline.ts`, devolva `aplicarTextoNosFollowups` para antes de `acordarFollowupPorInbound`. O teste 1 tem de ficar vermelho.

**Commit:** `fix(followup): a resposta cancela antes de o texto avançar o fluxo (porte de f90f236aa)`

---

## Passo 2: humano ativo como fato da decisão (defeito 3, D4)

### 2a. Regra pura

**Testes primeiro**, em `lib/followup/bloqueios-obrigatorios.test.ts`:

- `fatos()` ganha `conversa: { bot_silenciado: false, atribuida_a_pessoa: false, humano_respondeu: false }`.
- Casos novos, um fato por vez:
  - `atribuida_a_pessoa: true` → `{envia:false, motivo:'atendimento_humano', invalida:true}`;
  - `humano_respondeu: true` → o mesmo;
  - `force_human: true` → o mesmo;
  - `bot_silenciado: true` → o mesmo.
- O caso existente da linha 86 passa a esperar `invalida: true`.
- `OUTCOME_DO_BLOQUEIO`: `atendimento_humano → 'handoff'`, `resposta_do_contato → 'replied'`, `opt_out → 'opted_out'`. Um motivo sem desfecho dá `undefined`.
- Controle positivo: todos os fatos limpos → `envia: true`. Esse caso já existe; confira que segue verde.

**Mudança** em `lib/followup/bloqueios-obrigatorios.ts`:

- os campos em `FatosDoEnvio.conversa`;
- `decidirEnvio`: os quatro sinais dão `atendimento_humano` com `invalida: true`;
- `TEXTO_DO_BLOQUEIO.atendimento_humano` vira "Sequência encerrada: uma pessoa da equipe está atendendo esta conversa.";
- exporte `OUTCOME_DO_BLOQUEIO`;
- reescreva o comentário das linhas 18-20, que dizia que atribuição não conta;
- crie `conferirAntesDoEnvio(pool, input, agora)`: `lerFatosDoEnvio`, depois `decidirEnvio`; leitura falha → `{envia:false, motivo:'nao_verificavel', invalida:false}`.

**Verificação.** `V lib/followup/bloqueios-obrigatorios.test.ts`.

**Sabotagem.** Remova `|| fatos.conversa.humano_respondeu` e veja o caso ficar vermelho.

### 2b. A consulta real (Postgres)

**Teste primeiro.** Crie `tests/invariants/followup-humano-ativo.test.ts`.

- Fixture: `criarOrigemDeFollowup` e `isolarFixtureDeFollowup`, como em `tests/invariants/sinal-integracao-t40-t60.test.ts`.
- Dados: uma inscrição viva, a conversa e um inbound.
- Casos, todos por `lerFatosDoEnvio`:
  - outbound com `sent_via='external_device'` **depois** do inbound → `humano_respondeu=true`;
  - o mesmo com `sent_via='user'` → `true`;
  - com `sent_via='ai'` → `false` (controle);
  - um humano **antes** do inbound → `false`;
  - um humano em **outra conversa** do contato → `false`;
  - conversa com `assignee_kind='user'` → `atribuida_a_pessoa=true`;
  - outra organização com o mesmo cenário não vaza: os filtros por `organization_id`.

**Mudança.** A consulta da conversa em `lerFatosDoEnvio` ganha as duas colunas da spec (D4).

**Verificação** (exige Docker):

```bash
cd /Users/andreluislopescosta/crm-f2-followup-envio && pnpm test:db > /private/tmp/claude-501/-Users-andreluislopescosta-CRM-EVA/593e1a6a-d6d4-440d-bbe0-937b5ad1210e/scratchpad/b-db-2b.log 2>&1; echo "exit=$?"
grep -aE "Test Files|Tests |Errors " /private/tmp/claude-501/-Users-andreluislopescosta-CRM-EVA/593e1a6a-d6d4-440d-bbe0-937b5ad1210e/scratchpad/b-db-2b.log
```

**Sabotagem.** Troque `('user','external_device')` por `('user')`: o caso do celular fica vermelho.

### 2c. A ponte grava o desfecho

**Teste primeiro.** Em `lib/followup/turn-bridge.test.ts`, `completeTurnForEnrollment(..., {kind:'skipped', reason:'x', outcome:'handoff'})` faz o patch levar `status:'cancelled'`, `outcome:'handoff'` e `cancel_reason:'x'`. Sem `outcome`, o patch não tem a chave: é o controle.

**Mudança.**

- `TurnResult.skipped` ganha `outcome?: EnrollmentOutcome`.
- `applyStep` do `skipped` (`turn-bridge.ts:133-136`) inclui `outcome` quando presente.
- `FollowupFlowTurnResult` (`followup-turn.ts:106-111`) ganha o mesmo campo. É tipo espelho: o agent-engine não importa `followup/*`, então use a união literal.

**Sabotagem.** Tire o `outcome` do patch.

### 2d. O worker usa a decisão compartilhada

**Teste primeiro.** Crie `tests/unit/followup-humano-ativo-no-turno.test.ts`, com o harness de `tests/unit/followup-instagram-24h.test.ts`: `fakePool`, `runBeforeSend` e `runAgentTurn` mockados. A conversa devolve `humano_respondeu: true`. Casos:

- modo texto: `runBeforeSend` não é chamado;
- modo `ai_message`: `runAgentTurn` não é chamado;
- nos dois modos, `completeFollowupTurn` recebe `{kind:'skipped', reason: TEXTO_DO_BLOQUEIO.atendimento_humano, outcome:'handoff'}`;
- controle: tudo limpo → texto chega a `runBeforeSend`.

**Mudança** em `followup-turn.ts`:

- as linhas 369-377 viram `conferirAntesDoEnvio(pool, …, clock())`;
- o ramo `invalida` passa `outcome: OUTCOME_DO_BLOQUEIO[motivo]`;
- remova o comentário "atendimento_humano: segue…" (`:421-422`). Agora todo motivo humano retorna antes.

**Verificação.** Rode `V` neste arquivo e em `tests/unit/followup-*.test.ts` e `tests/unit/camada-semantica-no-envio-fixo.test.ts`.

**Sabotagem.** Deixe `atendimento_humano` com `invalida:false` em `decidirEnvio`: o arquivo fica vermelho.

**Commit (2a–2d juntos):** `fix(followup): humano ativo encerra a sequência em todos os modos`

---

## Passo 3: o atalho aplica a mesma decisão (defeito 1, D1–D3)

**Testes primeiro.** Em `lib/followup/enviar-texto-fixo.test.ts`, acrescente estes mocks:

- `@/lib/agent-engine/db/request-pool` (`getRequestPool: () => ({})`);
- `@/lib/followup/bloqueios-obrigatorios` (`conferirAntesDoEnvio` controlável; `TEXTO_DO_BLOQUEIO` e `OUTCOME_DO_BLOQUEIO` reais via `importOriginal`);
- `@/lib/automation/janela-do-canal` (`adiarAteAJanelaAbrir` controlável, `null` por padrão);
- `@/lib/automation/throttle` (`espacarEnvio` espião).

A conversa do stub passa a devolver `channel_session_id`. Casos:

| Veredito de `conferirAntesDoEnvio` | O que se espera |
|---|---|
| `resposta_do_contato`, invalida | `sendMessageHandler` **não** é chamado; `completeTurnForEnrollment` recebe `{kind:'skipped', reason, outcome:'replied'}`; o settle sai com `p_done:true`. |
| `atendimento_humano`, invalida | O mesmo, com `outcome:'handoff'`. |
| `etapa_bloqueia_followup` | Recebe `skipped` sem `outcome`. |
| `fora_da_janela` | Não envia; o settle sai com `p_done:false`, `p_hold:true` e `p_retry_at` igual à abertura. |
| `nao_verificavel` | Não envia; o settle sai com `p_done:false`, `p_hold:false` (falha fechada, gasta tentativa). |
| `inscricao_encerrada` | Não envia; o settle sai com `p_done:true`; não fecha o turno. |
| `fora_das_24h_do_instagram`, pula | `completeTurnForEnrollment` recebe `pulado`. |
| `envia:true` com `adiarAteAJanelaAbrir` devolvendo um ISO | Não envia; `p_hold:true` com esse `p_retry_at`. |
| `envia:true` com a janela do canal aberta | `espacarEnvio(canal)` é chamado **antes** de `sendMessageHandler`; envia. |

Os casos existentes (elegibilidade, Instagram) continuam verdes, com `conferirAntesDoEnvio` devolvendo `envia:true`.

**Mudança** em `lib/followup/enviar-texto-fixo.ts`:

- `settle` ganha o adiamento genérico: `adiar?: { ate: string }` → `p_retry_at: ate`, `p_hold: true`. O caminho da agenda (`AgendaDeferredError`) continua igual.
- A ordem dentro do `try` fica:
  1. inscrição viva;
  2. fronteira;
  3. `conferirAntesDoEnvio(getRequestPool(), {organizationId, contactId, conversationId, enrollmentId}, new Date())`, traduzindo o veredito como na tabela da spec (D2);
  4. elegibilidade (fica, para allowlist e pré-go-live);
  5. Instagram (fica);
  6. `adiarAteAJanelaAbrir(admin, org, channelSessionId)`;
  7. agenda;
  8. `espacarEnvio(channelSessionId)`;
  9. envio.
- A consulta da conversa (`:137-142`) passa a pedir também `channel_session_id`.

**Verificação.** `V lib/followup/enviar-texto-fixo.test.ts`. Depois rode `V tests/api/followup-cron-worker.test.ts` e confira que segue verde; se ele monta o atalho sem pool, mocke `request-pool` lá.

**Sabotagem.**

1. Comente a chamada a `conferirAntesDoEnvio`: os casos 1–6 ficam vermelhos.
2. Comente `adiarAteAJanelaAbrir`: o caso da janela do canal fica vermelho.

**Commit:** `fix(followup): o texto fixo pelo atalho passa pela mesma decisão de envio do worker`

---

## Passo 4: `{{nome}}` e `{{primeiro_nome}}` (defeito 4, D6)

### 4a. Helper

**Testes primeiro** em `tests/unit/template-vars.test.ts`. Os casos atuais continuam iguais (o modo padrão é `manter`). Novos casos:

- `nomeDoContato({name:null, display_name:'Ana Souza'})` → `'Ana Souza'`;
- `name` com só espaços cai no `display_name`;
- `name` tem precedência sobre `display_name`;
- `interpolateTemplate('Oi {{primeiro_nome}}', {name:null, display_name:'Ana Souza'})` → `'Oi Ana'`;
- a tabela de remoção da spec D6 com `{semValor:'remover'}`, os cinco exemplos;
- `{{codigo}}` desconhecida continua literal mesmo em `remover`;
- sem nome em `manter` → literal (controle da caixa de entrada).

**Mudança** em `lib/inbox/template-vars.ts`:

- `TemplateContact` ganha `display_name?`;
- crie `nomeDoContato`;
- a opção `semValor` e a remoção local (spec D6).
- O cabeçalho do arquivo diz que variável sem valor "mantém o literal": atualize para os dois modos.

**Sabotagem.** Faça `nomeDoContato` ignorar o `display_name`.

### 4b. Caixa de entrada

**Mudança.** Em `components/inbox/InboxLayout.tsx:614`: `contactName={nomeDoContato(selectedConversation.contacts ?? {}) || null}`. O tipo de `contacts` já tem `display_name` (`lib/types/contacts.ts:9`).

**Verificação.** `pnpm typecheck`. O composer só repassa o valor; a regra testada é a do 4a.

### 4c. Worker

**Teste primeiro.** Crie `tests/unit/followup-variaveis-do-contato.test.ts`, no harness do passo 2d. O `fakePool` responde a `select name, display_name from contacts`.

- Modo texto `"Ei, {{primeiro_nome}}, tá por aí?"`, com `display_name='João Lima'` e `name=null`: `runBeforeSend` recebe `body:'Ei, João, tá por aí?'`.
- O mesmo sem nome nenhum: recebe `'Ei, tá por aí?'`.
- Modo modelo, com corpo `"Olá {{nome}}"` vindo de `message_templates`: recebe `'Olá João Lima'`.
- `{{volta}}` continua funcionando junto.

**Mudança.** Em `resolveFlowSendBody` (`followup-turn.ts:551-575`), depois da volta, leia o contato:

```sql
select name, display_name from contacts where organization_id=$1 and id=$2
```

O `contactId` vem de `target.leadId`, passado como argumento. Aplique `interpolateTemplate(corpo, contato, {semValor:'remover'})`.

**Sabotagem.** Tire a chamada: os três casos ficam vermelhos.

### 4d. Atalho

**Teste primeiro.** Em `enviar-texto-fixo.test.ts`, o job com `fixed_body:'Oi {{primeiro_nome}}!'` e o stub de `contacts` devolvendo `{name:null, display_name:'Bia Ramos'}`: `sendMessageHandler` recebe `body:'Oi Bia!'`. Sem nome, recebe `'Oi!'`.

**Mudança.** Leia `contacts.name` e `contacts.display_name` com `.eq('organization_id', org).eq('id', contactId)` e interpole antes de `sendWithLedger`. O `body` interpolado é o que vai para o ledger, porque o hash é do texto que saiu.

**Sabotagem.** Envie `body` cru.

### 4e. Dica na tela do passo

**Mudança.** No `ActionForm.tsx`, ao lado de `{{volta}}`, uma frase curta:

> {{nome}} e {{primeiro_nome}} viram o nome do contato; sem nome, a variável sai do texto.

Use `t()` e ponha a entrada `es` em `lib/i18n/dicionario.ts`.

**Verificação.**

```bash
V tests/unit/i18n-espanhol-cobre-a-tela.test.ts tests/unit/idioma-da-interface.test.ts tests/unit/i18n-a-data-segue-o-idioma.test.ts
```

**Commit (4a–4e):** `fix(followup): {{nome}} e {{primeiro_nome}} saem preenchidos no follow-up e na caixa de entrada`

---

## Passo 5: modelo de reserva (defeito 5, D7)

### 5a. O payload carrega o campo (porte de `b94446a5c`, só o encanamento)

**Teste primeiro.** Em `tests/invariants/followup-engine.test.ts`, ao lado do caso `ai_message` (cerca da linha 309): um nó `{mode:'ai_message', prompt_hint:'x', fallback_template_id:<uuid>}`. O job enfileirado tem `payload.fallback_template_id` igual a esse uuid. Controle: sem o campo no nó, a chave não existe no payload.

**Mudança.** Copie os hunks de `git show b94446a5c -- lib/followup/engine.ts` **só** destes dois pontos:

- o campo `fallback_template_id?` em `FollowupJobRequest.payload`;
- o ramo `ai_message` de `turnPayloadExtras`.

Não traga `retornoQueSeguraOFluxo` nem `held_by_return`.

**Verificação.** O passo 5a é coberto pelo `pnpm test:db` do passo 6.

### 5b. O turno lê o campo e envia a reserva

**Teste primeiro.** Crie `tests/unit/followup-modelo-de-reserva.test.ts`, no harness do passo 2d. O ledger do `fakePool` é configurável, e o `message_templates` devolve `"Oi {{primeiro_nome}}, ainda posso ajudar?"`. Casos:

1. **IA sem envio, ledger vazio, travas limpas.** `runBeforeSend` é chamado uma vez com o corpo da reserva interpolado. O `channel.send` usa `seq: 1000`. `completeFollowupTurn` recebe `{kind:'sent', via:'modelo_de_reserva'}`.
2. **IA enviou** (ledger `accepted`). A reserva não é chamada; o resultado é `sent` sem `via`. É o controle.
3. **Humano entrou durante o turno.** A segunda leitura dá `humano_respondeu: true`. A reserva não sai, e o resultado é `skipped` com `outcome:'handoff'`.
4. **Contato não elegível** (allowlist). A reserva não sai, e o resultado é o `skipped` original.
5. **Reserva vetada pela cadeia** (`runBeforeSend` → `vetoed`, não janela). O resultado é `skipped` com o motivo "A IA não enviou a mensagem e o modelo de reserva também foi recusado pelas regras do atendimento."
6. **Reserva adiada pela janela anti-ban** (`vetoed` com `outside_window`). `completeFollowupTurn` **não** é chamado.
7. **`runAgentTurn` lança `Error('llm')`:**
   - com `attempts < max_attempts`: relança, e a reserva não é tentada;
   - com `attempts === max_attempts`: a reserva sai e o resultado é `sent` via reserva;
   - se a reserva também é vetada: o erro original é relançado.
8. **`runAgentTurn` lança `JobSettledError`** (janela). Relança, e a reserva não é tentada.
9. **Retry depois de queda.** O ledger já tem seq 1000 `accepted`. `runAgentTurn` **não** é chamado, e o resultado é `sent` via reserva.
10. **Sem `fallback_template_id`.** O comportamento é o de hoje (`skipped` "O assistente concluiu…").

**Mudança** em `lib/agent-engine/agent/followup-turn.ts`. Mantenha os nomes do original:

- `fallback_template_id: z.string().uuid().optional()` no schema;
- `fallbackTemplateId: payload.fallback_template_id` na chamada;
- o campo na assinatura de `runFlowDrivenTurn`;
- `const SEQ_DO_MODELO_DE_RESERVA = 1000`;
- `sendFixedOutbound` ganha um último parâmetro `seq = 1`, usado em `channel.send` (`:671`);
- uma função local `tentarModeloDeReserva(...)` com o fluxo da spec D7:
  - `conferirAntesDoEnvio`;
  - `decidirElegibilidadeDaConversa`, de `lib/ai/elegibilidade/consulta-pg` (o mesmo que `inbound-turn.ts` usa);
  - `resolveFlowSendBody({templateId: fallback, ...})`;
  - `sendFixedOutbound(..., false, SEQ_DO_MODELO_DE_RESERVA)`.
- `reconcileAcceptedSend` (já exportado de `send-ledger.ts`) antes de `runAgentTurn`.
- `FollowupFlowTurnResult.sent` ganha `via?: 'modelo_de_reserva'`.

**Sabotagem.**

1. Pule `tentarModeloDeReserva`: os casos 1 e 7b ficam vermelhos.
2. Tire a reconferência: o caso 3 fica vermelho.
3. Use `seq` 1: o caso 9 fica vermelho, porque a reserva viraria `already_sent` da tentativa da IA.

### 5c. Ponte e dossiê

**Testes primeiro.**

- `lib/followup/turn-bridge.test.ts`: `{kind:'sent', via:'modelo_de_reserva'}` grava `action_sent` com `payload {via:'modelo_de_reserva'}`. Sem `via`, o payload é `{}` (controle).
- `lib/followup/eventos-legiveis.test.ts`: `action_sent` com esse `via` tem o `detalhe` "pelo modelo de reserva: a IA não escreveu a mensagem". Sem `via`, o detalhe é `null`.

**Mudança.**

- `TurnResult.sent` ganha `via?`; o `applyStep` do `sent` passa `result.via ? {via} : {}`.
- `descreveEvento('action_sent')` lê `p.via`.
- Se o `detalhe` passa por `t()` na tela, ponha a entrada `es` no dicionário. Confira com os três guardas de i18n do passo 4e.

**Commit (5a–5c):** `fix(followup): o modelo de reserva sai quando a IA não envia, pelas mesmas travas`

---

## Passo 6: fechamento

1. **Fragmento de release.** Crie `.changes/followup-mesmas-travas-em-todo-envio.md` com `impacto: nada_mudou`, `secao: corrigido` e um texto para o operador. O texto cobre:
   - janela e resposta valem para o texto fixo;
   - o follow-up não fala por cima de quem está atendendo;
   - o nome do contato sai preenchido;
   - o modelo de reserva funciona.

   Confira com `pnpm release:conferir`.
2. **Mapa vivo.** Em `docs/architecture/followup-dossie.architecture.json`, registre a aresta nova do atalho para `conferirAntesDoEnvio` e o evento `action_sent.via`. Rode o teste do mapa: `V tests/unit/mapas-de-arquitetura.test.ts`.
3. **Gates.**

   ```bash
   cd /Users/andreluislopescosta/crm-f2-followup-envio
   pnpm typecheck && pnpm lint
   S=/private/tmp/claude-501/-Users-andreluislopescosta-CRM-EVA/593e1a6a-d6d4-440d-bbe0-937b5ad1210e/scratchpad
   pnpm test:unit > $S/b-unit.log 2>&1; echo "exit=$?"
   grep -aE "^ *(Test Files|Tests|Errors) " $S/b-unit.log
   grep -aE "^ *FAIL " $S/b-unit.log | sed 's/ > .*//' | sort | uniq -c
   pnpm test:db > $S/b-db.log 2>&1; echo "exit=$?"
   grep -aE "^ *(Test Files|Tests|Errors) " $S/b-db.log
   ```

   - O exit code é a autoridade.
   - Compare a contagem de `FAIL` com o `Tests N failed` do rodapé.
   - Uma falha que também aparece no `b-base.log` do passo 0 é pré-existente: registre.
   - Uma falha nova que está fora dos arquivos tocados também precisa ser provada como pré-existente. Rode o arquivo isolado e leia a causa no código da `origin/main`.
4. **Prova pela tela** (DoD 12, porque toca a caixa de entrada e o editor do passo). Num ambiente fresco estilo VPS (receita do CLAUDE.md), rode as specs que exercitam o atalho:

   ```bash
   pnpm exec playwright test --workers=1 tests/e2e/followup-journey.spec.ts \
     tests/e2e/followup-dossie.spec.ts tests/e2e/j20-elegibilidade-followup.spec.ts
   ```

   Acrescente o screenshot de um modelo com `{{primeiro_nome}}` aplicado no composer, para um contato só com `display_name`, em `.superpowers/evidence/`.
5. **Afirmações de estado** (DoD 16). Procure "conversa apenas ATRIBUÍDA" e "texto fixo" em `docs/current-state.md` e `docs/testing/user-journey-map.md`. Corrija só o que este PR mudou.
6. **Antes do PR**, confira de novo que nenhum número de migration foi usado: `git diff origin/main --stat -- supabase/` tem de vir vazio.

**Commit:** `docs(followup): fragmento de release, mapa vivo e afirmações de estado do envio com travas`
