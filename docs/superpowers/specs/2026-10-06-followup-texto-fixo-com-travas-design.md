# Follow-up: o passo sai com as mesmas travas por qualquer caminho — design

- **Data:** 2026-10-06
- **Branch:** `fix/followup-texto-fixo-com-travas` (criada da `origin/main` em `5b2e640f3`)
- **Escopo:** item B do levantamento do funil comercial (envio dos passos de follow-up).
  Contexto de negócio: `docs/superpowers/specs/2026-10-05-funil-comercial-dr-andre-design.md`, seções 5 e 6 (no checkout principal).
- **Schema:** nenhuma mudança. Sem migration, sem apêndice no `baseline.sql`, sem linha no MANIFEST.
  Os números 0323 e 0324 são de outros itens (lembrete e silêncio) e este item não usa número nenhum.

---

## 1. Problema medido (código da `origin/main`, conferido linha a linha)

### 1.1 O atalho do texto fixo envia sem a decisão de envio

`enviarTextoFixoPendente` (`lib/followup/enviar-texto-fixo.ts:48-176`) pega jobs `followup_turn` pendentes que têm `fixed_body`, faz o claim e envia direto por `sendMessageHandler` (`:153-161`). Ele tem cinco chamadores, e todos rodam no processo do app:

| Chamador | Onde |
|---|---|
| cron `followup-flow-worker` (1×/min) | `app/api/v1/cron/followup-flow-worker/route.ts:147` |
| relógio HTTP | `lib/relogio/executar.ts:143` |
| chegada de mensagem (via `aplicarTextoNosFollowups`) | `lib/followup/aplicar-inbound.ts:145` |
| aceleração do contato no webhook | `lib/dev/kick-local-pipeline.ts:123` |
| handler de event_log `followup-reactivity.v1` (via `aplicarTextoNosFollowups`) | `lib/followup/reactivity.handler.ts:25` |

O que o atalho confere: a inscrição viva e no mesmo nó (`:93-102`), a fronteira de atendimento (`:103-104`), a elegibilidade da conversa (`:112-127`), as 24h do Instagram (`:137-148`), a proteção de agenda (`:151`) e, no handler, `is_blocked` e o canal.

O que o worker confere e o atalho não: `decidirEnvio` (`lib/followup/bloqueios-obrigatorios.ts:270-355`), chamado só em `runFlowDrivenTurn` (`lib/agent-engine/agent/followup-turn.ts:369-377`). Por isso, no atalho faltam:

- a janela de envio da organização;
- a resposta do contato com `cancel_on_reply`, conferida na hora;
- etapa que bloqueia follow-up;
- contato anonimizado;
- sequência concorrente, consulta confirmada e prazo do sinal.

Também falta a cadeia `runBeforeSend` (`followup-turn.ts:647-672`): janela anti-ban do canal (7h–22h), ritmo e caps, repetição, LGPD e as promessas.

Os dois caminhos disputam o mesmo job. O worker consulta a fila a cada 2 s; o atalho roda a cada minuto e a cada mensagem. Quem fizer o claim primeiro envia, e o `send_ledger` só impede o envio em dobro. Num self-host, então, é sorte se a janela da organização vale para um passo de texto fixo.

### 1.2 Ordem no webhook: o passo sai antes de a resposta cancelar

`acelerarPipelineDeEventos` (`lib/dev/kick-local-pipeline.ts:128-146`), chamado por `lib/channels/pos-entrada.ts:126`, roda `aplicarTextoNosFollowups` (`:135`) **antes** de `acordarFollowupPorInbound` (`:141`).

`aplicarTextoNosFollowups` (`lib/followup/aplicar-inbound.ts:109-148`) não olha `cancel_on_reply`. Ele aplica a resposta aos `match_reply`, avança inscrições `active` vencidas e chama o atalho. Com `cancel_on_reply` ligado, isso já basta para mandar um passo vencido, ou o próximo passo de um `match_reply`, antes de a reatividade cancelar a inscrição.

O handler de event_log já roda na ordem certa: reatividade, depois texto (`lib/followup/reactivity.handler.ts:21-31`). Quem está invertido é só o kick do webhook. O original (`upstream`) consertou isso em `f90f236aa`, com duas guardas que acompanham a troca (detalhe em D5).

### 1.3 Humano ativo não segura o passo

- `decidirEnvio` só vê `force_human` e `bot_silenciado` (`bloqueios-obrigatorios.ts:281-283`). E, mesmo assim, devolve `invalida: false`: o worker "segue adiante" (`followup-turn.ts:421-422`).
- A resposta pelo celular silencia o bot por só 5 min (`lib/escalacao/atendimento-manual.ts:96`). A do composer, também por 5 min (`app/api/v1/messages/_handler.ts:276`). Um passo que vence depois disso sai por cima de quem está atendendo.
- No worker, em texto e modelo, uma conversa atribuída a uma pessoa (`assignee_kind='user'`) não barra o envio: só `isLeadInHandoff` é consultado (`followup-turn.ts:618-621`). O comentário de `bloqueios-obrigatorios.ts:18-20` diz isso de propósito.
- No atalho, o bloqueio por elegibilidade dá `settle(done)` sem fechar o turno (`enviar-texto-fixo.ts:119-127`). A inscrição fica rechecando o nó até virar `dead`, cerca de 11h depois.
- No modo IA, o turno vira no-op (`lib/agent-engine/agent/inbound-turn.ts:1756-1759`, `:1771-1785`). O ledger fica vazio, o resultado é `skipped` com a frase "O assistente concluiu este passo sem enviar..." (`lib/agent-engine/edge/crm/send-ledger.ts:227-231`), e a inscrição é cancelada sem dizer o motivo real.

### 1.4 `{{nome}}` e `{{primeiro_nome}}` saem crus no follow-up

- O engine só troca `{{volta}}` e `{{voltas}}` (`lib/followup/engine.ts:234-238`).
- O worker faz a mesma troca no texto e no modelo (`followup-turn.ts:547-575`).
- O atalho manda o `fixed_body` como chegou.
- O helper que troca o nome (`lib/inbox/template-vars.ts:10-19`) só é usado pelo composer. Ele lê `contacts.name`, que costuma estar vazio para quem chega pelo WhatsApp: o nome do perfil fica em `contacts.display_name`. A caixa de entrada passa só `contacts?.name` (`components/inbox/InboxLayout.tsx:614`), e a variável fica crua.

### 1.5 O modelo de reserva do passo `ai_message` não existe na execução

- A tela promete "Se a IA não conseguir escrever, mandar este modelo" (`app/app/ai/followups/[id]/_components/forms/ActionForm.tsx:178-189`).
- A publicação **exige** o campo quando o caminho soma 24h ou mais (`lib/followup/validate-publish.ts:212-221`, `:327-333`).
- Mas o engine não repassa o campo (`engine.ts:245-246`), o schema do payload do turno nem o declara (`followup-turn.ts:63-101`), e nenhum código o lê.
- Quando a IA não envia, `resultadoDoEnvioDoFollowup` devolve `skipped` (`send-ledger.ts:212-236`), e `turn-bridge.ts:133-136` cancela a inscrição.

---

## 2. Comportamento exigido

1. **Uma decisão só, os dois caminhos.** O atalho e o worker chamam a mesma função antes de enviar. Ela lê os fatos e aplica `decidirEnvio`. Dá o mesmo veredito nos dois caminhos e leva à mesma consequência:
   - fora da janela da organização: adia para a abertura;
   - resposta com `cancel_on_reply`: encerra com `outcome='replied'`;
   - humano ativo: encerra com `outcome='handoff'`;
   - etapa que bloqueia, anonimizado, opt-out e os demais motivos que invalidam: encerra com o motivo;
   - fora das 24h do Instagram: pula o passo.

   Além disso, o atalho respeita a janela anti-ban **do canal**: fora dela, adia para a abertura. E espaça os envios com o ritmo da automação.
2. **Reatividade antes do texto no webhook.** No kick do webhook, `acordarFollowupPorInbound` roda antes de `aplicarTextoNosFollowups`. Isso vem do porte de `f90f236aa`, com as duas guardas dele.
3. **Trava de humano ativo, em todos os modos.** Não envia, e encerra a inscrição com `outcome='handoff'` e um motivo legível, quando a conversa da inscrição tem qualquer um destes sinais:
   - uma mensagem de saída **humana** depois da última mensagem recebida do contato;
   - a conversa está atribuída a uma pessoa (`assignee_kind='user'`);
   - o contato está com `force_human`;
   - o bot está silenciado, exceto o silêncio de roteamento.

   Mensagem humana é `direction='outbound'` com `sent_via in ('user','external_device')`: o composer grava `user` (`_handler.ts:553`) e o celular grava `external_device` (`lib/waha/ingest.ts:837`). IA, automação e o próprio follow-up gravam `ai`. A inscrição nunca fica rechecando até morrer.
4. **Variáveis no texto e no modelo do follow-up.**
   - `{{nome}}` vira `contacts.name` e, na falta dele, `contacts.display_name`. `{{primeiro_nome}}` vira a primeira palavra desse nome.
   - Sem nenhum dos dois, a variável sai do texto e a pontuação e o espaço em volta se ajustam: `"Ei, {{primeiro_nome}}, tá por aí?"` vira `"Ei, tá por aí?"`.
   - O helper compartilhado ganha o fallback do `display_name`, e a caixa de entrada passa a usá-lo. Lá, sem nome nenhum, a variável continua literal (comportamento de hoje), porque quem vai enviar vê e corrige.
5. **O modelo de reserva funciona.** O passo `ai_message` com modelo de reserva termina sem envio quando a IA não manda nada: ledger vazio, tudo vetado, ou erro na última tentativa. Nesse caso:
   - as travas são conferidas de novo;
   - se nada bloqueia, o texto do modelo (com as variáveis trocadas) sai pela mesma porta guardada do texto fixo do worker, a cadeia `runBeforeSend` inteira;
   - o dossiê registra `action_sent` com `via: 'modelo_de_reserva'`.

   Os bloqueios (humano, opt-out, janela ou adiamento, anonimizado e os demais) nunca disparam a reserva.

---

## 3. Decisões e por quê

### D1. O atalho continua enviando, mas com a mesma decisão (não "só o worker")

A tarefa permite tirar do atalho o envio de follow-up, se isso for mais seguro. Medi o custo e não tirei:

- **O e2e não roda o `agent-worker`.** `.github/workflows/e2e.yml` não sobe o worker, e as specs de follow-up (`followup-journey`, `followup-dossie`, `followup-ramos`, `followup-tempo-adaptativo`, `j20-elegibilidade-followup`, `agenda-presenca-recuperacao`) dependem do POST em `/api/v1/cron/followup-flow-worker`. Esse POST envia pelo atalho (`tests/e2e/followup-journey.spec.ts:437`).
- Tirar o envio do atalho deixaria o check obrigatório `e2e` vermelho. Para consertar, seria preciso pôr o worker (WAHA, credenciais, rede) dentro do e2e, que é uma frente de infraestrutura própria.
- A instalação sem worker (cron da Vercel) ficaria sem texto fixo.

O que resolve o defeito é ter **uma única decisão**. Com ela, a disputa pelo job deixa de mudar o resultado nas regras do negócio.

### D2. A decisão vira uma função em `bloqueios-obrigatorios.ts`, lida pelo `pg` nos dois lados

`lerFatosDoEnvio` fala `pg` (`bloqueios-obrigatorios.ts:389-506`). O atalho fala Supabase, mas o app já tem um pool `pg` sob demanda, `getRequestPool()` (`lib/agent-engine/db/request-pool.ts`). Ele já é usado em `lib/campanhas/rodada.ts`, `lib/automation/actions/send-ai-message.ts` e `lib/mcp/tools/escalacao.ts`, e `SUPABASE_DB_URL` é obrigatória (`lib/env.ts:131`).

A mudança tem três partes:

- **`conferirAntesDoEnvio(pool, entrada, agora)`.** Chama `lerFatosDoEnvio`, depois `decidirEnvio`. Se a leitura falhar, devolve `nao_verificavel`.
- **Quem chama.** `runFlowDrivenTurn` troca o bloco das linhas 369-377 por essa chamada, e o atalho também a chama. Nenhuma consulta duplicada é reescrita em REST. Uma mesma pergunta não pode ter duas respostas.
- **`OUTCOME_DO_BLOQUEIO`.** Um mapa ao lado de `TEXTO_DO_BLOQUEIO`: `atendimento_humano → 'handoff'`, `resposta_do_contato → 'replied'`, `opt_out → 'opted_out'`.
  - `TurnResult` (`lib/followup/turn-bridge.ts:37-45`) e o espelho `FollowupFlowTurnResult` (`followup-turn.ts:106-111`) ganham `outcome?` no `skipped`.
  - A ponte grava o valor na coluna `outcome`. O CHECK já aceita esses três valores (`baseline.sql:7351`).

**Como o atalho trata cada veredito.** É o espelho do worker (`followup-turn.ts:378-423`):

| Veredito | O que o atalho faz |
|---|---|
| `pula` | O `pular()` que já existe. |
| `fora_da_janela` | O job volta para `pending` com `run_after` igual à abertura, sem gastar tentativa. Usa `fn_followup_inline_settle` com `p_hold=true` e `p_retry_at`; a função já existe e já é usada para o adiamento da agenda. |
| `invalida` | `completeTurnForEnrollment(..., {kind:'skipped', reason, outcome})` e `settle(done)`. |
| `inscricao_encerrada` | `settle(done)`. |
| `nao_verificavel` ou `configuracao_invalida` | Lança. O `catch` existente devolve o job para `pending` e gasta uma tentativa (falha fechada), como o `throw` do worker. |

O worker continua adiando pela janela da organização com `rescheduleReentry` (cron `at`). A forma do adiamento muda entre os dois caminhos, mas o efeito é o mesmo: o job reaparece na abertura e a regra é reavaliada.

### D3. No atalho: janela anti-ban do canal e ritmo, sim; o resto da cadeia, não

A cadeia `runBeforeSend` exige `getLeadContext` (`crmCfg`, contexto LGPD) e o adaptador de canal do worker. Montar isso dentro de um request de webhook seria reescrever o worker no app. O atalho fica com o que já existe pronto do lado do app, todo reaproveitado:

- **Janela anti-ban do canal.** `adiarAteAJanelaAbrir(admin, org, channel_session_id)` (`lib/automation/janela-do-canal.ts`). Ele aplica a **mesma regra pura** do pacing (`janelaDeEnvioAberta` e `proximaAberturaDaJanela`) sobre a mesma tabela `channel_knobs`, com os mesmos padrões. Fechada, o job é adiado como em D2.
- **Ritmo.** `espacarEnvio(channel_session_id)` (`lib/automation/throttle.ts:97`): 1,2 s mais jitter por número, igual ao das automações.

Fica só no worker o resto da cadeia: caps de warm-up e diário (contados no `pacing_ledger`), repetição, LGPD e as promessas. É o risco que sobra (ver §4). No atalho o texto é do operador, e o `sendMessageHandler` continua barrando `is_blocked`.

### D4. Humano ativo é um fato de `decidirEnvio`, e encerra

`FatosDoEnvio.conversa` ganha dois campos: `atribuida_a_pessoa` e `humano_respondeu`. Ambos são lidos na mesma consulta da conversa (`bloqueios-obrigatorios.ts:423-430`):

```sql
(c.assignee_kind = 'user') as atribuida_a_pessoa,
exists (
  select 1 from messages h
   where h.organization_id = c.organization_id and h.conversation_id = c.id
     and h.direction = 'outbound' and h.sent_via in ('user','external_device')
     and h.sent_at > coalesce((select max(i.sent_at) from messages i
                                where i.organization_id = c.organization_id
                                  and i.conversation_id = c.id and i.direction = 'inbound'),
                               '-infinity'::timestamptz)
) as humano_respondeu
```

O índice `idx_messages_conversation_sent (conversation_id, sent_at desc)` cobre as duas subconsultas.

Os quatro sinais (`force_human`, bot silenciado, atribuída a pessoa, humano respondeu) dão `atendimento_humano` com `invalida: true`. O texto passa a ser "Sequência encerrada: uma pessoa da equipe está atendendo esta conversa." e o outcome, `handoff`. Por quê:

- **`sent_via`, não `sent_by_user_id`.** O celular do dono não é necessariamente um usuário do CRM (`atendimento-manual.ts`), e o eco do nosso próprio envio nunca é gravado como `external_device` (`lib/waha/ingest.ts:67-88`).
- **`sent_at`, não `created_at`.** É a ordem em que as mensagens foram ditas. O inbound do WAHA carrega o timestamp do canal.
- **Encerrar, e não seguir a `handoff_policy`.** Hoje o "seguir" já termina cancelado nos dois caminhos do worker (`isLeadInHandoff` dá `skipped`, e o turno IA no-op também dá `skipped`). Só que termina com motivo errado, ou fica em recheck até morrer, no atalho. A política `pause` continua valendo onde ela de fato age: no evento `ai.handoff_triggered`, a reatividade pausa antes. Nesse caso o envio vê `inscricao_encerrada` e não mexe em nada.
- **Atribuída a pessoa.** O gate de elegibilidade já barra `assignee_kind='user'` no modo IA e no atalho (`lib/ai/elegibilidade/gate.ts:119`). A mudança alinha o worker, em texto e modelo, com esses dois. O comentário de `bloqueios-obrigatorios.ts:18-20` é reescrito.

### D5. Ordem: porte inteiro de `f90f236aa`, sem tocar em `pos-entrada.ts`

A troca de ordem mora em `lib/dev/kick-local-pipeline.ts`, e `lib/channels/pos-entrada.ts` **não muda**: outra branch pode encostar nele.

Portar só a troca reabriria o defeito que o original consertou junto: o acordar acordaria a espera nova que o próprio texto estacionou, e o fluxo dispararia inteiro de uma vez. Por isso o porte é do commit inteiro, com as guardas que vieram junto:

- `engine.ts`: ocupação de `wait_started` recém-gravado não conta como timeout (`matchReplyOcupado`);
- `node-handlers.ts`: um `inbound_woke` sem texto desta pergunta permanece na espera;
- `reactivity.ts`: uma mensagem anterior ao estacionamento (`updated_at`) não acorda a espera nova;
- os testes que vieram com o commit.

Conferido com `git apply --check`: o código entra com deslocamento de linha. Só o `select` de `reactivity.ts` muda à mão (`LIVE_STATUSES` aqui, `statuses` lá). Os dois arquivos de teste que não existem no fork (`engine-match-reply-inbound.test.ts` e `reactivity-dormente.test.ts`) viram arquivos novos, com os casos do commit.

### D6. Variáveis resolvidas na hora do envio, num helper só

- **O helper.** `lib/inbox/template-vars.ts` ganha:
  - `nomeDoContato({name, display_name})`: o `name` aparado ou, na falta, o `display_name`;
  - em `interpolateTemplate`, a opção `{ semValor: 'manter' | 'remover' }`. O padrão é `'manter'`, a caixa de entrada de hoje.
- **A regra de remover** age só em volta da variável, nunca no texto inteiro. Com `antes` = vírgula antes da variável e `depois` = vírgula depois:

  | Caso | O que acontece | Exemplo |
  |---|---|---|
  | `antes` e `depois` | Fica uma vírgula. | `"Ei, {{primeiro_nome}}, tá por aí?"` → `"Ei, tá por aí?"` |
  | Só `antes` | A vírgula some. | `"Olá, {{nome}}."` → `"Olá."` |
  | Só `depois`, no meio do texto | Fica a vírgula. | `"Oi {{nome}}, tudo bem?"` → `"Oi, tudo bem?"` |
  | Só `depois`, no começo do texto | Some, e a primeira letra vira maiúscula. | `"{{primeiro_nome}}, tudo certo?"` → `"Tudo certo?"` |
  | Nenhuma vírgula | Sai a variável e o espaço antes. | `"Oi {{nome}}! Tudo bem?"` → `"Oi! Tudo bem?"` |

- **Onde se aplica no follow-up:** no envio, e não no enfileiramento.
  - O worker, em `resolveFlowSendBody` (texto, modelo e modelo de reserva), lê `name` e `display_name` pelo `pool`.
  - O atalho lê o mesmo par pelo admin, filtrando `organization_id`.
  - O nome vale como está na hora em que a mensagem sai, e a regra é uma só.
- **Na caixa de entrada.** `InboxLayout.tsx:614` passa `nomeDoContato(selectedConversation.contacts)`; a consulta já traz `display_name` (`app/api/v1/conversations/_handler.ts:94`). O `Composer.tsx` não muda.
- **Na tela do passo.** A dica do `ActionForm` (texto) passa a citar `{{nome}}` e `{{primeiro_nome}}`, com a entrada em espanhol no dicionário.
- O renderizador de campanha (`lib/campanhas/renderizador.ts`) tem regra própria (pula o contato sem nome) e não muda.

### D7. Modelo de reserva: portar o encanamento de `b94446a5c`, adaptar a semântica

**Portado do original, igual:**

- `fallback_template_id` em `FollowupJobRequest.payload` e em `turnPayloadExtras` (`engine.ts`);
- `fallback_template_id` no `followupTurnPayloadSchema`, e `fallbackTemplateId` na entrada de `runFlowDrivenTurn`.

Mantive os nomes e a forma do original para os merges futuros.

**Adaptado.** No original o plano B é um modelo **aprovado da Meta**, que sai no lugar da IA quando a janela de 24h fechou. Isso depende de `meta_templates`/`definicaoNaConexao`, que o fork não tem completo. E a tela do fork promete outra coisa ("se a IA não conseguir escrever"), apontando para `message_templates`. Aqui, o modelo de reserva sai **depois** de a IA não enviar.

O fluxo em `runFlowDrivenTurn` (`ai_message`) fica assim:

1. **Antes de chamar a IA.** Se o ledger já tem a reserva aceita (`reconcileAcceptedSend`, seq `SEQ_DO_MODELO_DE_RESERVA = 1000`), fecha como `sent` via reserva. Isso é retry depois de queda, e não chama a IA de novo, para não duplicar.
2. **O turno da IA roda.**
   - Terminou: `resultadoDoEnvioDoFollowup`.
   - Lançou um erro que não é `JobSettledError`, e é a última tentativa (`job.attempts >= job.max_attempts`, porque o claim incrementa em `lib/agent-engine/queue/queue.ts:149`): conta como "a IA não enviou".
   - Lançou antes da última tentativa: relança, como hoje.
3. **Resultado `skipped` com modelo de reserva configurado:**
   1. As travas são conferidas de novo com `conferirAntesDoEnvio`. Um humano pode ter entrado durante o turno, e o opt-out vetado pelo handler aparece como `is_blocked`. Se bloqueia, aplica o bloqueio (mesma tradução de D2) e a reserva não sai.
   2. A elegibilidade do canal (`decidirElegibilidadeDaConversa`, a versão `pg` do mesmo gate) também é conferida. Não elegível: mantém o `skipped`.
   3. O corpo é resolvido por `resolveFlowSendBody({templateId: fallback})`, com volta e nome.
   4. O envio usa `sendFixedOutbound(..., seq)` com a seq da reserva. Ela ganha um parâmetro `seq` com padrão `1`, e o `runBeforeSend` vem inteiro: STOP, janela, ritmo, caps, LGPD, repetição.
4. **O desfecho da reserva:**
   - `sent`: `complete({kind:'sent', via:'modelo_de_reserva'})`. A ponte grava `action_sent` com `payload {via}`, e o dossiê mostra "pelo modelo de reserva: a IA não escreveu a mensagem".
   - `skipped`: `skipped`, com o motivo "A IA não enviou a mensagem e o modelo de reserva também foi recusado pelas regras do atendimento."
   - `deferred` (janela anti-ban): não fecha o passo, igual ao texto fixo hoje. O job reagendado carrega o payload `ai_message`, então na abertura a IA tenta de novo.
   - `pulado`: `pulado`.
   - Se a reserva também lançar na última tentativa, o erro original é relançado (`job_dead` e o aviso na Central, como hoje).

**Agente pausado ou em modo assistido** (`inbound-turn.ts:1911`). O turno da IA não envia e a reserva **sai**. É a mesma regra do texto fixo, que nunca consultou a pausa do agente: o texto é do operador, e pausar a IA não pausa o fluxo. Se o dono quiser parar o fluxo, pausa o fluxo.

---

## 4. O que fica de fora (e com quem)

- **O passo que espera a janela morre pelo dead-man (cerca de 11h).** É da outra sessão (commits `a1c6c4d1e` e `092081b61` do original). O adiamento do atalho (D2/D3) deixa o job pendente até a abertura: em janela fechada por mais de ~11h15, a inscrição ainda pode morrer antes. Não mexo.
- **Caps, warm-up, repetição, LGPD e promessas no atalho.** Continuam só no worker (D3). Mitigação existente: no self-host o worker pega a maioria dos jobs em 2 s. Fechar isso exige a cadeia `runBeforeSend` no app ou o worker no e2e.
- **A varredura de silêncio reinscreve quem foi encerrado por humano ativo ou anonimizado**, no tick seguinte. É do item silêncio (0324).
- **O lembrete da agenda não respeita humano ativo.** É do item lembrete (0323).
- **Bloqueio de elegibilidade não humano no atalho** (allowlist, pré-go-live). Continua `settle(done)` e recheck. Só os motivos humanos passam a encerrar, via `decidirEnvio`, antes do gate.
- **`schedule_followup` disponível no turno IA do fluxo.** Pode abrir um retorno paralelo.
- **O resto de `b94446a5c`**: envio de modelo aprovado da Meta no modo `template`, `held_by_return`, a rota de modelos aprovados.
- **Commits do original no mesmo arquivo, sem relação com o item.** `3bfa7b59c` (job vencido no mesmo milissegundo) e `401c018fc`/`099fac569` (org suspensa) são candidatos a porte pela sessão Graphify.
- **Pausar em vez de encerrar quando a `handoff_policy` é `pause` e o humano entrou sem evento** (celular, composer). A exigência é encerrar.

## 5. Riscos

- **Organização com distribuição para pessoas** (`assignee_kind='user'` por roteamento). O texto fixo e o modelo pelo worker deixam de sair em conversa atribuída. Já era assim no modo IA e no atalho. O motivo fica legível no dossiê.
- **O atalho passa a depender de `SUPABASE_DB_URL`** no processo do app. A variável é obrigatória no `env.ts`. Sem ela, falha fechada: o job volta para a fila e, esgotadas as tentativas, vira `job_dead` com aviso.
- **`espacarEnvio` dorme até cerca de 2 s por envio dentro do request.** O atalho envia no máximo 5 por chamada e, no webhook, só do contato que escreveu.
- **Eco classificado errado.** Se a checagem de eco do WAHA falhar e gravar o nosso envio como `external_device`, o follow-up é encerrado por "humano ativo". É o lado seguro, o mesmo que `ingest.ts:91-95` escolhe.
