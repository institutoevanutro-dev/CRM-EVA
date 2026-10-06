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
   - uma mensagem de saída **humana** depois do último marco: a última mensagem recebida do contato **nesta conversa**, a última retomada desta inscrição (`handoff_resumed`) e, exceto no gatilho de silêncio, o início da inscrição (D4);
   - a conversa está atribuída a uma pessoa (`assignee_kind='user'`);
   - o contato está com `force_human`;
   - o bot está silenciado, exceto o silêncio de roteamento.

   Mensagem humana é `direction='outbound'` com `sent_via in ('user','external_device')`: o composer grava `user` (`_handler.ts:553`) e o celular grava `external_device` (`lib/waha/ingest.ts:837`). IA, automação e o próprio follow-up gravam `ai`. O eco não removido do nosso próprio envio não conta (D4). Com `handoff_policy='allow'` ("Permitir durante handoff"), os dois sinais novos (atribuição e resposta humana) não encerram. A inscrição nunca fica rechecando até morrer.
4. **Variáveis no texto e no modelo do follow-up.**
   - `{{nome}}` vira `contacts.name` e, na falta dele, `contacts.display_name`. `{{primeiro_nome}}` vira a primeira palavra desse nome.
   - Sem nenhum dos dois, a variável sai do texto e a pontuação e o espaço em volta se ajustam: `"Ei, {{primeiro_nome}}, tá por aí?"` vira `"Ei, tá por aí?"`.
   - O nome é resolvido por `nomeDoContato` (`lib/contacts/rotulo-do-contato.ts`), que já existe e já é usado pela campanha: `name`, depois `display_name`, nunca um identificador técnico (telefone, `@lid`). A caixa de entrada passa a usá-lo. Lá, sem nome nenhum, a variável continua literal (comportamento de hoje), porque quem vai enviar vê e corrige.
5. **O modelo de reserva funciona.** Ele sai quando a IA **não conseguiu** enviar: todos os envios dela vetados pela cadeia, ou erro na última tentativa sem nada aceito, pendente ou na fila do canal. A IA que concluiu **sem** enviar (ledger vazio: decidiu não falar, agente pausado ou assistido) não dispara a reserva (D7). Nesse caso:
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

`FatosDoEnvio` ganha `handoff_policy` (lido do pointer, na consulta da inscrição, que já faz join nele) e `FatosDoEnvio.conversa` ganha dois campos: `atribuida_a_pessoa` e `humano_respondeu`. Ambos são lidos na mesma consulta da conversa (`bloqueios-obrigatorios.ts`, `lerFatosDoEnvio`):

```sql
(c.assignee_kind = 'user') as atribuida_a_pessoa,
exists (
  select 1 from messages h
   where h.organization_id = c.organization_id and h.conversation_id = c.id
     and h.direction = 'outbound' and h.sent_via in ('user','external_device')
     and h.sent_at > greatest(
           (select max(i.sent_at) from messages i            -- último inbound DESTA conversa
             where i.organization_id = c.organization_id and i.conversation_id = c.id
               and i.direction = 'inbound'),
           (select max(ev.created_at) from followup_enrollment_events ev   -- última retomada
             where ev.organization_id = c.organization_id and ev.enrollment_id = $4
               and ev.event_type = 'handoff_resumed'),
           (select case when fp.trigger_config->>'kind' = 'silence' then null else fe.started_at end
              from followup_enrollments fe                    -- início (exceto silêncio)
              join followup_flow_pointers fp on fp.id = fe.pointer_id and fp.organization_id = fe.organization_id
             where fe.organization_id = c.organization_id and fe.id = $4))
     and not (h.sent_via = 'external_device' and h.external_id is not null and exists (
           select 1 from messages eco                         -- eco não removido do nosso envio
            where eco.organization_id = c.organization_id and eco.conversation_id = c.id
              and eco.direction = 'outbound' and eco.sent_via in ('ai','user')
              and eco.id <> h.id and eco.external_id is not null
              and regexp_replace(eco.external_id, '^.*_', '') = regexp_replace(h.external_id, '^.*_', '')))
) as humano_respondeu
```

`greatest` ignora `null`. O índice `idx_messages_conversation_sent (conversation_id, sent_at desc)` cobre as subconsultas de mensagem.

Os quatro sinais (`force_human`, bot silenciado, atribuída a pessoa, humano respondeu) dão `atendimento_humano` com `invalida: true`. O texto passa a ser "Sequência encerrada: uma pessoa da equipe está atendendo esta conversa." e o outcome, `handoff`. Por quê:

- **`sent_via`, não `sent_by_user_id`.** O celular do dono não é necessariamente um usuário do CRM (`atendimento-manual.ts`).
- **O eco do nosso envio.** Ao contrário do que esta spec dizia, ele **é** gravado como `external_device` quando o webhook chega antes de o envio conhecer o próprio id: `removerEcoDoProprioEnvio` (`app/api/v1/messages/_handler.ts:95-130`) e `removeRedriveEcho` (`session-reconciler.ts:231-260`) apagam essa linha depois, e o próprio comentário diz que, se a remoção falhar, a duplicata fica. No ingest esse erro custa 5 min de silêncio; aqui encerraria a sequência inteira, sem volta. Por isso a consulta exclui a linha `external_device` cujo id "bare" (a cauda depois do último `_`, `bareWaMessageId`) coincide com uma saída nossa (`ai`/`user`) da mesma conversa. Comparar pelo bare cobre as duas formas que os engines gravam (NOWEB composto × id cru; WEBJS completo dos dois lados) e também o caso `@lid`/`@c.us` que `wahaEchoExternalIds` não cobre.
- **`sent_at`, não `created_at`.** É a ordem em que as mensagens foram ditas. O inbound do WAHA carrega o timestamp do canal.
- **Os três marcos.**
  - *Último inbound desta conversa*: a pessoa respondeu ao que o contato disse por último.
  - *Última retomada* (`handoff_resumed`): "devolver ao agente" (`lib/escalacao/retomada.ts:136-143`) limpa o silêncio e o `last_handoff_at`, e `reactToHandoffClose` (`reactivity.ts`) volta a inscrição pausada para `active`. Sem este marco, as mensagens que a pessoa mandou durante o handoff continuariam depois do último inbound, e a política `pause` viraria cancelamento logo no primeiro envio depois da retomada.
  - *Início da inscrição*: fluxos feitos para cobrar **depois** de uma mensagem humana (gatilho `stage_change` "Proposta enviada" depois de o vendedor mandar a proposta pelo composer; inscrição manual pela API ou pela ferramenta MCP de retenção; `webhook`, `case_opened`, `conversation_end`) não podem morrer no primeiro envio. **Exceção: gatilho de silêncio.** A inscrição de silêncio nasce *depois* do inbound a que reage (o limiar), e uma resposta humana nesse intervalo é exatamente o atendimento em curso — é o caso do Dr. André. Decisão registrada (opção 1 do revisor, com a exceção de silêncio para não depender do item 0324 para a regra de negócio).
- **Encerrar, e não seguir a `handoff_policy`.** Hoje o "seguir" já termina cancelado nos dois caminhos do worker (`isLeadInHandoff` dá `skipped`, e o turno IA no-op também dá `skipped`). Só que termina com motivo errado, ou fica em recheck até morrer, no atalho. A política `pause` continua valendo onde ela de fato age: no evento `ai.handoff_triggered`, a reatividade pausa antes. Nesse caso o envio vê `inscricao_encerrada` e não mexe em nada; na retomada, o marco `handoff_resumed` impede que a resposta dada durante o handoff encerre a sequência.
- **`handoff_policy='allow'`** ("Permitir durante handoff", `PublishBar.tsx:58-62`). Com ela, atribuição e resposta humana **não** encerram: a opção continua fazendo o que a tela promete. `force_human` e bot silenciado continuam encerrando mesmo com `allow`: hoje eles já cancelavam no worker por `isLeadInHandoff`, então a opção nunca valeu para eles no envio.
- **Atribuída a pessoa.** O gate de elegibilidade já barra `assignee_kind='user'` no modo IA e no atalho (`lib/ai/elegibilidade/gate.ts:119`). A mudança alinha o worker, em texto e modelo, com esses dois. O comentário de `bloqueios-obrigatorios.ts:18-20` foi reescrito.

### D5. Ordem: porte inteiro de `f90f236aa`, sem tocar em `pos-entrada.ts`

A troca de ordem mora em `lib/dev/kick-local-pipeline.ts`, e `lib/channels/pos-entrada.ts` **não muda**: outra branch pode encostar nele.

Portar só a troca reabriria o defeito que o original consertou junto: o acordar acordaria a espera nova que o próprio texto estacionou, e o fluxo dispararia inteiro de uma vez. Por isso o porte é do commit inteiro, com as guardas que vieram junto:

- `engine.ts`: ocupação de `wait_started` recém-gravado não conta como timeout (`matchReplyOcupado`);
- `node-handlers.ts`: um `inbound_woke` sem texto desta pergunta permanece na espera;
- `reactivity.ts`: uma mensagem anterior ao estacionamento (`updated_at`) não acorda a espera nova;
- os testes que vieram com o commit.

Conferido com `git apply --check`: o código entra com deslocamento de linha. Só o `select` de `reactivity.ts` muda à mão (`LIVE_STATUSES` aqui, `statuses` lá). Os dois arquivos de teste que não existem no fork viram arquivos novos **com o mesmo nome do original**, para facilitar merges futuros:

- `lib/followup/engine-match-reply-inbound.test.ts`: os dois casos de `f90f236aa`. O primeiro caso do arquivo original ("avança para o ramo do '1'…") depende de `36827ea36` (piso do inbound pelo `wait_started`), que não foi portado, e ficou de fora; o cabeçalho diz isso.
- `lib/followup/reactivity-dormente.test.ts`: o caso "não acorda espera estacionada depois da mensagem" e um controle. O fork não tem o status `dormente`, então os demais casos do original não se aplicam; o cabeçalho diz isso.

### D6. Variáveis resolvidas na hora do envio, num helper só

- **O nome.** `nomeDoContato` de `lib/contacts/rotulo-do-contato.ts`, que já existe com a ordem certa (`name`, depois `display_name`) e com `ehIdentificadorTecnico`: telefone e `@lid` contam como sem nome. A campanha já o usa (`lib/campanhas/acoes.ts`, `lib/inicio/meu-dia.ts`, `lib/leads/radar-de-risco.ts`). Nada de helper novo.
- **O helper de interpolação.** `lib/inbox/template-vars.ts`: `TemplateContact.name` passa a ser o nome **já resolvido** por quem chama, e `interpolateTemplate` ganha a opção `{ semValor: 'manter' | 'remover' }`. O padrão é `'manter'`, a caixa de entrada de hoje.
- **A regra de remover** age só em volta da variável, nunca no texto inteiro:

  | Caso | O que acontece | Exemplo |
  |---|---|---|
  | No começo do texto | Sai a variável, a pontuação seguinte (`,.!?;:`) e os espaços; a primeira letra vira maiúscula. | `"{{primeiro_nome}}, tudo certo?"` → `"Tudo certo?"`; `"{{primeiro_nome}}! Tudo bem?"` → `"Tudo bem?"`; `"{{nome}} tudo certo?"` → `"Tudo certo?"` |
  | Vírgula antes e depois | Fica uma vírgula. | `"Ei, {{primeiro_nome}}, tá por aí?"` → `"Ei, tá por aí?"` |
  | Só vírgula antes | A vírgula some. | `"Olá, {{nome}}."` → `"Olá."` |
  | Só vírgula depois, no meio do texto | Fica a vírgula. | `"Oi {{nome}}, tudo bem?"` → `"Oi, tudo bem?"` |
  | Nenhuma vírgula, no meio | Sai a variável e o espaço antes. | `"Oi {{nome}}! Tudo bem?"` → `"Oi! Tudo bem?"` |

- **Onde se aplica no follow-up:** no envio, e não no enfileiramento.
  - O worker, em `resolveFlowSendBody` (texto, modelo e modelo de reserva), lê `name` e `display_name` pelo `pool`, filtrando `organization_id`, só quando o texto tem a variável.
  - O atalho lê o mesmo par pelo admin, filtrando `organization_id`, e o texto interpolado é o que vai ao ledger.
  - O nome vale como está na hora em que a mensagem sai, e a regra é uma só.
- **Na caixa de entrada.** `InboxLayout.tsx` passa `nomeDoContato(selectedConversation.contacts)`; a consulta já traz `display_name` (`app/api/v1/conversations/_handler.ts:94`). O `Composer.tsx` não muda.
- **Na tela do passo.** A dica do `ActionForm` (texto) cita `{{nome}}` e `{{primeiro_nome}}`, com a entrada em espanhol no dicionário.
- O renderizador de campanha (`lib/campanhas/renderizador.ts`) tem regra própria (pula o contato sem nome) e não muda.

### D7. Modelo de reserva: portar o encanamento de `b94446a5c`, adaptar a semântica

**Portado do original, igual:**

- `fallback_template_id` em `FollowupJobRequest.payload` e em `turnPayloadExtras` (`engine.ts`);
- `fallback_template_id` no `followupTurnPayloadSchema`, e `fallbackTemplateId` na entrada de `runFlowDrivenTurn`.

Mantive os nomes e a forma do original para os merges futuros.

**Adaptado.** No original o plano B é um modelo **aprovado da Meta**, que sai no lugar da IA quando a janela de 24h fechou. Isso depende de `meta_templates`/`definicaoNaConexao`, que o fork não tem completo. E a tela do fork promete outra coisa ("se a IA não conseguir escrever"), apontando para `message_templates`. Aqui, o modelo de reserva sai **depois** de a IA não enviar.

O fluxo em `runFlowDrivenTurn` (`ai_message`) fica assim:

1. **Antes de chamar a IA.** Se o ledger já tem a reserva aceita (`reconcileAcceptedSend`, seq `SEQ_DO_MODELO_DE_RESERVA = 1000`), fecha como `sent` via reserva. Isso é retry depois de queda, e não chama a IA de novo, para não duplicar.
2. **O turno da IA roda.** A reserva é tentada em dois casos, e só neles:
   - **Veto da cadeia:** o turno terminou e `resultadoDoEnvioDoFollowup` diz que **todos** os envios da IA foram vetados (`MOTIVO_ENVIO_VETADO`, exportado de `send-ledger.ts`).
   - **Erro na última tentativa** (`job.attempts >= job.max_attempts`, porque o claim incrementa em `lib/agent-engine/queue/queue.ts:149`), desde que:
     - o erro não seja das classes que a fila trata como terminais ou adiadas: `JobSettledError`, `AgendaDeferredError`, `StaleServiceBoundaryError` e o veto permanente de negócio (`terminal === true`), as mesmas de `workers/agent-worker/main.ts:453-467`;
     - **nenhuma** linha do `send_ledger` do job esteja `accepted`, `requested` ou `queued`. `resultadoDoEnvioDoFollowup` lança `followup_message_not_sent` quando a mensagem da IA está `queued` (esperando o canal), e essa mensagem ainda sai depois: o reconciliador reenvia `sent_via='ai' and status='queued'` (`session-reconciler.ts:313,342`). Mandar a reserva ali duplicaria a mensagem.
   - Antes da última tentativa: relança, como hoje.
   - **Ledger vazio não dispara.** A IA que concluiu sem enviar decidiu não falar: instruções condicionais do próprio negócio ("só sai se a última mensagem foi uma pergunta nossa") e o agente pausado ou em modo assistido (`inbound-turn.ts:1911`) terminam assim. A tela promete "se a IA não **conseguir** escrever", e isso é falha, não decisão. Mantém o `skipped` de hoje.
3. **Antes de a reserva sair:**
   1. As travas são conferidas de novo com `conferirAntesDoEnvio`. Um humano pode ter entrado durante o turno, e o opt-out vetado pelo handler aparece como `is_blocked`. Se bloqueia, aplica o bloqueio (mesma tradução de D2) e a reserva não sai.
   2. A elegibilidade do canal (`decidirElegibilidadeDaConversa`, a versão `pg` do mesmo gate) também é conferida, **com `followup: true`** (como `inbound-turn.ts:1771-1785`): sem isso o silêncio de roteamento do Instagram barraria a reserva. Não elegível (ou leitura que falha): mantém o resultado da IA.
   3. O corpo é resolvido por `resolveFlowSendBody({templateId: fallback})`, com volta e nome.
   4. O envio usa `sendFixedOutbound(..., seq)` com a seq da reserva. Ela ganha um parâmetro `seq` com padrão `1`, e o `runBeforeSend` vem inteiro: STOP, janela, ritmo, caps, LGPD, repetição.
4. **O desfecho da reserva:**
   - `sent`: `complete({kind:'sent', via:'modelo_de_reserva'})`. A ponte grava `action_sent` com `payload {via}`, e o dossiê mostra "pelo modelo de reserva: a IA não escreveu a mensagem".
   - `skipped`: `skipped`, com o motivo "A IA não enviou a mensagem e o modelo de reserva também foi recusado pelas regras do atendimento." (com a versão em espanhol no dicionário, porque o dossiê passa o detalhe por `t()`).
   - `deferred` (janela anti-ban): não fecha o passo, igual ao texto fixo hoje. O job reagendado carrega o payload `ai_message`, então na abertura a IA tenta de novo.
   - `pulado`: `pulado`.
   - Se a reserva também lançar na última tentativa, o erro original é relançado (`job_dead` e o aviso na Central, como hoje).

**Agente pausado ou em modo assistido** (`inbound-turn.ts:1911`). O turno da IA não envia, o ledger fica vazio e a reserva **não** sai: o passo termina como hoje (`skipped` "O assistente concluiu…"). Isso também preserva o comportamento dos fluxos já publicados, em que a publicação exige reserva em caminhos de 24h ou mais (`validate-publish.ts:212-221,327-333`).

**Textos do dossiê em espanhol.** `DossieDoFollowup.tsx:143` passa o `detalhe` por `t()`, e `turn_skipped` usa o `reason` como detalhe. Por isso os três textos novos ("pelo modelo de reserva: a IA não escreveu a mensagem", o novo `TEXTO_DO_BLOQUEIO.atendimento_humano` e o motivo da reserva recusada) têm entrada `es` em `lib/i18n/dicionario.ts`, conferida pelos guardas de i18n.

### D8. O e2e não pode depender da hora do CI

O atalho passa a respeitar a janela anti-ban do número, que por padrão é 7h–22h America/Sao_Paulo (`lib/agent-engine/pacing/defaults.ts:69-71`). Entre 22h e 7h BRT, o texto fixo seria adiado e as specs de follow-up ficariam vermelhas pela hora em que o CI roda. As seis specs que dependem do atalho (`followup-journey`, `followup-dossie`, `followup-ramos`, `followup-tempo-adaptativo`, `j20-elegibilidade-followup`, `agenda-presenca-recuperacao`) abrem a janela (0h–24h, domingo liberado) no setup: as cinco primeiras por `tests/e2e/utils/janela-de-envio.ts` (subcomando `abrir-janela-de-envio` de `scripts/e2e-followup-journey-helpers.ts`), a última pelo seu próprio cliente admin, na fixture que cria o número. É a mesma razão de `garantirJanelaSempreAberta` (`scripts/seed-e2e-numero-conectado.ts:120-170`), que não dá para importar (o script roda `main()` ao ser carregado). O adiamento fica coberto só com relógio injetado (unit e invariante).

### Portado × adaptado (resumo para a sessão de portes)

| Do original | Aqui |
|---|---|
| `f90f236aa` (ordem do kick + guardas em `engine.ts`, `node-handlers.ts`, `reactivity.ts` + fragmento) | **Portado** inteiro; `reactivity.ts` à mão (`LIVE_STATUSES`). Testes com o nome do original, parciais (ver D5). |
| `b94446a5c` — `fallback_template_id` em `FollowupJobRequest.payload`, `turnPayloadExtras`, `followupTurnPayloadSchema`, `fallbackTemplateId` na entrada de `runFlowDrivenTurn` | **Portado** com os mesmos nomes. |
| `b94446a5c` — semântica (modelo aprovado da Meta no lugar da IA com a janela de 24h fechada) | **Adaptado**: `message_templates`, depois de a IA não conseguir enviar (D7). O resto do commit (modo `template` com modelo aprovado, `held_by_return`, rota de modelos aprovados) não veio. |
| `a1c6c4d1e`, `092081b61` (dead-man de ~11h) | **Não tocado**: é da outra sessão. |

## 4. O que fica de fora (e com quem)

- **O passo que espera a janela morre pelo dead-man (cerca de 11h).** É da outra sessão (commits `a1c6c4d1e` e `092081b61` do original). O adiamento do atalho (D2/D3) deixa o job pendente até a abertura: em janela fechada por mais de ~11h15, a inscrição ainda pode morrer antes. Não mexo.
- **Caps, warm-up, repetição, LGPD e promessas no atalho.** Continuam só no worker (D3). Mitigação existente: no self-host o worker pega a maioria dos jobs em 2 s. Fechar isso exige a cadeia `runBeforeSend` no app ou o worker no e2e.
- **A varredura de silêncio reinscreve quem foi encerrado por humano ativo ou anonimizado**, no tick seguinte (`silence-sweep.ts:28-30`, sem cooldown). Hoje o laço só acontece com `force_human`; com os sinais novos ele se torna comum para todo contato em que uma pessoa respondeu: a cada volta a inscrição nasce, roda o planejamento (`plan_timing`, um turno de LLM quando há espera inteligente), grava eventos e é encerrada de novo no primeiro envio. **Este PR não pode ir para a `main` antes da deduplicação por episódio do item silêncio (0324)**, que não inscreve quem já teve inscrição deste pointer depois do último inbound nem quem teve resposta humana depois dele. A guarda mínima em `runSilenceSweep` não veio aqui de propósito: é o arquivo que o item 0324 reescreve, e duas versões da mesma regra em branches paralelas divergem no merge.
- **O lembrete da agenda não respeita humano ativo.** É do item lembrete (0323).
- **Bloqueio de elegibilidade não humano no atalho** (allowlist, pré-go-live). Continua `settle(done)` e recheck. Só os motivos humanos passam a encerrar, via `decidirEnvio`, antes do gate.
- **`schedule_followup` disponível no turno IA do fluxo.** Pode abrir um retorno paralelo.
- **O resto de `b94446a5c`**: envio de modelo aprovado da Meta no modo `template`, `held_by_return`, a rota de modelos aprovados.
- **Commits do original no mesmo arquivo, sem relação com o item.** `3bfa7b59c` (job vencido no mesmo milissegundo) e `401c018fc`/`099fac569` (org suspensa) são candidatos a porte pela sessão Graphify.
- **Pausar em vez de encerrar quando a `handoff_policy` é `pause` e o humano entrou sem evento** (celular, composer). A exigência é encerrar.
- **Textos antigos de `TEXTO_DO_BLOQUEIO` sem versão em espanhol** ("Sequência encerrada: o contato respondeu." e os demais). Já era assim; só os três textos novos ganharam a entrada `es`.

## 5. Riscos

- **Organização com distribuição para pessoas** (`assignee_kind='user'` por roteamento). O texto fixo e o modelo pelo worker deixam de sair em conversa atribuída. Já era assim no modo IA e no atalho. O motivo fica legível no dossiê.
- **O atalho passa a depender de `SUPABASE_DB_URL`** no processo do app. A variável é obrigatória no `env.ts`. Sem ela, falha fechada: o job volta para a fila e, esgotadas as tentativas, vira `job_dead` com aviso.
- **`espacarEnvio` dorme até cerca de 2 s por envio dentro do request.** O atalho envia no máximo 5 por chamada e, no webhook, só do contato que escreveu.
- **Eco classificado errado.** O eco que sobra como `external_device` é excluído pela comparação do id bare (D4). Sobra o caso em que o eco chega sem `external_id` ou com um id cuja cauda não coincide com a nossa saída: aí o follow-up é encerrado por "humano ativo".
- **Fluxos já publicados com `handoff_policy='pause'` ou `'cancel'`.** Passam a encerrar quando uma pessoa responde pelo celular ou pela caixa de entrada sem "Assumir". É a exigência do item; o fragmento de release diz isso ao operador.
- **Dependência de merge.** Ver §4: o item silêncio (0324) entra antes.
