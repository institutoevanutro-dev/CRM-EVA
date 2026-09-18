# Spec 20 — Supervisão de agente e bloqueios obrigatórios de follow-up

> Estado: **implementado em código, não validado em execução real.** Os testes unitários
> cobrem as decisões e os efeitos pedidos ao banco com um banco em memória; o SQL do
> adaptador (`lib/supervisao/db-pg.ts`) ainda precisa de invariante contra Postgres real
> (`pnpm test:db`). Migration `0265`.

## Por que

Criar um segundo agente e ligar capacidades nele não faz ninguém revisar o trabalho do
primeiro. O papel "Organiza o sistema" (`operator_turn`, spec 16) roda depois das
conversas do **próprio** agente; roteadores distribuem atendimento por intenção. Nenhum
dos dois é auditoria posterior de **outro** agente ou de uma ação humana.

## Peças

| Peça | Arquivo |
|---|---|
| Contrato do evento, chave de idempotência, códigos | `lib/supervisao/contrato.ts` |
| Decisões puras (filtro, ciclo, avaliação da proposta, código) | `lib/supervisao/politica.ts` |
| O que o modelo pode devolver (JSON estrito, sem ferramentas) | `lib/supervisao/proposta.ts` |
| Executor contra banco estreito | `lib/supervisao/executor.ts` |
| Adaptador pg (único com SQL) | `lib/supervisao/db-pg.ts` |
| Acionamento (revisão durável + job no mesmo commit) | `lib/supervisao/acionamento.ts` |
| Porta humana (event_log) | `lib/supervisao/acionamento-humano.handler.ts` |
| Handler do job `supervisor_review` | `lib/agent-engine/agent/supervisor-review.ts` |
| Bloqueios obrigatórios antes do envio | `lib/followup/bloqueios-obrigatorios.ts` |

## Acionamento

1. **Execução da IA concluída** — `inbound-turn.ts`, depois do checkpoint (registros do
   turno persistidos), pelo runtime. `event_id` = job do turno.
2. **Ação humana concluída** — `supervision.review_requested` (rota de envio, autor
   pessoa) e `lead.stage_changed` com `metadata.actor_user_id`. `event_id` = linha do
   `event_log`.

Revisão e job nascem no mesmo commit. `job_queue.source_event_id` é um UUID
determinístico da chave `organization_id:conversation_id:event_id:supervisor_agent_id`.

## Garantias

- **Filtro** por organização, funil (id, nunca nome), agente supervisionado; pessoa com
  vínculo ativo, senão revisão `bloqueada`. Refeito na execução.
- **Ciclo**: execução de qualquer supervisor da organização e movimento marcado
  `actor_kind='supervisor'` nunca acionam revisão.
- **Idempotência**: revisão terminal devolve o resultado gravado; proposta gravada na
  primeira leitura válida e reaproveitada em retentativa; ação com chave única; a
  movimentação é idempotente pela chave da ação (reconhece commit anterior à queda).
- **Estado atual**: tudo é decidido sobre leitura feita no instante da execução.
- **Concorrência**: escrita condicional (etapa + `stage_changed_at` + `service_revision`,
  `for update` na conversa); recusada, relê e recalcula uma vez sobre a mesma proposta;
  recusada de novo, `BLOQ conflito_de_estado`. Serialização por contato pela lane da fila.
- **Autorização**: etapa ganho/perda nunca por inferência; evidência obrigatória (ids de
  mensagem da conversa lida); tema sensível ou humano em atendimento → `RECOM`; modo
  `recomendar` → `RECOM`; só `allowed_stage_moves` executa.
- **EXE com prova**: CHECK recusa `EXE` sem `status='executada'` e `tool_result_ref`.
- **Sem canal**: o handler não recebe `ChannelAdapter`, não monta MCP, `tools` ausente.

## Registro

`ai_supervision_reviews` (ids, data, `policy_version`, `prompt_version`, `state_read` só
com ids e flags, etapa anterior e recomendada, `human_validator_user_id`, `exit_reason`),
`ai_supervision_actions` (código, status, evidências por id, motivo, próximo responsável,
retorno da ferramenta), `crm_lead_activities` (`stage_changed` e `supervision_review`),
`agent_inbox_items` kind `supervision_review` e `event_log` `agent.supervisor_review` (done).

## Bloqueios obrigatórios do executor de follow-up

Conferidos em `followup-turn.ts` antes dos dois caminhos de envio de fluxo, relendo o
banco. Sempre: inscrição viva, anonimizado, opt-out, atendimento humano (mesma definição de
`isLeadInHandoff`), etapa `blocks_followups`, resposta depois do último envio quando o
fluxo cancela na resposta. Por organização (`organizations.settings.followups.bloqueios`):
`janela` (dias + intervalos + fuso; fora dela, adia), `exigir_etapa_do_gatilho`,
`bloquear_com_consulta_confirmada`, `uma_sequencia_por_contato`. Não verificável → não
envia e o job falha para a fila (vira `job_dead` na Central).

A reatividade (`reactivity.ts`) cancela sequências vivas quando o negócio **entra** numa
etapa `blocks_followups`. Não existe reação de "saiu da etapa": mudança de etapa não
reativa sequência nem remove opt-out.

## Bloqueio do sinal por prazo (migration 0266)

`followup_enrollments.appointment_id` (nullable) amarra uma inscrição a uma reserva
específica (`calendar_appointments`). A coluna já existia na migration 0224 para
recuperação de faltas (`appointment_no_show`, com `appointment_revision`), que continua
fora das regras de sinal. Inscrições sem reserva seguem `null`. A chamada de
`enrollFollowupFlow` aceita a reserva, mas os callers atuais de inscrição manual e
automação ainda não passam esse parâmetro; ativar T40 exige essa integração. Índice único parcial
`idx_followup_enrollments_one_per_appointment` em `(pointer_id, appointment_id)` para
`status in ('active','waiting_reply','paused_handoff')`: **uma tentativa por reserva**, e
uma segunda chamada de `enrollFollowupFlow` para a mesma reserva/fluxo recebe `409
conflict` em vez de duplicar. `calendar_event_types.requires_signal` distingue tipo de
compromisso que exige sinal.

`lib/followup/bloqueios-obrigatorios.ts` ganhou, quando `fatos.reserva` está presente:

- **Elegibilidade**: `reserva.sujeita_a_sinal === false` → `BLOQ
  consulta_nao_sujeita_a_sinal` (invalida a etapa, nunca envia lembrete de sinal fora do
  tipo certo).
- **Prazo**: `PRAZO_DO_SINAL_MINUTOS = 60`, contado da **criação real da reserva**
  (`reserva.criada_em`), **capado no início da consulta** (`min(criada_em + 60min,
  consulta_em)`) — uma consulta marcada para menos de 60 minutos à frente encurta o
  prazo, nunca o estende. Vencido → `BLOQ prazo_do_sinal_vencido`, e nenhum lembrete de
  sinal sai depois disso nem depois do início da consulta.
- **Janela comercial**: fora da janela, o comportamento padrão é *adiar* para a próxima
  abertura — mas se essa próxima abertura já está **depois** do prazo do sinal, adiar
  enviaria o lembrete vencido. Nesse caso o envio é **suprimido** (`BLOQ
  fora_da_janela_sem_encaixe`), nunca adiado para depois do vencimento.

## Revisão humana em T+60 (`lib/followup/revisao-do-sinal.ts`, cron `sinal-revisao-humana`)

Canal lateral, independente do envio de lembrete: a RPC `sinal_listar_revisoes`
filtra prazo, tipos sujeitos a sinal, status `pending`/`confirmed`, contato não anonimizado,
etapa que ainda não bloqueia follow-up e ausência de qualquer aviso anterior **antes**
do limite de 500. `confirmed` não comprova pagamento.

A RPC `sinal_abrir_revisao` revalida esses fatos sob locks, serializa crons concorrentes
e retorna se criou aviso. Qualquer aviso anterior, inclusive resolvido, impede reabrir a
mesma reserva. A referência canônica é `ref_kind='appointment'` + `ref_id`; o filtro
reconhece também o valor legado `calendar_appointment`. O cron conta/audita apenas
inserções reais. Nenhum histórico é apagado.

Reserva de sinal cancelada, concluída, marcada como falta ou inválida impede cobrança.
A migration 0267 também encerra inscrições vivas de sinal quando sua FK é apagada;
a recuperação de faltas preserva a proteção já existente na migration 0224.

**Garantia central, testada e não-negociável**: este caminho **nunca** muda etapa, nunca
libera horário, nunca marca falta e nunca cancela a consulta — só abre o item de Central
para uma pessoa decidir. O cron (`app/api/v1/cron/sinal-revisao-humana`, a cada 15 min,
`docker/scheduler/entrypoint.sh` e `vercel.ts`) audita só quando abriu algum item
(`cron-audita-so-quando-ha-efeito`).

**Folga inerente ao agendador (documentada, não é bug):** `decidirRevisaoHumana` decide
por comparação pura de instantes — ela não sabe quando o cron rodou. O `*/15 * * * *`
introduz até **~15 minutos** de atraso entre o prazo vencer (T+60) e o item realmente
aparecer na Central: o pior caso é a reserva vencer o prazo logo depois de uma rodada do
cron. O item não deixa de nascer — nasce até 15 min depois do instante exato. Testado em
`lib/followup/revisao-do-sinal.test.ts` ("cron de 15 em 15 min: abre corretamente mesmo até
~15min depois do vencimento"). Se essa folga for grande demais para um nicho, a cadência do
cron é o knob a apertar (`*/5` custaria mais consultas vazias por hora), não a função pura.

**Comprovante bloqueia o PRÓXIMO lembrete antes de qualquer pessoa mover o card.** O
bloqueio por resposta (`cancelaNaResposta`/`resposta_do_contato` em
`bloqueios-obrigatorios.ts`) olha só se houve mensagem do contato depois do último envio
(ou da entrada no fluxo) — nunca a etapa nem quem moveu o quê. Isso exige que o nó de
gatilho do fluxo do sinal tenha `cancel_on_reply: true` (ver seção de configuração no
runbook de deploy). Com isso ligado, o comprovante em texto ou mídia já impede o próximo
lembrete no mesmo instante em que a mensagem chega — a equipe pode levar horas para mover o
card, e isso não teria acontecido ainda. Testado em `bloqueios-obrigatorios.test.ts`
("comprovante enviado bloqueia o lembrete ANTES de qualquer pessoa mover o card").

**Sinal × D1/D3/D7 nunca mandam mensagem concorrente para o mesmo contato — mas só com
`uma_sequencia_por_contato` ligado na organização.** `outras_inscricoes_vivas` (a leitura
que alimenta essa regra) vem de `select ... from followup_enrollments where
organization_id=$1 and contact_id=$2 and id<>$3` — **sem filtro de `pointer_id`** — então
uma inscrição do fluxo de sinal e uma do D1 já se enxergam como "outra inscrição viva" uma
da outra, exatamente como duas inscrições do mesmo fluxo. Com a opção ligada, só a mais
antiga das duas segue e a outra pausa com `sequencia_concorrente`. Testado em
`bloqueios-obrigatorios.test.ts` ("sequência concorrente vale ENTRE FLUXOS DIFERENTES").
**Sem essa opção ligada, os dois fluxos podem mandar mensagem no mesmo dia** — é uma escolha
de configuração da organização, não uma garantia incondicional do código.

## Fora do escopo (declarado)

- Tela para configurar vínculos e bloqueios (hoje por SQL).
- Revisão de ações humanas feitas fora da rota de envio e do movimento de card (ex.:
  mover em lote, editar campos).
- Invariantes `tests/invariants/**` do SQL novo e prova e2e pela tela.
- Sabotagem deliberada dedicada ao bloqueio do sinal (a suíte cobre os casos de decisão,
  mas não repete o exercício adversarial de "quebrar de propósito" feito para a
  supervisão original).


### Revalidação durante a escrita

O adaptador da supervisão preserva `stage_changed_at` como texto com microssegundos.
Na transação de movimentação, trava e revalida vínculo (ativo, modo executar, transição),
contato, conversa, negócio e etapas. Handoff, anonimização, exigência humana ou revogação
da configuração encerram a ação como BLOQ. A recuperação após queda apenas reencontra
uma atividade já commitada; sem recibo não executa um movimento novo.
