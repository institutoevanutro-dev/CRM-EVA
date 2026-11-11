# Início claro — os números dizem o que parecem dizer

Data: 2026-11-11 · Pedido do dono do produto · Ajusta
`2026-09-21-painel-inicio-design.md`, `2026-10-07-inicio-paineis-design.md` e
`2026-10-17-inicio-por-pessoa.md` (o que não é citado aqui segue valendo lá).

## Por quê

A página tinha números verdadeiros que enganavam: "ninguém esperando" com 210
conversas sem responsável; "210 esperando" somando espera de qualquer idade;
"139 avisos" sem dizer do quê; "794 leads a menos" comparando mês pela metade
com mês inteiro; "10 h 58 m até a primeira resposta" como média; "3 negócios
ganhos" ao lado de "0 ganhos" (todos os funis × um funil); canal de histórico
contado como configuração pendente.

## Regras (CONFIRMADO no código)

| Regra | Onde |
|---|---|
| "Esperando resposta" = não é grupo, não é contato oculto, conversa aberta, última mensagem do paciente | `fn_inicio_esperando` (migration 0408) — a ÚNICA definição, para o Meu dia e a Visão da clínica |
| Espera **recente** = começou há no máximo 3 dias, medida por `coalesce(awaiting_since, last_inbound_at)` | `DIAS_DE_ESPERA_RECENTE` em `lib/inicio/tipos.ts`; a rota passa o corte à função |
| Meu dia: o número grande = recentes **com você + sem responsável**; antigas à parte | `esperandoResposta` (`lib/inicio/meu-dia.ts`) |
| O quadro não conta conversa que a pessoa não abre | a função é `security invoker`: vale a RLS (`fn_can_view_conversation`); `ve_sem_responsavel` esconde a linha de quem não vê a fila |
| Avisos: mesma regra de dono (`escopoDoAviso`/`avisoChegaAQuem`), saída por assunto — 4 maiores + "Outros avisos do sistema" | `agruparAvisos`; rótulos em `ROTULO_DO_ASSUNTO`, senão o da Central (`KIND_LABEL`); `other` e tipo desconhecido somam em "outros" |
| Cada linha de aviso abre a Central inteira | a Central não filtra por tipo na URL |
| Tarefas: sem tarefa, uma linha no lugar do quadro | `PainelInicio.tsx` |
| "De cada 10 conversas novas…": maior resto, soma sempre 10; o fim da frase concorda com o número ("3 ficaram", "1 ficou", "menos de 1 ficou", "nenhuma ficou") | `deCadaDez` (`lib/inicio/paineis.ts`) e `DE_CADA_10` (`PaineisDaClinica.tsx`) |
| Tempo até a primeira resposta = **mediana**, entre as conversas respondidas; abaixo de 1 min, "na hora" | `fn_inicio_atendimento` (`percentile_cont`), no lugar de `fn_inicio_conversas_por_dia`, que saiu com o gráfico por dia |
| Pacientes novos: o mês contra **os mesmos dias** do mês anterior (até o mesmo dia e hora; mês anterior mais curto → ele inteiro) | `janelasDosPaineis` → `p_ant_fim` de `fn_inicio_resumo_da_clinica` |
| Vendas fechadas, desistências e valor (por moeda): **todos os funis** | bloco `vendas` de `fn_inicio_resumo_da_clinica` |
| "Onde os pacientes estão agora": etapas do funil escolhido, na ordem; nomes como a clínica cadastrou | `fn_inicio_funil` (só `etapas`) |
| "Para arrumar" não conta canal arquivado nem canal de histórico (`status_reason = 'historico_da_org_antiga'` ou `metadata.migracao_org_antiga`) | `configuracaoPendente`/`ehCanalDeHistorico` (`lib/inicio/gestao.ts`) |

## Tela

- **Meu dia**: Pacientes esperando resposta · Minha agenda de hoje; abaixo,
  Avisos por assunto (largura toda; divide com Minhas tarefas quando há tarefa).
- No celular (abaixo de 640 px) as duas tabelas da agenda viram lista — cada
  número com o nome da coluna na frente — e nada rola para o lado; alvos de
  toque com 44 px.
- **Visão da clínica** (gerente e admin), em blocos com o período no título:
  *A clínica hoje* (consultas, quem escreveu, agendamentos feitos; agenda por
  profissional e por unidade na semana) · *Atendimento · últimos 30 dias* (a
  frase, uma barra, a mediana, quem espera agora) · *Vendas · mês, todos os
  funis* (pacientes novos, vendas fechadas, desistências; etapas do funil
  escolhido; origem).
- **Gestão**: Sistema · Gasto com IA no mês · Para arrumar, em três quadros
  pequenos; abaixo, a lista do que arrumar por tipo.

## Limites conhecidos (INFERIDO a partir do código, não medido em produção)

- A mediana considera só conversas que tiveram resposta; as sem resposta
  aparecem na mesma frase e na legenda, não dentro do tempo.
- Na frase "de cada 10", uma faixa com menos de 5% das conversas arredonda para
  zero. Para "sem resposta" a frase diz "menos de 1 ficou sem resposta" (nunca
  "nenhuma" quando alguma ficou); para a equipe e a IA sai "0", e a contagem
  exata está na legenda da barra.
- "Sistema" segue dizendo só "algum serviço está fora do ar": nomear o serviço
  exigiria ler as chaves da rota de saúde, uma delas com nome de provedor de
  canal (doutrina de restrição de canal).

## Prova

Unitários em `lib/inicio/*.test.ts`, `app/api/v1/inicio/**/route.test.ts`,
`app/app/inicio/_components/PaineisDaClinica.test.tsx` e
`tests/unit/painel-inicio-so-pendencia-ganha-cor.test.tsx`; invariantes em
`tests/invariants/inicio-esperando.test.ts`, `inicio-paineis.test.ts` e
`inicio-visao-da-clinica.test.ts`; pela tela em `tests/e2e/painel-inicio.spec.ts`
e `tests/e2e/inicio-por-pessoa.spec.ts`.
