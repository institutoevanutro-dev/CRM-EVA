# Spec 20 — Supervisão de agente e bloqueios obrigatórios de follow-up

> Estado: **implementado em código, não validado em execução real.** Os testes unitários
> cobrem as decisões e os efeitos pedidos ao banco com um banco em memória; o SQL do
> adaptador (`lib/supervisao/db-pg.ts`) ainda precisa de invariante contra Postgres real
> (`pnpm test:db`). Migration `0263`.

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

## Fora do escopo (declarado)

- Tela para configurar vínculos e bloqueios (hoje por SQL).
- Revisão de ações humanas feitas fora da rota de envio e do movimento de card (ex.:
  mover em lote, editar campos).
- Invariantes `tests/invariants/**` do SQL novo e prova e2e pela tela.
