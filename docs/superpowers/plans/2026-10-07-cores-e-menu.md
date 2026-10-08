# Cores e menu do CRM — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CRM com as cores e fontes do Eva Financeiro e um menu lateral de 6 áreas, cada área com abas no topo e uma frase do que a tela faz.

**Architecture:** Tudo continua saindo do catálogo de navegação (`lib/navigation/catalogo.ts`): o registro ganha duas projeções novas (`areasDoMenu`, `abasDaArea`) e uma função pura `areaDaRota`. O menu lateral passa a desenhar áreas; um componente novo (`AbasDaArea`) desenha as abas logo abaixo do `TopBar`, sem mover nenhuma rota. Cores e fontes mudam só em `app/globals.css`, `app/layout.tsx` e `lib/theme.tsx`.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind 4 (CSS-first), Vitest + Testing Library, Playwright, `next/font/google`, Phosphor icons.

**Spec:** `docs/superpowers/specs/2026-10-07-cores-e-menu-design.md`

**Worktree:** `~/crm-eva-visual`, branch `feat/cores-e-menu` (base `origin/main` 5b277995f). Não editar `~/CRM-EVA`. PR vai para o Graphify, que libera e publica.

## Global Constraints

- Paleta (medida no Financeiro): marca `#27463b`, menu `#1d352c`, dourado `#d9b24c`, fundo `#f7f4ec`, cartão `#ffffff`, borda `#e6e1d3`, cabeçalho de tabela `#efece3`, hover `#fbf9f4`, texto do menu `#e9e2c8`.
- Dourado nunca é cor de TEXTO sobre fundo claro (sem contraste); no claro só aparece sobre o verde do menu ou como traço.
- Fontes: Inter (texto, `--font-sans`), Josefin Sans 300/400/600 (títulos, `--font-titulo`), IBM Plex Mono continua (`--font-mono`).
- Tema padrão `light`; `dark` continua disponível e é desenhado à parte (verde fechado), nunca invertido.
- Menu: 6 entradas — Início, Atendimento, Vendas, IA, Análise; Configurações no rodapé.
- Rótulo do grupo `crm` = "Vendas" e do grupo `ia` = "IA"; os ids não mudam.
- "Aba principal" reaproveita o campo `sidebar: true` do catálogo (em vez de um campo `aba` novo, como dizia a spec): mesmo significado, e o teste de tradução de `idioma-da-interface.test.ts` já cobre esses rótulos.
- Itens do grupo `canais` passam para `organizacao`; o tipo `NavGroupId` perde `"canais"`.
- Nenhuma rota muda de endereço.
- Nenhum nome de marca em código (`tests/unit/branding.test.ts`); cores só como tokens.
- Todo rótulo novo visível entra em `lib/i18n/dicionario.ts` com o espanhol.
- `pnpm typecheck`, `pnpm lint` e `pnpm test:unit` (sem caminho) verdes antes do PR; exit code é a autoridade.

## Review Focus

1. Rota de detalhe que não está no catálogo (`/app/leads/123`, `/app/pipelines/abc`) — o usuário espera continuar vendo a área certa marcada (Vendas) e, quando há tela-mãe óbvia, a aba dela ativa; nunca abas de outra área.
2. Papel `viewer`/`agent` ou interface por vínculo que esconde todas as telas de uma área — a área deve sumir do menu, e nenhuma aba deve levar a /403.
3. Quem já escolheu tema escuro antes desta mudança — deve continuar no escuro depois do deploy (a escolha salva vence o padrão novo).
4. Celular (390×844) — as abas rolam na horizontal sem empurrar a página para o lado; o menu do celular mostra as mesmas 6 áreas.
5. Logo enviado com fundo escuro ou sem transparência — continua legível no menu verde sem a moldura branca (se não for, a moldura volta só para esse caso).

---

### Task 1: Tokens de cor (claro, escuro e menu)

**Files:**
- Modify: `app/globals.css` (blocos `:root`, `[data-theme="light"]`, `[data-theme="dark"]` e `@theme inline`)
- Create: `tests/unit/tema-eva.test.ts`

**Interfaces:**
- Produces: tokens CSS `--color-sidebar-bg`, `--color-sidebar-fg`, `--color-sidebar-muted`, `--color-sidebar-active-bg`, `--color-gold`, `--color-table-head`, `--color-row-hover`, e os utilitários Tailwind `bg-sidebar`, `text-sidebar-fg`, `text-sidebar-muted`, `bg-sidebar-active`, `text-gold`, `bg-gold`, `border-gold`, `bg-table-head`, `bg-row-hover` (ponte no `@theme inline`).

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/tema-eva.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("app/globals.css", "utf8");
const bloco = (seletor: string) => {
  const i = css.indexOf(`${seletor} {`);
  expect(i, `bloco ${seletor} não existe`).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("\n}", i));
};
const valor = (b: string, token: string) => new RegExp(`${token}:\\s*([^;]+);`).exec(b)?.[1]?.trim();

describe("cores iguais às do Financeiro", () => {
  it("tema claro: creme, borda bege, menu verde", () => {
    for (const seletor of [":root", '[data-theme="light"]']) {
      const b = bloco(seletor);
      expect(valor(b, "--color-bg")).toBe("#f7f4ec");
      expect(valor(b, "--color-border")).toBe("#e6e1d3");
    }
    const raiz = bloco(":root");
    expect(valor(raiz, "--color-sidebar-bg")).toBe("#1d352c");
    expect(valor(raiz, "--color-sidebar-fg")).toBe("#e9e2c8");
    expect(valor(raiz, "--color-gold")).toBe("#d9b24c");
  });
  it("tema escuro é verde fechado, não cinza", () => {
    const b = bloco('[data-theme="dark"]');
    expect(valor(b, "--color-bg")).toBe("#0f1d18");
    expect(valor(b, "--color-surface")).toBe("#152820");
    expect(valor(b, "--color-sidebar-bg")).toBe("#0b1612");
  });
  it("tokens do menu viram utilitários", () => {
    expect(css).toMatch(/--color-sidebar:\s*var\(--color-sidebar-bg\)/);
    expect(css).toMatch(/--color-gold:\s*var\(--color-gold\)|--color-gold:/);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run tests/unit/tema-eva.test.ts`
Expected: FAIL (`--color-bg` é `#faf9f6`).

- [ ] **Step 3: Trocar os tokens**

Em `:root` e `[data-theme="light"]`:
```css
  --color-bg: #f7f4ec;
  --color-surface: #ffffff;
  --color-surface-elevated: #f3efe4;
  --color-border: #e6e1d3;
  --color-border-strong: #d6cfbd;
  --color-text: #171717;
  --color-text-muted: #525252;
  --color-text-subtle: #6b6b6b;
  --color-table-head: #efece3;
  --color-row-hover: #fbf9f4;
```
Só em `:root` (vale para os dois temas, o menu é verde sempre) e redefinido no escuro:
```css
  /* Menu lateral: verde do Financeiro nos dois temas. */
  --color-sidebar-bg: #1d352c;
  --color-sidebar-fg: #e9e2c8;
  --color-sidebar-muted: #b9b39c;
  --color-sidebar-active-bg: rgba(255, 255, 255, 0.1);
  --color-gold: #d9b24c;
```
Em `[data-theme="dark"]`:
```css
  --color-bg: #0f1d18;
  --color-surface: #152820;
  --color-surface-elevated: #1b3129;
  --color-border: #24392f;
  --color-border-strong: #2f4a3e;
  --color-text: #f1ede0;
  --color-text-muted: #b5b09f;
  --color-text-subtle: #8f8a7a;
  --color-table-head: #1b3129;
  --color-row-hover: #182c24;
  --color-sidebar-bg: #0b1612;
```
Trocar também os `--color-neutral-*` do escuro para a mesma família verde (50 `#f1ede0`, 100 `#ddd8c8`, 200 `#b5b09f`, 300 `#8f8a7a`, 400 `#5e6b63`, 500 `#2f4a3e`, 600 `#24392f`, 700 `#1b3129`, 800 `#152820`, 900 `#0f1d18`, 950 `#08110d`).
No `@theme inline` acrescentar:
```css
  --color-sidebar: var(--color-sidebar-bg);
  --color-sidebar-fg: var(--color-sidebar-fg);
  --color-sidebar-muted: var(--color-sidebar-muted);
  --color-sidebar-active: var(--color-sidebar-active-bg);
  --color-gold: var(--color-gold);
  --color-table-head: var(--color-table-head);
  --color-row-hover: var(--color-row-hover);
```
O accent padrão do arquivo (`--color-accent-50…950`) passa a ser a rampa de `#27463b`: gerar com `node -e 'import("./lib/branding/rampa.ts")'` não roda TS; usar o teste do próprio rampa (`pnpm vitest run lib/branding`) como referência e copiar a saída de `rampaDe("#27463b")` imprimida por um teste temporário — não commitar o teste temporário.

- [ ] **Step 4: Rodar o teste novo e o guarda de tokens**

Run: `pnpm vitest run tests/unit/tema-eva.test.ts tests/unit/tailwind-tokens.test.ts lib/branding`
Expected: PASS. Se `tailwind-tokens` reprovar contraste de algum `text-<token>/<alpha>`, ajustar o token reprovado (nunca o teste).

- [ ] **Step 5: Commit**

```bash
git add app/globals.css tests/unit/tema-eva.test.ts
git commit -m "feat(tema): cores do Eva Financeiro no claro e verde fechado no escuro"
```

### Task 2: Tema claro como padrão

**Files:**
- Modify: `lib/theme.tsx` (fallbacks `"system"` → `"light"` em `readStoredTheme`, no snapshot de servidor e no `THEME_INIT_SCRIPT`)
- Test: `tests/unit/tema-padrao-claro.test.ts`

**Interfaces:**
- Consumes: `STORAGE_KEY = "deskcomm-theme"` (não muda — preserva a escolha de quem já usa escuro).

- [ ] **Step 1: Teste que falha**

```ts
// tests/unit/tema-padrao-claro.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { readStoredTheme, STORAGE_KEY, THEME_INIT_SCRIPT } from "@/lib/theme";

afterEach(() => window.localStorage.clear());

describe("tema padrão", () => {
  it("sem escolha salva, é claro", () => {
    expect(readStoredTheme()).toBe("light");
  });
  it("quem escolheu escuro continua no escuro", () => {
    window.localStorage.setItem(STORAGE_KEY, "dark");
    expect(readStoredTheme()).toBe("dark");
  });
  it("o script anti-piscada também começa no claro", () => {
    expect(THEME_INIT_SCRIPT).not.toMatch(/\|\|\s*["']system["']/);
  });
});
```
(Se `readStoredTheme` não for exportado hoje, exportá-lo no Step 3.)

- [ ] **Step 2: Rodar e ver falhar** — `pnpm vitest run tests/unit/tema-padrao-claro.test.ts` → FAIL (`"system"`).
- [ ] **Step 3: Implementar** — trocar os retornos padrão `"system"` por `"light"` nas linhas 25, 32 e 81 de `lib/theme.tsx` e o valor padrão dentro de `THEME_INIT_SCRIPT`. O tipo `Theme` continua aceitando `"system"`.
- [ ] **Step 4: Rodar** — `pnpm vitest run tests/unit/tema-padrao-claro.test.ts tests/unit/hidratacao-useState-nao-le-o-navegador.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(tema): claro é o padrão; escolha salva continua valendo"`

### Task 3: Fontes Inter e Josefin Sans

**Files:**
- Modify: `app/layout.tsx:2,29-40` (trocar `Atkinson_Hyperlegible` por `Inter`; acrescentar `Josefin_Sans`)
- Modify: `app/globals.css` (`--font-sans` usa `var(--font-inter)`; novo `--font-titulo`; `font-family` do `body` e de `h1`)
- Test: `tests/unit/tema-eva.test.ts` (acrescentar caso)

- [ ] **Step 1: Acrescentar o teste**

```ts
  it("fontes do Financeiro", () => {
    const layout = readFileSync("app/layout.tsx", "utf8");
    expect(layout).toMatch(/import \{[^}]*\bInter\b[^}]*\} from "next\/font\/google"/);
    expect(layout).toMatch(/\bJosefin_Sans\b/);
    expect(layout).not.toMatch(/Atkinson_Hyperlegible/);
    expect(css).toMatch(/--font-sans:\s*var\(--font-inter\)/);
    expect(css).toMatch(/--font-titulo:\s*var\(--font-josefin\)/);
  });
```
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar**

```ts
// app/layout.tsx
import { IBM_Plex_Mono, Inter, Josefin_Sans } from "next/font/google";
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });
const josefin = Josefin_Sans({ subsets: ["latin"], weight: ["300", "400", "600"], display: "swap", variable: "--font-josefin" });
// no <html className=...>: trocar atkinson.variable por `${inter.variable} ${josefin.variable}`
```
Em `globals.css`: `--font-sans: var(--font-inter), ui-sans-serif, system-ui, …` (trocar `--font-atkinson` nas duas ocorrências, linhas ~547 e ~713), acrescentar `--font-titulo: var(--font-josefin), var(--font-inter), sans-serif;` no `@theme inline`, e em `@layer base`: `h1 { font-family: var(--font-titulo); letter-spacing: 0.08em; text-transform: uppercase; }`.
- [ ] **Step 4: Rodar** `pnpm vitest run tests/unit/tema-eva.test.ts tests/unit/tailwind-tokens.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(tema): Inter no texto e Josefin Sans nos títulos"`

### Task 4: Catálogo e projeções de área

**Files:**
- Modify: `lib/navigation/catalogo.ts` (tipo `NavGroupId` sem `"canais"`; `NAV_GROUPS` com "Vendas" e sem Canais; itens de Conexões, Nuvemshop e Webhooks com `group: "organizacao"` e `section: "Canais"`; `sidebar: true` em Equipe, Tipos de agendamento, Conexões, Marca, Segurança, Conhecimento, Perguntas frequentes, Campanhas, Painel do funil, Por etiqueta)
- Modify: `lib/navigation/registry.ts` (novas `areaDaRota`, `areasDoMenu`, `abasDaArea`)
- Modify: `lib/i18n/dicionario.ts` (`"Vendas": { es: "Ventas" }`, `"Mais": { es: "Más" }`, e o espanhol de cada rótulo que ganhou `sidebar: true` e ainda não tem entrada)
- Test: `tests/unit/menu-por-area.test.ts`; atualizar `tests/unit/navegacao-registry.test.ts` onde ele afirma o grupo `canais`

**Interfaces:**
- Produces:
```ts
export type AreaId = "inicio" | NavGroupId;
export interface AreaDoMenu { id: AreaId; label: string; icon: PhosphorIcon; href: string }
export function areaDaRota(pathname: string): { area: AreaId; abaHref: string | null } | null;
export function areasDoMenu(isPlatformAdmin: boolean, role: Role | null, settings?: InterfaceSettings): AreaDoMenu[];
export function abasDaArea(area: NavGroupId, isPlatformAdmin: boolean, role: Role | null, settings?: InterfaceSettings): { principais: NavDestination[]; mais: NavDestination[] };
```
`areasDoMenu` devolve na ordem Início, atendimento, crm, ia, analise, organizacao (rodapé por último); `href` de cada área = primeira aba principal visível (Configurações = `/app/settings`); área sem nenhuma tela visível não aparece. `abasDaArea` exclui Início, põe `sidebar: true` em `principais` (até 5) e o resto em `mais`, só telas visíveis para o papel.

- [ ] **Step 1: Teste que falha**

```ts
// tests/unit/menu-por-area.test.ts
import { describe, expect, it } from "vitest";
import { abasDaArea, areaDaRota, areasDoMenu, NAV_GROUPS } from "@/lib/navigation/registry";

describe("menu por área", () => {
  it("seis áreas, CRM se chama Vendas, Canais não é área", () => {
    const areas = areasDoMenu(false, "admin");
    expect(areas.map((a) => a.label)).toEqual(["Início", "Atendimento", "Vendas", "IA", "Análise", "Organização"]);
    expect(NAV_GROUPS.some((g) => (g.id as string) === "canais")).toBe(false);
  });
  it("rota do catálogo marca a área e a aba", () => {
    expect(areaDaRota("/app/contacts")).toEqual({ area: "crm", abaHref: "/app/contacts" });
    expect(areaDaRota("/app/connections")).toEqual({ area: "organizacao", abaHref: "/app/connections" });
    expect(areaDaRota("/app/ai/agents/123")).toEqual({ area: "ia", abaHref: "/app/ai/agents" });
  });
  it("quadro do funil e detalhe do lead ficam em Vendas", () => {
    expect(areaDaRota("/app/pipelines/abc")).toEqual({ area: "crm", abaHref: "/app/kanban" });
    expect(areaDaRota("/app/leads/xyz")).toEqual({ area: "crm", abaHref: null });
  });
  it("Início não tem abas e rota desconhecida não tem área", () => {
    expect(areaDaRota("/app/inicio")).toEqual({ area: "inicio", abaHref: null });
    expect(areaDaRota("/app/qualquer-coisa")).toBeNull();
  });
  it("viewer não vê aba que leva a 403", () => {
    const { principais, mais } = abasDaArea("organizacao", false, "viewer");
    expect([...principais, ...mais].some((d) => d.href === "/app/settings/api-tokens")).toBe(false);
  });
  it("no máximo 5 abas principais; o resto vai para Mais", () => {
    const { principais, mais } = abasDaArea("ia", false, "admin");
    expect(principais.length).toBeLessThanOrEqual(5);
    expect(mais.length).toBeGreaterThan(0);
  });
});
```
- [ ] **Step 2: Rodar e ver falhar** — `pnpm vitest run tests/unit/menu-por-area.test.ts` → FAIL (funções não existem).
- [ ] **Step 3: Implementar em `registry.ts`**

```ts
// Telas que não estão no catálogo mas pertencem a uma área.
// ponytail: mapa à mão; vira campo do catálogo se passar de meia dúzia.
const ROTAS_FILHAS: Array<{ prefixo: string; area: NavGroupId; abaHref: string | null }> = [
  { prefixo: "/app/pipelines/", area: "crm", abaHref: "/app/kanban" },
  { prefixo: "/app/leads/", area: "crm", abaHref: null },
];

export type AreaId = "inicio" | NavGroupId;
export interface AreaDoMenu { id: AreaId; label: string; icon: PhosphorIcon; href: string }

export function areaDaRota(pathname: string): { area: AreaId; abaHref: string | null } | null {
  if (pathname === "/app/inicio") return { area: "inicio", abaHref: null };
  const filha = ROTAS_FILHAS.find((r) => pathname.startsWith(r.prefixo));
  if (filha) return { area: filha.area, abaHref: filha.abaHref };
  let melhor: NavDestination | undefined;
  for (const d of NAV_DESTINATIONS) {
    if (d.href === "/app/inicio") continue;
    if ((pathname === d.href || pathname.startsWith(d.href + "/")) && (!melhor || d.href.length > melhor.href.length)) melhor = d;
  }
  if (melhor) return { area: melhor.group, abaHref: melhor.href };
  const hub = NAV_GROUPS.find((g) => g.hub && pathname === g.hub.href);
  return hub ? { area: hub.id, abaHref: null } : null;
}

export function abasDaArea(area: NavGroupId, isPlatformAdmin: boolean, role: Role | null, settings?: InterfaceSettings) {
  const visivel = new Set(destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href));
  const todas = NAV_DESTINATIONS.filter((d) => d.group === area && d.href !== "/app/inicio" && visivel.has(d.href));
  const marcadas = todas.filter((d) => d.sidebar);
  const principais = marcadas.slice(0, 5);
  return { principais, mais: todas.filter((d) => !principais.includes(d)) };
}

export function areasDoMenu(isPlatformAdmin: boolean, role: Role | null, settings?: InterfaceSettings): AreaDoMenu[] {
  const visivel = new Set(destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href));
  const areas: AreaDoMenu[] = [];
  if (visivel.has("/app/inicio")) areas.push({ id: "inicio", label: "Início", icon: ICONS.House, href: "/app/inicio" });
  for (const g of NAV_GROUPS) {
    const { principais, mais } = abasDaArea(g.id, isPlatformAdmin, role, settings);
    const primeira = principais[0] ?? mais[0];
    if (!primeira) continue;
    const href = g.id === GRUPO_NO_RODAPE && g.hub ? g.hub.href : primeira.href;
    areas.push({ id: g.id, label: g.label, icon: ICONE_DA_AREA[g.id], href });
  }
  return areas;
}

const ICONE_DA_AREA: Record<NavGroupId, PhosphorIcon> = {
  atendimento: ICONS.Inbox, crm: ICONS.Kanban, ia: ICONS.Robot, analise: ICONS.ChartLineUp, organizacao: ICONS.Buildings,
};
```
Catálogo: `{ id: "crm", label: "Vendas", hub: { href: "/app/crm", label: "Ver tudo em Vendas" } }` e `{ id: "ia", label: "IA", hub: … }` (aprovado assim pelo dono); remover a linha do grupo `canais`; mudar as 3 entradas para `group: "organizacao", section: "Canais"`; marcar `sidebar: true` nas telas listadas em **Files**. Dicionário: `"Vendas"`, `"Ver tudo em Vendas"`, `"IA"`, `"Mais"` e rótulos novos marcados.
- [ ] **Step 4: Rodar** — `pnpm vitest run tests/unit/menu-por-area.test.ts tests/unit/navegacao-registry.test.ts tests/unit/navegacao-completude.test.ts tests/unit/idioma-da-interface.test.ts tests/unit/painel-do-funil-navegacao.test.ts` → PASS (ajustar em `navegacao-registry.test.ts` só as afirmações sobre o grupo `canais`, explicando no commit).
- [ ] **Step 5: Commit** — `git commit -am "feat(menu): áreas e abas derivadas do catálogo; CRM vira Vendas, Canais entra em Configurações"`

### Task 5: Menu lateral com 6 áreas no visual do Financeiro

**Files:**
- Modify: `components/shell/Sidebar.tsx` (troca a lista de grupos pela lista de áreas; logo sem moldura; estilo do Financeiro; lembra a última aba de cada área)
- Modify: `components/shell/MobileSidebar.tsx` (usa o mesmo `SidebarContent`; só conferir que herda)
- Test: `tests/unit/sidebar-grupos.test.tsx` (reescrever para áreas), `tests/unit/sidebar-nome-da-organizacao.test.tsx` (manter passando)

**Interfaces:**
- Consumes: `areasDoMenu`, `areaDaRota` (Task 4); utilitários `bg-sidebar`, `text-sidebar-fg`, `text-sidebar-muted`, `bg-sidebar-active`, `text-gold`, `bg-gold` (Task 1).
- Produces: chave de `localStorage` `menu-ultima-aba` = `Record<AreaId, string>`; `AbasDaArea` (Task 6) grava nela.

- [ ] **Step 1: Teste que falha** (reescrever `tests/unit/sidebar-grupos.test.tsx` mantendo os mocks de `useAuth`/`usePathname` que o arquivo já usa)

```tsx
it("mostra só as áreas e marca a área da tela atual", () => {
  mockPathname("/app/contacts");
  render(<SidebarContent collapsed={false} />);
  const nav = screen.getByRole("navigation", { name: "Navegação principal" });
  expect(within(nav).getAllByRole("link").map((l) => l.textContent?.trim())).toEqual(["Início", "Atendimento", "Vendas", "IA", "Análise"]);
  expect(within(nav).getByRole("link", { name: "Vendas" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("link", { name: "Configurações" })).toBeInTheDocument();
});
it("área abre a última aba usada nela", () => {
  window.localStorage.setItem("menu-ultima-aba", JSON.stringify({ crm: "/app/tasks" }));
  mockPathname("/app/inicio");
  render(<SidebarContent collapsed={false} />);
  expect(screen.getByRole("link", { name: "Vendas" })).toHaveAttribute("href", "/app/tasks");
});
it("logo sem moldura branca", () => {
  render(<SidebarContent collapsed={false} />);
  expect(screen.getByRole("img").parentElement?.className ?? "").not.toMatch(/bg-white/);
});
```
- [ ] **Step 2: Rodar e ver falhar** — `pnpm vitest run tests/unit/sidebar-grupos.test.tsx`.
- [ ] **Step 3: Implementar** — em `SidebarContent`:

```tsx
const areas = areasDoMenu(user.is_platform_admin && !user.support, activeOrg?.role ?? null, activeOrg?.interface_settings);
const atual = areaDaRota(pathname)?.area ?? null;
const [ultimaAba, setUltimaAba] = useState<Record<string, string>>({});
useEffect(() => { try { setUltimaAba(JSON.parse(window.localStorage.getItem("menu-ultima-aba") ?? "{}")); } catch { /* sem storage: usa a primeira aba */ } }, [pathname]);
const doMeio = areas.filter((a) => a.id !== GRUPO_NO_RODAPE);
const rodape = areas.find((a) => a.id === GRUPO_NO_RODAPE);
// <aside className="... bg-sidebar text-sidebar-fg"> ; cada área:
<Link href={ultimaAba[a.id] ?? a.href} aria-current={atual === a.id ? "page" : undefined}
  className={cn("relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
    atual === a.id ? "bg-sidebar-active font-medium text-gold before:absolute before:left-0 before:top-1/2 before:h-5 before:w-1 before:-translate-y-1/2 before:rounded-r-full before:bg-gold" : "text-sidebar-fg hover:bg-sidebar-active",
    collapsed && "justify-center px-2")}>
  <a.icon size={20} weight={atual === a.id ? "fill" : "regular"} aria-hidden />
  {!collapsed && <span className="truncate">{t(a.label)}</span>}
</Link>
```
Rodapé: o mesmo link para `rodape` com rótulo `t("Configurações")` e ícone `Gear`. Logo: remover o `div` com `dark:bg-white…`, deixando só o `<img>`; abaixo do logo um filete `h-px bg-gradient-to-r from-transparent via-gold/70 to-transparent`. Remover `CHAVE_GRUPOS_FECHADOS`, `toggleGrupo` e os títulos de grupo (não há mais grupos no menu). Manter `toggleSidebar`, `VersionFooter` e o `ConnectionHealthDot` (passa a aparecer na área Configurações quando a tela Conexões tem `healthDot`).
- [ ] **Step 4: Rodar** — `pnpm vitest run tests/unit/sidebar-grupos.test.tsx tests/unit/sidebar-nome-da-organizacao.test.tsx` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(menu): barra lateral com 6 áreas no verde do Financeiro"`

### Task 6: Abas da área no topo

**Files:**
- Create: `components/shell/AbasDaArea.tsx`
- Modify: `app/app/_components/AppShell.tsx` (renderiza `<AbasDaArea />` entre `<TopBar />` e `<main>`)
- Test: `components/shell/AbasDaArea.test.tsx`

**Interfaces:**
- Consumes: `areaDaRota`, `abasDaArea` (Task 4); chave `menu-ultima-aba` (Task 5); utilitários `border-gold`, `bg-table-head` (Task 1).

- [ ] **Step 1: Teste que falha**

```tsx
// components/shell/AbasDaArea.test.tsx  (copiar os mocks de useAuth/usePathname de tests/unit/sidebar-grupos.test.tsx)
it("mostra as abas da área, marca a atual e explica a tela", () => {
  mockPathname("/app/contacts");
  render(<AbasDaArea />);
  const abas = screen.getByRole("navigation", { name: "Telas de Vendas" });
  expect(within(abas).getByRole("link", { name: "Contatos" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByText(/As pessoas do outro lado da conversa/)).toBeInTheDocument();
});
it("guarda a aba aberta para o menu lateral", () => {
  mockPathname("/app/tasks");
  render(<AbasDaArea />);
  expect(JSON.parse(window.localStorage.getItem("menu-ultima-aba")!)).toMatchObject({ crm: "/app/tasks" });
});
it("Início e rota sem área não mostram abas", () => {
  mockPathname("/app/inicio");
  const { container } = render(<AbasDaArea />);
  expect(container).toBeEmptyDOMElement();
});
it("telas além de 5 ficam no Mais", () => {
  mockPathname("/app/ai/agents");
  render(<AbasDaArea />);
  expect(screen.getByRole("button", { name: /Mais/ })).toBeInTheDocument();
});
```
- [ ] **Step 2: Rodar e ver falhar.**
- [ ] **Step 3: Implementar**

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { CaretDown } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { NAV_GROUPS, abasDaArea, areaDaRota } from "@/lib/navigation/registry";
import { cn } from "@/lib/utils";

const CHAVE = "menu-ultima-aba";

/** Abas da área da tela atual, logo abaixo da barra do topo. Nenhuma rota muda: tudo sai do catálogo. */
export function AbasDaArea() {
  const t = useT();
  const pathname = usePathname();
  const { user, activeOrg } = useAuth();
  const onde = areaDaRota(pathname);
  useEffect(() => {
    if (!onde || onde.area === "inicio" || !onde.abaHref) return;
    try {
      const salvo = JSON.parse(window.localStorage.getItem(CHAVE) ?? "{}");
      window.localStorage.setItem(CHAVE, JSON.stringify({ ...salvo, [onde.area]: onde.abaHref }));
    } catch { /* sem storage: o menu abre a primeira aba */ }
  }, [onde?.area, onde?.abaHref]);
  if (!onde || onde.area === "inicio") return null;
  const grupo = NAV_GROUPS.find((g) => g.id === onde.area)!;
  const { principais, mais } = abasDaArea(onde.area, user.is_platform_admin && !user.support, activeOrg?.role ?? null, activeOrg?.interface_settings);
  const atual = [...principais, ...mais].find((d) => d.href === onde.abaHref);
  const ativa = (href: string) => href === onde.abaHref;
  return (
    <div className="border-b bg-surface px-3 md:px-6">
      <nav aria-label={`${t("Telas de")} ${t(grupo.label)}`} className="-mb-px flex gap-1 overflow-x-auto">
        {principais.map((d) => (
          <Link key={d.href} href={d.href} aria-current={ativa(d.href) ? "page" : undefined}
            className={cn("whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors",
              ativa(d.href) ? "border-gold font-medium text-text" : "border-transparent text-text-muted hover:text-text")}>
            {t(d.label)}
          </Link>
        ))}
        {mais.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger className={cn("flex items-center gap-1 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm",
              mais.some((d) => ativa(d.href)) ? "border-gold font-medium text-text" : "border-transparent text-text-muted hover:text-text")}>
              {t("Mais")} <CaretDown size={12} aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {mais.map((d) => (
                <DropdownMenuItem key={d.href} asChild><Link href={d.href}>{t(d.label)}</Link></DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </nav>
      {atual && <p className="py-2 text-xs text-text-muted">{t(atual.description)}</p>}
    </div>
  );
}
```
Dicionário: `"Telas de": { es: "Pantallas de" }`, `"Mais": { es: "Más" }`.
- [ ] **Step 4: Rodar** — `pnpm vitest run components/shell/AbasDaArea.test.tsx` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(menu): abas da área no topo com a frase de cada tela"`

### Task 7: Specs e2e que dependiam do menu antigo

**Files:**
- Modify: `tests/e2e/navegacao.spec.ts`, `tests/e2e/interface-por-vinculo.spec.ts`, `tests/e2e/followup-builder.spec.ts`, `tests/e2e/marca-logo.spec.ts`, `tests/e2e/funil-arquivado-volta-pela-tela.spec.ts`, `tests/e2e/prova-painel-provedores.spec.ts`, `tests/e2e/logo-moldura-no-tema-escuro.spec.ts`, `tests/e2e/relatorio-por-etiqueta.spec.ts`, `tests/e2e/relatorio-de-atividades.spec.ts`, `tests/e2e/system-update.spec.ts`, `tests/e2e/webhooks.spec.ts`

- [ ] **Step 1:** Em cada spec, achar onde clica num link do menu lateral (`getByRole("link", { name: "Contatos" })` dentro da `navigation` "Navegação principal") e trocar para: clicar na área no menu lateral e depois na aba (`page.getByRole("navigation", { name: "Telas de Vendas" }).getByRole("link", { name: "Contatos" })`), ou navegar direto pela URL quando o teste não é sobre navegação.
- [ ] **Step 2:** `logo-moldura-no-tema-escuro.spec.ts`: a afirmação passa a ser "o logo aparece sem moldura branca sobre o menu verde nos dois temas" (o menu agora é sempre verde).
- [ ] **Step 3:** `navegacao.spec.ts`: manter a regra "menu cabe sem rolar em 1280×900" e acrescentar "as abas não estouram a largura em 390×844 (`body.scrollWidth <= clientWidth`)".
- [ ] **Step 4:** Rodar localmente as specs alteradas: `pnpm test:e2e tests/e2e/navegacao.spec.ts tests/e2e/webhooks.spec.ts` (precisa do ambiente da receita do CLAUDE.md: Supabase local pg15 + `next build && next start`). Se o ambiente local não subir, registrar isso no PR e deixar o job `e2e` do CI como prova.
- [ ] **Step 5: Commit** — `git commit -am "test(e2e): navegação pelas áreas e abas"`

### Task 8: Prova pela tela e PR

- [ ] **Step 1:** `pnpm typecheck && pnpm lint`; `pnpm test:unit > /tmp/vt.log 2>&1; echo "exit=$?"` e conferir `Test Files`, `Tests` e `Errors` como manda o CLAUDE.md.
- [ ] **Step 2:** `pnpm build && pnpm start` com banco local; com Playwright, capturar Início, Inbox, Contatos (Vendas), Agentes (IA com "Mais"), Configurações › Marca, nos temas claro e escuro, em 1280×900 e 390×844, salvando em `.superpowers/evidence/cores-e-menu/`.
- [ ] **Step 3:** Mandar as capturas ao dono e esperar o ok.
- [ ] **Step 4:** Fragmento `.changes/cores-e-menu.md` com efeito `nada_mudou` para o operador (só visual) e `git push -u origin feat/cores-e-menu`; `gh pr create` com o resumo e a lista de specs e2e ajustadas.
- [ ] **Step 5:** Mandar o número do PR ao Graphify (ele libera e publica). Não fazer merge nem deploy.
