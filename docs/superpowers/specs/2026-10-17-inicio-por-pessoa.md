# Início por pessoa e Visão da clínica como painel de gestão

Data: 2026-10-17 · Pedido do dono do produto · Complementa
`2026-09-21-painel-inicio-design.md` e `2026-10-07-inicio-paineis-design.md`.

## 1. "Meu dia" mostra só o que é de quem está logado

| Bloco | Regra | Onde |
|---|---|---|
| Pacientes esperando resposta | conversa com `assigned_to_user_id` = a pessoa, aberta, não-grupo, contato não oculto, última mensagem do paciente | `esperandoResposta` |
| Minha agenda de hoje | compromisso com `owner_user_id` = a pessoa (o profissional), hoje no fuso, sem cancelado nem excluído por engano | `agendaDeHoje` |
| Minhas tarefas | `crm_tasks.assigned_to` = a pessoa, pendente ou em andamento, vence até o fim de hoje | `minhasTarefas` |
| Meus avisos | regra abaixo | `avisosAbertos` |

### Avisos da Central (`agent_inbox_items`)

O aviso não tem dono no schema; o dono é **derivado da referência**
(`ref_kind`/`ref_id`), em `escopoDoAviso` (`lib/inicio/meu-dia.ts`):

| Referência | Dono |
|---|---|
| `conversation` | quem atende a conversa |
| `appointment` | o profissional do compromisso |
| `agent_case` | quem atende a conversa do caso |
| `followup_enrollment`, `contact` | quem atende alguma conversa do contato, ou é dono de um lead aberto dele |

Escopos: `meu` (a pessoa está entre os donos), `de_outra_pessoa` (há dono, e
não é ela), `sem_dono` (referência de paciente sem ninguém — ou que sumiu) e
`organizacao` (qualquer outra referência: canal, agente, orçamento, fila,
escalação de LGPD ou jailbreak; e os tipos `message_send_stuck` e
`capabilities_missing`, que citam uma conversa só como exemplo de defeito da
operação — o mesmo corte da anonimização).

Quem recebe (`avisoChegaAQuem`):

| Escopo | viewer · provider · agent | manager · admin |
|---|---|---|
| `meu` | sim | sim |
| `de_outra_pessoa` | não | não |
| `sem_dono` | não | sim |
| `organizacao` | não | sim |

O de outra pessoa não chega a ninguém no "Meu dia"; segue na Central de
avisos, que é a lista da equipe toda. Os dados continuam sob a RLS de sempre:
a regra decide o que a primeira tela destaca, não o que a pessoa pode ler.

Custo: uma leitura dos avisos abertos (até 1000) e no máximo duas rodadas de
consultas em lote para os donos — nunca uma por aviso.

## 2. Visão da clínica (só manager/admin)

A rota `/api/v1/inicio/paineis` segue exigindo `manager`. Ganhou o painel
`resumo`, de `fn_inicio_resumo_da_clinica` (migration 0376, `security
invoker`): agenda da semana por profissional (hoje, semana, minutos marcados,
realizadas, faltas, canceladas), conversas esperando resposta agora (total, sem
responsável, a espera mais antiga) e leads novos/ganhos no mês com o mês
anterior. Os nomes dos profissionais vêm de `nomesDosAtendentes`.

Tela: faixa de indicadores (esperando agora, consultas hoje, comparecimento da
semana, IA sozinha em 30 dias, leads novos, negócios ganhos, agendamentos
criados hoje, conversas hoje), agenda por profissional, conversas de 30 dias,
funil, agenda por unidade e origem. "Números de hoje" saiu do bloco Gestão e
entrou na faixa.

Fora de escopo: ocupação em % da jornada de cada profissional (exige ler
`attendant_availability` e calcular a capacidade); a tela mostra horas
marcadas.
