# Parte 4 — Conversas (Inbox): visual, fotos, fonte e foco em vendas

Desenho aprovado por André em 07/10/2026, com a prévia em chat e os acréscimos
dele: fonte bonita e igual aos outros sistemas, foto das pessoas, UX pensada
para vendas, e os outros sistemas (site institucional, PrecificaEva) como
referência.

Base: `perf/conversas-funil` (PR #161). Os dois tocam `MessageBubble` e os
hooks do inbox, e partir dele evita conflito. Este PR entra depois do #161.

## Fora do escopo

- Nenhuma migration.
- Nenhuma função sai da tela: o que deixa de ficar à vista vai para um menu ou
  para "Mais".
- O vocabulário de filtros e de comando não muda. Só muda a apresentação.

## Tarefas

### 1. Fonte (`app/layout.tsx`, `app/globals.css`)
- Inter no lugar de Atkinson Hyperlegible para o texto. O site institucional e o
  PrecificaEva já usam Inter.
- Josefin Sans para os títulos (`--font-titulo`, utilitário `font-titulo`), como
  o PrecificaEva. Os títulos de página (`h1`) e de cartão do app usam essa fonte.
- Prova: os testes de tokens seguem verdes, e a fonte computada é medida no
  Playwright.

### 2. Fotos
- `contact-avatars`: `SCAN_LIMIT` passa de 25 para 60 por rodada. A rodada é a
  cada 10 minutos, então a fila de quem nunca teve foto esvazia em horas, não
  em dias.
- Instagram: a lista passa a pedir `avatar_url` em `contact_channel_identities`
  (o campo já é gravado por `perfil-do-contato.ts`).
- `components/inbox/AvatarDoContato.tsx` é um só componente para a lista, o
  topo e a ficha. A ordem da fonte da foto é: arquivo no Storage, depois a foto
  do Instagram, depois as iniciais. Uma imagem que não carrega cai nas
  iniciais (fallback do Radix).

### 3. Lista
- Filtros: a busca e um botão de ajustes ficam numa linha. Número, etiquetas e
  "Não lidos" vão para dentro de um popover, e um contador mostra quantos
  filtros estão ativos.
- Abas: Fila, Minhas e Todas ficam à vista. As outras vão para "Mais", que
  mostra o nome da aba ativa quando ela é uma das escondidas.
- Item:
  - a bolinha colorida vira um selo escrito (IA, Equipe, Aguardando, Encerrada);
  - o chip com o número da clínica sai, e fica só o selo do Instagram;
  - entra a etapa do funil do negócio aberto mais recente do contato.
- `etapa_atual` vem do handler da lista: uma consulta a mais por página, em
  lote pelos contatos da página.

### 4. Conversa
- Topo:
  - uma linha só, com foto, nome, selo de situação, telefone e responsável;
  - a ação principal fica à vista (Assumir ou Devolver);
  - o resto vai para o menu "⋯";
  - o botão "Ficha" abre a ficha em painel lateral em toda largura abaixo de
    `xl`. Hoje ele só existe no modo celular.
- Balões:
  - fundo creme;
  - paciente em balão branco;
  - IA em verde claro com "Assistente IA";
  - equipe em verde Eva com o nome de quem enviou;
  - separador de dia em pílula.
- Data sobreposta ao texto (print de 07/10): achar a causa e corrigir.
- Caixa de escrever: um cartão com as abas Responder e Nota no alto. "Sugerir
  resposta" vira botão na barra, junto com o anexo e o emoji, e o quadro
  "Assistência do agente" separado some.

### 5. Ficha (CRMSidePanel)
- Seções que abrem e fecham (`<details>`), nesta ordem: **Negócio** (aberta),
  Paciente, Demandas, Memória, Pedidos e atividades.
- O Negócio traz:
  - etapa, valor e próxima ação;
  - os botões Agendar, Ganhou (move para a etapa de ganho), Perdeu
    (`LoseLeadDialog`, com o motivo) e Novo negócio.

### 6. Fechamento
- i18n (es) para todo texto novo.
- Testes de unidade para o avatar e para o selo de comando.
- e2e do inbox verde, com print em claro e escuro.
- `.changes/` com `capacidade_nova`.
- Gates: tsc, lint e `pnpm test:unit`.
