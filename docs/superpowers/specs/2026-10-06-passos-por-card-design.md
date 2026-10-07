# Fase 2, item 2 — Passos da Cintia por card, campos do funil e "Interagiu" automático

**Data:** 2026-10-06 · **Estado:** proposta para aprovação do André (nada codado)
**Base medida:** `origin/main` @ `5b2e640f3`. As linhas citadas valem para esse commit e mudam quando os pacotes 4 e 6 entrarem.

---

## Resumo para o André (5 linhas)

1. Hoje a Cintia guarda o passo da venda **por pessoa**, e esse passo nunca volta. Por isso, paciente que retorna ou lead que já foi perdido ganha card novo, e esse card **não anda sozinho**.
2. Proposta: o passo passa a valer **para o card da vez**. Card novo começa do zero, e o passo nunca fica atrás de onde o card está.
3. A Cintia passa a **ver e preencher** os campos do card (Objetivo, Acompanhamento, Modalidade, Forma de reserva), só escolhendo entre as opções da lista. A recepção não precisa mais copiar da Memória.
4. O card vai para **Interagiu sozinho** quando o lead responde pela primeira vez depois da nossa primeira mensagem. Isso é regra fixa do sistema, sem depender da IA. Nenhum card volta para trás.
5. São 3 entregas pequenas, de 1 a 2 sessões cada. Você só precisa decidir as 3 perguntas da seção 4.

---

## 1. Problema medido no código

### 1.1 O passo é do contato, só anda para frente e nunca zera
- `lead_state` tem uma linha por **contato**: `unique (organization_id, contact_id)` (`supabase/baseline.sql:6672-6684`). A leitura é por `contact_id` (`lib/agent-engine/agent/lead-state.ts:151-161`) e a gravação faz upsert na mesma chave (`lead-state.ts:215-224`).
- O grafo é fixo e só avança: `new → contacted → qualifying → qualified → negotiating → won | lost` (`lead-state.ts:35-43`). `won` e `lost` são terminais. Uma transição inválida vira erro para o modelo (`lead-state.ts:192-195`).
- Nada zera a linha quando um card novo nasce. Consequência: paciente que volta (passo `won`), lead perdido (`lost`) e contato que já passou de `contacted` **nunca** movem o card novo. É o "Limite importante" do design da Fase 1 (`docs/superpowers/specs/2026-10-05-funil-comercial-dr-andre-design.md:124`).

### 1.2 O card só anda quando o passo muda, e pode andar para trás
- O espelho só roda quando `update.transition !== null` (`lib/agent-engine/agent/inbound-turn.ts:3079-3093`). Repetir o mesmo passo não move nada.
- `resolveDestinoDoAgente` acha a etapa pelo `agent_stage_hint` **sem comparar posição** (`lib/leads/agent-stage-sync.ts:97-105`). Se alguém levou o card à mão para Negociação enquanto o passo ainda era `new`, o próximo `contacted` puxa o card **de volta** para Interagiu.
- O espelho não passa `escopoDeFunis` (`lib/agent-engine/edge/crm/move-lead-stage.ts:219-223`). Esse buraco já existe e fica fora deste item.

### 1.3 A Cintia não vê o card
- O contexto injetado a cada turno tem só o contato. O campo `lead_id` traz o **id do contato** (`lib/agent-engine/edge/crm/get-lead-context.ts:269-286`), com os marcadores do contato. Ficam de fora a etapa real, o funil e os `custom_fields`.
- O bloco "## Estado do funil" mostra só o passo interno (`inbound-turn.ts:1305-1314`, `1335-1336`).

### 1.4 A Cintia não tem como gravar os campos do funil
- O único caminho é `crm_update_lead` do catálogo. Ele exige o **id do negócio** (`lib/mcp/tools/leads.ts:215-216`), que ela não tem.
- `crm_update_lead` também altera título, valor, dono e marcadores, e com `tags` **substitui** a lista inteira.
- Ele não confere a chave nem a opção contra `pipeline.settings.fields`. O merge em si é atômico, via `fn_lead_anotar_campos` (`app/api/v1/leads/_handler.ts:530-542`).
- O pacote 4 (`fix/pacote-4-ia-escopo-do-paciente`, ainda fora da main) traduz o id do contato para o negócio aberto, quando há exatamente um. Isso resolve o id, mas não a largura da ferramenta, a validação nem a visibilidade.

### 1.5 "Interagiu" depende do juízo do modelo
- `contacted` é marcado quando o modelo quer. Na prática, isso acontece na primeira resposta da Cintia ao texto do anúncio, e não na resposta real do lead. Também pode acontecer num turno de follow-up, sem nenhuma resposta do lead.
- A regra de automação `message.received → create_or_move_lead` não serve. Ela não filtra por etapa, puxa o card para trás a cada mensagem e cria um card duplicado em outro funil.

---

## 2. Comportamento proposto

### 2.1 Passo efetivo por card (entrega A)
- `lead_state` e `lead_state_transitions` ganham `crm_lead_id uuid null references crm_leads(id) on delete set null`. A linha continua **única por contato**, então os leitores que cruzam por contato não mudam: board, próxima ação, propostas, `score-writer`, exportação LGPD, fusão de contatos e anonimização. Eles leem `next_action` e `qualification`, nunca `stage`.
- `getLeadState` passa a devolver o **passo efetivo**. Ele usa o mesmo `resolveActiveLeadForContact` do espelho, para não criar um segundo resolvedor. A regra:
  - **Sem card aberto, ou com ambiguidade:** fica como hoje (`row.stage ?? 'new'`).
  - **Com card aberto L:**
    - **Piso pelo card:** o passo do `agent_stage_hint` mais avançado entre as etapas não arquivadas do funil de L com `position` ≤ a posição da etapa atual de L. Se não houver nenhum, o piso é `'new'`.
    - **Passo próprio:** `row.stage` se `row.crm_lead_id = L`. Caso contrário, nada, e isso vale também para linhas antigas com `null`.
    - **Passo efetivo:** o maior dos dois na ordem de `LEAD_STAGES`.
- `applyLeadStateUpdate` valida a transição a partir do passo efetivo e grava `crm_lead_id = L`, também na linha de transição.
- **Efeito:**
  - Card novo de paciente que volta começa do piso do card, em geral `new`.
  - Se a equipe adianta o card à mão, o passo acompanha.
  - O passo de outro card não trava o card atual.
- **Guarda para não voltar:** em `sincronizaEstagioDoAgente`, se a etapa de destino tem `position` menor que a da etapa atual, o card não se move. A resposta é o motivo novo `ja_passou`, que o espelho trata como `ja_esta_la` (ok, sem aviso). Destino `is_won` ou `is_lost` fica isento, porque perder ou ganhar nunca é "voltar". `EstagioCandidato` ganha `position`.

### 2.2 A Cintia vê o card e preenche os campos (entrega B)
- **Contexto:** `getLeadContext` ganha o bloco `negocio`: nome do funil, nome da etapa atual e a lista dos campos que ela pode preencher (`chave`, `rotulo`, `opcoes`, `valor` atual).
  - Só entram campos `select`, `multiselect` e `boolean` (ver D2).
  - O bloco não leva id: a projeção (`lib/agent-engine/agent/projecao.ts`) não precisa esconder nada novo.
  - O bloco chega também aos turnos de follow-up e de resposta a caso, porque eles usam o mesmo contexto.
- **Ferramenta nativa `update_deal_fields`**, em arquivo próprio `lib/agent-engine/agent/campos-do-negocio.ts`.
  - **Entrada:** `{ campos: { [chave]: valor | valor[] | boolean } }` com `.strict()`.
  - **Negócio:** vem do closure do turno, resolvido pelo mesmo `resolveActiveLeadForContact`. Nunca vem do payload.
  - **Validação:** usa `camposDoFunil` (`lib/leads/campos-do-funil.ts:6-16`). Chave inexistente, tipo fora de D2 ou opção fora da lista vira **erro de ensino** que lista as opções válidas.
  - **Gravação:** chama `updateLeadHandler(..., { custom_fields })`, que já faz o merge atômico, a auditoria e a atividade na linha do tempo. Ator: o mesmo do catálogo no turno.
  - **Escopo de funil:** respeita `pipeline_ids` do agente, como o catálogo. Escopo vazio é recusa com ensino.
  - **Prévia (botão Testar):** vira só proposta. Entra na lista de `lib/agent-engine/agent/preview.ts:205-213`.
  - **Mapa de capacidade:** `update_deal_fields → ['crm_update_lead']` em `lib/agent-engine/agent/entrega-de-capacidade.ts`, igual ao `update_lead_state` (`:51`).

### 2.3 "Interagiu" automático na primeira resposta real (entrega C)
- **Novo arquivo:** `lib/leads/primeira-resposta.ts`, chamado em `aplicarEfeitosPosEntrada` logo depois de `abrirDemanda` (`lib/channels/pos-entrada.ts:120-121`). Com isso, o card já existe quando a regra roda. **Não toca `inbound-turn.ts`.**
- **Quando move:** todas as condições abaixo precisam valer.
  - O funil tem a opção ligada: `crm_pipelines.settings.primeira_resposta = true`. Ela vem desligada por padrão, ver D1.
  - O contato tem exatamente um card aberto, L, nesse funil.
  - L ainda está na **etapa de entrada**, pela mesma regra de nascimento: `primeiraEtapa` (`lib/leads/nascimento-do-lead.ts:109-127`), que passa a ser exportada.
  - O funil tem uma etapa não arquivada com `agent_stage_hint = 'contacted'` numa posição depois da entrada.
  - Existe mensagem `outbound` na conversa com `created_at` depois do nascimento de L e antes desta entrada.
- **Como move:** chama `sincronizaEstagioDoAgente(passo 'contacted')`.
  - A função já tem trava otimista contra humano, atividade `stage_changed` e evento `lead.stage_changed`. Com a guarda de 2.1, ela não puxa o card para trás.
  - Ganha um parâmetro opcional `fonte` (`'primeira-resposta'`), para a atividade e o metadata não dizerem "passo do atendimento" quando quem respondeu foi a recepção.
- **Sem gravação em `lead_state`:** o piso pelo card (2.1) já faz o passo efetivo virar `contacted`. É uma fonte só.
- **Tela:** caixa "Mover para «etapa do Primeiro contato» quando o lead responder pela primeira vez" na seção "Para onde o card vai em cada passo" (`app/app/settings/tenant/pipelines/_mapping.tsx:257`). A chave entra em `pipelineConfigPatchSchema` (`lib/schemas/settings.ts:160-171`).
- **Configuração do André, sem código, depois do deploy:**
  - ligar a caixa no funil Comercial;
  - tirar do roteiro da Cintia (seção 4.4, passo 2, do design da Fase 1) a instrução de marcar "Primeiro contato";
  - trocar "grava na Memória do contato" por "preenche Objetivo e Acompanhamento no card".

---

## 3. Alternativas

| Tema | Opção | Veredito |
|---|---|---|
| Passo por card | **A. Coluna `crm_lead_id` + passo efetivo com piso pelo card** | **Recomendada.** Uma coluna, nenhum leitor muda e sem backfill (linha antiga com `null` cai no piso do card) |
| | B. Rechavear `lead_state` por negócio (`unique (org, crm_lead_id)`) | Mais "correta" para contato com 2 cards abertos ao mesmo tempo, mas reescreve 6 leitores e a fusão de contatos. Fica para quando houver caso real |
| | C. Zerar `lead_state` quando nasce card (dentro de `fn_nascer_lead_da_conversa`) | Só cobre cards nascidos da conversa, não os criados à mão ou por automação. Apaga dado e acopla tabelas |
| Campos | **A. Ferramenta nativa estreita `update_deal_fields`** | **Recomendada.** Só opções da lista, valida contra o funil, sempre disponível e sem marcar pacote |
| | B. `crm_update_lead` do catálogo (depois do pacote 4) | Larga demais (título, valor, dono, troca todos os marcadores) e sem validação de opção. Precisa marcar o pacote "vender" |
| | C. Continuar com a Memória e a recepção copiando | É o estado atual da Fase 1, com trabalho manual a cada pagamento |
| Interagiu | **A. Regra fixa na entrada da mensagem, ligada por funil** | **Recomendada.** Determinística e não depende de a IA estar no atendimento |
| | B. Só o prompt ("marque contacted depois da resposta") | É o estado atual. Fica no juízo do modelo e pode marcar num follow-up |
| | C. Supervisão com `allowed_stage_moves` (migration 0263) | Tem guarda de origem, mas exige um segundo agente, não tem tela e continua sendo proposta do modelo |
| | D. Automação `message.received → create_or_move_lead` | **Não usar.** Puxa para trás a cada mensagem e duplica card |

---

## 4. Decisões do André (3)

> **Decidido pelo André em 07/10/2026:** todas as recomendações desta seção foram aceitas.

**D1. O "Interagiu" automático vale também quando quem respondeu primeiro foi a recepção, e não a Cintia?**
- **Recomendo sim.** "Interagiu" mede se o lead respondeu, não quem falou com ele. É por isso que a regra fica na entrada da mensagem.
- A opção nasce desligada em toda instalação e você liga no funil Comercial. Instalação de outros clientes não muda sozinha.

**D2. Quais campos a Cintia pode preencher?**
- **Recomendo só campos de lista** (escolha única, múltipla ou sim/não). Ela nunca escreve texto livre na ficha.
- Isso segue a regra da Fase 1: "só a categoria, nunca relato de saúde". E impede CPF ou sintoma de cair num campo.

**D3. "Forma de reserva" (Sinal de R$100 / Integral): quem preenche?**
- **Recomendo:** a Cintia registra o que o paciente escolheu quando ela envia a chave, e a recepção corrige na conferência se o pagamento veio diferente.
- A alternativa é deixar só a recepção. Para isso basta a Cintia não ter instrução de preencher; não muda código.

---

## 5. Riscos

1. **Conflito com os pacotes 4 e 6, que mexem em `inbound-turn.ts`** (pacote 4 em `:3481-3488`; pacote 6 em `:1`, `:158`, `:1234-1257`, `:2730`, `:2849` e `:3663`).
   - **Ordem:** começar só **depois** de os dois entrarem na main, numa branch nova a partir da main atualizada. É a regra 1 da higiene de branches.
   - **Superfície:**
     - **Entrega A** não toca `inbound-turn.ts`: só `lead-state.ts`, `agent-stage-sync.ts` e `move-lead-stage.ts`.
     - **Entrega C** também não toca: só `pos-entrada.ts` (uma linha), `nascimento-do-lead.ts` (export), `primeira-resposta.ts` (novo) e a tela.
     - **Entrega B** é a única que toca: 3 inserções de uma linha (o import, a definição da ferramenta no `AGENT_TOOL_DEFS` vinda do arquivo novo e a ferramenta espalhada no objeto de tools perto de `save_lead_note`, `:3135`). Toda a lógica fica em `campos-do-negocio.ts`.
     - O contexto vai por `get-lead-context.ts`, que nenhum pacote toca, e não pelo bloco de prompt de `inbound-turn.ts`.
2. **Número da migration:** o pacote 2 usa `_0317_` e também mexe em `baseline.sql` e `MANIFEST.md`.
   - Calcular o número na hora de codar: `ls supabase/migrations/ | grep -oE '_[0-9]{4}_' | tr -d _ | sort -n | tail -1`.
   - Pôr o apêndice no fim do baseline depois que o pacote 2 entrar.
3. **Mudança de comportamento para quem já instalou:** a guarda de 2.1 ("não volta") muda o espelho de toda instalação. Isso é conserto de defeito, mas entra no fragmento `.changes/` como `capacidade_nova`. A entrega C nasce desligada.
4. **Dois cards abertos do mesmo contato:** continua "ambíguo, não move" (regra que já existe). O passo efetivo cai no comportamento de hoje. É um teto conhecido da opção A.
5. **Escopo de funil vazio:** se a Cintia não tiver o funil Comercial marcado, `update_deal_fields` recusa. Um passo de configuração conferido no teste.
6. **Custo por mensagem da entrega C:** de 2 a 3 consultas a cada entrada. Ela sai cedo quando nenhum funil da organização tem a opção ligada.

---

## 6. Plano de testes

- **Unitários:**
  - **Passo efetivo:** matriz com card novo × linha `won`, linha `null`, card adiantado à mão, sem card e 2 cards.
  - **Transição:** valida a partir do efetivo e grava `crm_lead_id`.
  - **Guarda de posição:** recusa voltar e deixa ganho e perda passarem.
  - **`update_deal_fields`:** chave inválida, opção inválida, `multiselect`, escopo vazio, prévia que vira proposta e merge sem apagar a chave vizinha.
  - **`primeira-resposta`:** só a entrada sem outbound não move; com outbound depois do nascimento move; card fora da etapa de entrada não move; opção desligada não move; humano moveu no meio dá `conflito_humano`.
- **`pnpm test:db`:** a migration em modo install (`ON_ERROR_STOP=1`) e update. O invariante de vocabulário não muda. A anonimização e a fusão de contatos continuam passando com a coluna nova.
- **`pnpm test:unit` completo** (o script todo, não um recorte), mais `typecheck` e `lint`.
- **Prova pela tela** (doutrina de QA visual), em banco fresco pelo `baseline.sql`:
  1. Ligar a caixa e mapear os passos.
  2. Mandar mensagem como lead: o card nasce em Novo lead.
  3. A Cintia responde, o lead responde de novo, e o card aparece em **Interagiu** no Kanban.
  4. A Cintia preenche Objetivo: o valor aparece na ficha do card.
  5. Marcar o card como ganho e mandar mensagem nova do mesmo contato: o card novo **anda**.
  - Evidência em `.superpowers/evidence/` e uma spec em `tests/e2e/`.

---

## 7. Tamanho

| Entrega | Arquivos | Linhas (código + testes) | Sessões |
|---|---|---|---|
| A — passo por card + guarda de posição | migration, apêndice do baseline, MANIFEST, `database.types`, `lead-state.ts`, `agent-stage-sync.ts`, `move-lead-stage.ts` | ~250 | 1 |
| B — negócio no contexto + `update_deal_fields` | `get-lead-context.ts`, `projecao.ts`, `campos-do-negocio.ts` (novo), 3 linhas em `inbound-turn.ts`, `preview.ts`, `entrega-de-capacidade.ts` | ~350 | 1–2 |
| C — Interagiu automático | `primeira-resposta.ts` (novo), `pos-entrada.ts`, `nascimento-do-lead.ts`, `settings.ts`, `_mapping.tsx`, i18n, e2e | ~300 | 1–2 |

São 3 PRs, nesta ordem (A, B, C), cada um com seu fragmento em `.changes/`. A entrega A sozinha já tira o "Limite importante" da Fase 1.
