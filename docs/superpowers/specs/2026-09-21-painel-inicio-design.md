# Painel "Início" — design

**Data:** 2026-09-21 · **Pedido de:** dono do Instituto Eva · **Estado:** aprovado na conversa, aguardando revisão deste texto

## Intenção

Ao entrar no CRM, cada pessoa vê numa tela só **o que precisa fazer agora** e, quem administra,
**o que está impedindo o CRM de funcionar direito**. Hoje isso está espalhado (Central de avisos,
Radar, Inbox, Agenda, Tarefas, Conexões, Desempenho) e o problema só aparece quando alguém tropeça
nele — ex.: "Acupuntura sem responsável" só surgiu ao abrir a agenda.

**Sucesso =** a equipe abre o CRM e sabe o que fazer sem procurar; o dono vê configuração quebrada
antes de um paciente ser afetado.

### O que o dono decidiu (conversa de 2026-09-21)

| Pergunta | Resposta |
|---|---|
| Quem vê | Todos — cada um o que é seu; gestão só para gerente/admin |
| Bloco da equipe | Avisos da Central, pacientes esperando resposta, agenda de hoje, tarefas |
| Bloco de gestão | Configuração pendente, números de hoje, gasto de IA, saúde do sistema |
| Onde fica | Vira a **primeira tela** após o login (e ganha porta no menu) |
| Abordagem | Blocos fixos lendo dados que já existem (não personalizável) |

### Suposições (corrigir se estiver errado)

- "Avisos da Central" é da **clínica toda**: `agent_inbox_items` e `agent_cases` não têm dono no
  schema atual, então todos veem os mesmos avisos abertos. Filtrar por pessoa exigiria coluna nova
  — fora do escopo.
- "Hoje" é o dia no fuso da organização (America/Sao_Paulo no Instituto Eva).

## Tela

```
Início
├─ Meu dia (todos)
│   ├─ 🔔 Avisos abertos da Central      → /app/ai/inbox
│   ├─ 💬 Pacientes esperando resposta   → conversa
│   ├─ 📅 Minha agenda de hoje           → /app/agenda
│   └─ ✅ Minhas tarefas (vencidas/hoje) → /app/tasks
└─ Gestão (manager/admin)
    ├─ ⚠️ Configuração pendente          → tela que resolve cada item
    ├─ 📊 Números de hoje
    ├─ 💰 Gasto de IA no mês
    └─ 🟢 Sistema
```

Cada bloco: título, contagem, até 5 itens, botão "Resolver"/"Ver todos". Vazio → "Tudo em dia ✓".
Falha ao carregar → "Não consegui carregar este bloco" **só naquele bloco** (degradação por bloco).

## Fonte de cada bloco (só leitura, sem mudança de schema)

| Bloco | Fonte | Filtro |
|---|---|---|
| Avisos | `agent_inbox_items` | `status` aberto, da organização |
| Esperando resposta | `conversations` | `assigned_to_user_id = eu` (ou sem dono, para quem atende a fila), `last_inbound_at > coalesce(last_outbound_at, '-infinity')`, não grupo |
| Agenda de hoje | `calendar_appointments` | `owner_user_id = eu`, `starts_at` hoje, não cancelado |
| Tarefas | `crm_tasks` | `assigned_to = eu`, `due_date <= hoje`, não concluída |
| Configuração pendente | `calendar_event_types` ativos sem `default_owner_user_id`; `team_invites` pendentes vencidos (`expires_at < now()`, sem `accepted_at`/`revoked_at`); `channel_sessions` com `status` diferente de conectado; `ai_agents` sem versão publicada | organização |
| Números de hoje | conversas iniciadas, agendamentos criados, leads ganhos — reaproveitar os cálculos de `/app/metrics` | organização, hoje |
| Gasto de IA | `ai_budgets` (`current_month_consumed_cents` / `monthly_limit_cents`) | organização |
| Sistema | `/api/v1/health` (status + versão no ar). **Sem** "atualização disponível": esse aviso compara com as releases do projeto original, e esta instalação atualiza pelo GHCR `:latest` do fork | instalação |

Nomes exatos de status/colunas conferidos na implementação contra o `baseline.sql`.

## Arquitetura

- **Página** `app/app/inicio/page.tsx` (server component) + porta em `lib/navigation/catalogo.ts`.
- **Primeira tela:** `homeDaInterface` passa a preferir `/app/inicio` quando visível; cai no
  comportamento atual (Inbox) se a interface da pessoa ocultar a área.
- **Uma rota** `GET /api/v1/inicio` com cliente de sessão (RLS). Cada bloco é uma função pura em
  `lib/inicio/<bloco>.ts` que recebe o cliente e devolve `{ ok, itens, total }` ou `{ ok:false }`;
  a rota roda todas em paralelo (`Promise.allSettled`) e nunca falha inteira.
- Blocos de gestão só são calculados para `manager`/`admin` (checagem no servidor, não só na tela).
- Atualiza ao voltar o foco para a aba (React Query `refetchOnWindowFocus`); sem polling.
- i18n: textos via `t()` com entrada em espanhol no dicionário.

## Fora do escopo (YAGNI)

Personalizar/arrastar blocos; dono por aviso da Central; notificações push; histórico/gráficos.

## Testes

- Unitários por bloco (dublê que aplica filtros de verdade, como `agenda/vinculos/route.test.ts`),
  incluindo isolamento: item de outra organização não aparece; item de outra pessoa não aparece nos
  blocos pessoais; bloco de gestão vazio para `agent`.
- Rota: um bloco que lança não derruba os outros.
- Navegação: `navegacao-completude` com a porta nova.
- Prova pela tela (Playwright) em ambiente fresco: admin vê as duas seções; colaborador só "Meu dia";
  "Acupuntura sem responsável" aparece em Configuração pendente e o botão leva à tela certa.

## Sistema vivo

Entrada: dados já existentes. Saída: links para a tela que resolve. Porta: menu + primeira tela.
Laço de retorno: resolver o item o tira do painel no próximo carregamento.
