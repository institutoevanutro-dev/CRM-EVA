# Início com painéis da clínica (parte 3 do redesenho)

Data: 07/10/2026. Aprovado em conversa pelo dono (André): os quatro painéis, a regra de "IA resolveu
sozinha" e a visibilidade só para gestores. Parte 3 de 5 do redesenho do CRM.

## Objetivo

Ao abrir o CRM, quem gere a clínica vê de relance como estão o atendimento, a agenda, as vendas e a
captação, sem abrir quatro telas. O "Meu dia" de hoje continua igual, no topo, para todos.

## Decisões do dono

- Seção nova **"Visão da clínica"**, abaixo do "Meu dia", só para `manager` e `admin` (o servidor
  decide; esconder na tela não é permissão — mesmo padrão de `gestao` em `/api/v1/inicio`).
- **"A IA resolveu sozinha"** = conversa nova em que a IA respondeu e **ninguém da equipe** mandou
  mensagem. As outras: "passou para a equipe" (houve mensagem humana) e "sem resposta" (nenhuma
  saída). Três números honestos, em vez de forçar duas categorias.
- **Indicação** não é registrada hoje: o painel de origem mostra só o que o CRM grava.

## Os quatro painéis

Todas as janelas no **fuso da organização** (`organizations.timezone`, como o painel do funil).

1. **Conversas — últimos 30 dias.** Barras empilhadas por dia: IA sozinha · com a equipe · sem
   resposta. Conversa nova = `conversations.created_at` na janela, `is_group = false`. Ao lado, o
   tempo médio até a primeira resposta (primeira mensagem de saída menos a primeira de entrada, IA
   ou humano) no período inteiro.
2. **Agenda da semana** (segunda a domingo da semana atual). Por unidade (`calendar_units`; sem
   unidade vira "Sem unidade"): marcadas, confirmadas, realizadas (`completed`), faltas
   (`no_show`), canceladas; comparecimento = realizadas ÷ (realizadas + faltas), "—" quando não há
   nenhuma das duas.
3. **Funil de vendas.** Funil padrão (`is_default`, senão o primeiro não arquivado), com seletor
   quando houver mais de um: leads abertos por etapa (etapas não arquivadas, na ordem de
   `position`); ganhos, perdidos e valor vendido (`value_cents`, por moeda) no mês atual e no mês
   anterior (`closed_at`), com a variação.
4. **Origem dos pacientes no mês.** Contatos criados no mês atual (sem anonimizados nem mesclados),
   agrupados por `contacts.source` com rótulo em português (Anúncio do Meta, Anúncio do Google,
   WhatsApp, Formulário/site, Prontuário, Cadastro manual, Outros); quando houver
   `source_metadata->>'utm_source'`, ele aparece como detalhe.

## Arquitetura

- **Banco:** migration `0330` (número reservado com a sessão Graphify) com quatro funções
  `SECURITY INVOKER` (`fn_inicio_conversas_por_dia`, `fn_inicio_agenda_da_semana`,
  `fn_inicio_funil`, `fn_inicio_origem`), cada uma recebendo `p_org` e a janela, e dois índices:
  `conversations (organization_id, created_at)` e `contacts (organization_id, created_at)`. Invoker
  porque a RLS de cada tabela continua valendo; `revoke execute … from public, anon` e `grant` só a
  `authenticated`. O trio da doutrina: arquivo em `migrations/`, bloco idempotente no fim do
  `baseline.sql` e linha no `MANIFEST.md`. Agregação no banco, não paginação no app (PostgREST corta
  em 1000 linhas).
- **API:** `GET /api/v1/inicio/paineis?funil=<uuid>` — `requireRole("manager")`; calcula as janelas
  no fuso da org; cada painel isolado (`{ ok:false }` só nele, como os blocos atuais).
- **Tela:** `app/app/inicio/_components/PaineisDaClinica.tsx` com quatro cartões numa grade 2×2
  (uma coluna no celular), carregados por uma query própria do react-query (não atrasa o "Meu
  dia"), com carregamento em linhas e falha por cartão. Gráfico de barras com `recharts` (já
  instalado), cores dos tokens do tema.

## Fora do escopo

Indicação como origem; tempo de resposta por atendente (já existe em Desempenho); filtros de
período no Início (os períodos são fixos e ditos no título de cada cartão).

## Como provar

Unitários das janelas (30 dias, semana, mês e mês anterior no fuso da org) e dos rótulos de
origem; invariantes no Postgres (`tests/invariants/`) das quatro funções com dados de duas
organizações — números certos e nenhum vazamento entre elas; e2e do Início como gestor (os quatro
cartões aparecem) e como agent (a seção não aparece); prova pela tela com capturas para o dono.
Publicação: PR para o Graphify.
