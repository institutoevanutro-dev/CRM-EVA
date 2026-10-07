# Cores e menu do CRM da Eva (parte 2 do redesenho)

Data: 07/10/2026. Aprovado em conversa pelo dono (André). Parte 2 de 5 do redesenho do CRM
(1 velocidade, 2 cores e menu, 3 Início, 4 Inbox, 5 revisão das telas).

## Objetivo

O CRM deve parecer da mesma família do Eva Financeiro e do PrecificaEva, e o colaborador deve
entender onde está e para que serve cada tela sem treinamento. O menu lateral hoje tem cerca de
20 linhas em 6 grupos mais 3 links "Ver tudo em…"; isso confunde e polui.

## Decisões do dono

- Tema **claro é o padrão**, igual ao Financeiro; o **escuro continua disponível** para quem
  escolher, redesenhado em verde fechado (não mais o preto/cinza atual).
- Menu lateral com **6 entradas**: Início, Atendimento, Vendas, IA, Análise e Configurações
  (rodapé). Dentro de cada área, **abas no topo** com uma frase do que a tela faz.
- O grupo "CRM" passa a se chamar **Vendas**. O grupo "Canais" (Conexões, Webhooks,
  Nuvemshop) entra em **Configurações**. As telas "Ver tudo em…" saem do menu.

## Referência visual (medida no código do Financeiro, `~/eva-financeiro/app/globals.css`)

| Papel | Valor |
|---|---|
| Verde da marca (botões, links, foco) | `#27463b` |
| Verde fundo do menu | `#1d352c` |
| Dourado (só sobre verde) | `#d9b24c` |
| Fundo da página | `#f7f4ec` (creme) |
| Cartão | `#ffffff`, borda `#e6e1d3`, `rounded-2xl`, `shadow-sm` |
| Cabeçalho de tabela / hover | `#efece3` / `#fbf9f4` |
| Texto do menu | `#e9e2c8` |
| Fontes | Inter (texto), Josefin Sans (títulos, caixa alta, tracking largo) |
| Item ativo do menu | fundo `white/10`, texto dourado, barra dourada de 4px à esquerda |

O dourado não tem contraste para texto sobre fundo claro (regra já escrita no Financeiro): no
tema claro ele só aparece sobre o verde do menu ou como traço/sublinhado, nunca como texto.

## Desenho

### 1. Tokens (`app/globals.css`)

- Tema claro (`:root` e `[data-theme="light"]`): superfícies e bordas trocam para a tabela acima
  (`--color-bg #f7f4ec`, `--color-border #e6e1d3`, etc.). O accent continua vindo da marca no
  banco (já gravada `#27463b` em Configurações › Marca em 07/10); o padrão do arquivo passa a
  ser a rampa gerada de `#27463b` para que uma instalação sem marca também fique verde Eva.
- Tokens novos do menu: `--color-sidebar-bg`, `--color-sidebar-fg`, `--color-sidebar-muted`,
  `--color-sidebar-active-bg`, `--color-gold`. O menu é verde-escuro nos DOIS temas.
- Tema escuro (`[data-theme="dark"]`): superfícies em verde fechado (base perto de `#0f1d18`,
  cartões `#152820`, bordas `#24392f`), texto creme. Desenhado à parte, não invertido; o
  contraste é medido pelo teste existente (`tailwind-tokens.test.ts`, piso 4,5:1).
- Padrão do tema: `lib/theme.tsx` muda o padrão de `"system"` para `"light"`. Quem já escolheu
  escuro no seletor continua no escuro (a escolha fica no `localStorage`).

### 2. Fontes (`app/layout.tsx`)

Inter (`--font-sans`) e Josefin Sans (`--font-titulo`, pesos 300/400/600) por `next/font`.
IBM Plex Mono fica para números/código. Títulos de página (`h1`) e de grupo usam Josefin em
caixa alta com tracking; o resto do texto, Inter.

### 3. Menu lateral (`components/shell/Sidebar.tsx`, `MobileSidebar.tsx`)

- 6 entradas, cada uma com ícone e nome: Início, Atendimento, Vendas, IA, Análise; Configurações
  no rodapé. Clicar numa área abre a primeira tela dela (ou a última aberta naquela área,
  guardada no `localStorage`).
- Área ativa = a área da tela atual (derivada do catálogo pelo `pathname`), com o estilo de item
  ativo do Financeiro.
- Logo das folhas sem moldura branca (o menu é sempre verde, então a moldura deixa de ser
  necessária); continua o modo recolhido (só ícones) que já existe.
- O teste `navegacao.spec.ts` (menu cabe sem rolar em 1280×900) fica mais folgado.

### 4. Abas da área (componente novo `components/shell/AbasDaArea.tsx`)

- Renderizado uma vez no shell (abaixo do `TopBar`), sem mover nenhuma rota: lê do catálogo o
  grupo da tela atual e desenha as abas daquele grupo.
- Aba ativa com sublinhado dourado; abaixo, a frase da tela atual (campo `description` que o
  catálogo já tem para todas as telas).
- Até 5 abas visíveis; o resto em "Mais ▾". No celular, as abas rolam na horizontal.
- Telas fora de grupo (Início, telas de detalhe como `/app/leads/[id]`) não mostram abas.

### 5. Catálogo (`lib/navigation/catalogo.ts`)

- Grupo `crm` muda o rótulo para "Vendas" (o id interno continua `crm` para não quebrar testes
  e preferências salvas).
- Itens do grupo `canais` passam para o grupo `organizacao` (Configurações).
- `sidebar: true` passa a significar "aba principal" (até 5 por área; as outras vão para
  "Mais"); o menu lateral lista áreas, não telas. O grupo `ia` passa a se chamar "IA".
- As páginas hub (`/app/crm`, `/app/ai`, `/app/analise`) continuam existindo (o
  `navegacao-completude.test.ts` exige que toda rota tenha porta), mas saem do menu; ficam
  alcançáveis pela busca ⌘K e pelo "Mais".

## Fora do escopo

Velocidade (parte 1), conteúdo do Início (parte 3), visual do Inbox (parte 4), textos das demais
telas (parte 5). Tela de login e e-mails não mudam.

## Riscos

- **Specs e2e que clicam no menu lateral** (por exemplo `navegacao.spec.ts`,
  `interface-por-vinculo.spec.ts`, `relatorio-*.spec.ts`, `webhooks.spec.ts`) vão precisar
  achar a tela pela aba em vez do link lateral. O `e2e` é check obrigatório: cada spec afetada é
  ajustada no mesmo PR.
- `logo-moldura-no-tema-escuro.spec.ts` e `marca-logo.spec.ts` medem a moldura do logo: são
  revistas junto com a decisão de tirar a moldura.
- `branding.test.ts` proíbe nome da marca no código: nenhuma string "Eva" entra em componente;
  as cores ficam como tokens, não como marca.
- Interfaces por vínculo (`lib/navigation/interface.ts`, `canSee`) continuam filtrando o que
  cada papel vê; uma área sem nenhuma tela visível para o papel some do menu.

## Como provar

`pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (inclui tokens, branding e completude do menu),
e2e das specs de navegação afetadas, e prova pela tela como um colaborador: entrar, navegar por
cada área pelas abas, nos dois temas, em 1280×900 e no celular, com capturas para o dono antes do
PR. Publicação: PR para o Graphify, que libera e publica.
