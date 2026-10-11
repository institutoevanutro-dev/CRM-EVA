import type { Role } from "@/lib/auth/types";

import type { InterfaceSettings } from "./interface";
import { NAV_DESTINATIONS, areaDaRota, searchable, type NavDestination, type NavGroupId } from "./registry";

/**
 * O menu lateral agrupado pelo que a pessoa veio FAZER (pedido do dono, 11/10/2026):
 * "algumas abas têm muita coisa, as outras têm pouca". O catálogo agrupa por área do
 * sistema (IA tinha 15 telas, Configurações 17, Atendimento 4); aqui nenhum grupo passa
 * de 9, e por isso cada grupo mostra TODAS as suas telas, sem "Ver tudo".
 *
 * É uma camada só do menu: `lib/navigation/catalogo.ts` (grupo, hub, seção, papel) não
 * muda, porque é dele que saem as permissões, a busca e as páginas de área, e porque é o
 * arquivo que recebe os portes do produto de origem. Tela nova no catálogo PRECISA entrar
 * aqui, em `MINHA_CONTA` ou em `FORA_DO_MENU`: `tests/unit/menu-por-tarefa.test.ts` reprova
 * a que ficar de fora.
 */
export const MENU: ReadonlyArray<{ id: string; label: string; hrefs: readonly string[] }> = [
  {
    id: "atendimento",
    label: "Atendimento",
    // Alertas, Casos e Propostas vêm da IA, mas são trabalho do dia: alguém precisa decidir.
    hrefs: ["/app/inbox", "/app/radar", "/app/agenda", "/app/templates", "/app/ai/inbox", "/app/ai/cases", "/app/ai/proposals"],
  },
  { id: "vendas", label: "Vendas", hrefs: ["/app/kanban", "/app/contacts", "/app/tasks", "/app/campaigns"] },
  {
    id: "assistente",
    label: "Assistente",
    hrefs: [
      "/app/ai/agents",
      "/app/ai/routers",
      "/app/ai/followups",
      "/app/ai/knowledge/sources",
      "/app/ai/perguntas-frequentes",
      "/app/ai/midias",
      "/app/ai/memory",
      "/app/ai/skills",
    ],
  },
  {
    id: "analise",
    label: "Análise",
    hrefs: [
      "/app/metrics",
      "/app/ads/meta",
      "/app/painel-do-funil",
      "/app/activities",
      "/app/tag-report",
      "/app/ai/evolution",
      "/app/audit",
      "/app/ai/runs",
      "/app/ai/usage",
    ],
  },
  {
    id: "clinica",
    label: "Clínica",
    // As regras do negócio. Produtos mora aqui: o preço vem do PrecificaEva, não se vende por esta tela.
    hrefs: [
      "/app/team",
      "/app/settings/atendimento",
      "/app/settings/tags",
      "/app/settings/tenant/agenda",
      "/app/settings/tenant/pipelines",
      "/app/settings/marca",
      "/app/settings/tenant",
      "/app/products",
      "/app/lgpd/requests",
    ],
  },
  {
    id: "integracoes",
    label: "Integrações",
    hrefs: [
      "/app/connections",
      "/app/settings/api-tokens",
      "/app/webhooks",
      "/app/settings/meta-ads",
      "/app/settings/conversoes",
      "/app/ai/credentials",
      "/app/ai/providers",
    ],
  },
];

/** Abrem pelo cartão de quem está logado, no rodapé do menu. */
export const MINHA_CONTA: readonly string[] = ["/app/settings/profile", "/app/settings/security", "/app/settings/notifications"];

/**
 * Telas do produto de origem que a clínica não usa. Saem só do MENU: a rota, a busca (⌘K) e a
 * página de Configurações continuam, para o código não divergir do produto de origem.
 */
export const FORA_DO_MENU: readonly string[] = ["/app/integrations/nuvemshop", "/app/settings/billing"];

// Tela fora do catálogo (detalhe de lead, configuração sem entrada): cai no grupo da área antiga.
const DA_AREA: Record<NavGroupId, string> = { atendimento: "atendimento", crm: "vendas", ia: "assistente", analise: "analise", organizacao: "clinica" };

export interface GrupoDoMenu {
  id: string;
  label: string;
  icon: NavDestination["icon"];
  itens: NavDestination[];
}

const porHref = new Map(NAV_DESTINATIONS.map((d) => [d.href, d]));

/** Os grupos do menu na ordem de uso, só com o que este papel vê; grupo vazio não aparece. */
export function gruposDoMenu(isPlatformAdmin: boolean, role: Role | null, settings?: InterfaceSettings): GrupoDoMenu[] {
  const visivel = new Set(searchable(isPlatformAdmin, role, settings).map((d) => d.href));
  return MENU.flatMap((g) => {
    const itens = g.hrefs.filter((h) => visivel.has(h)).map((h) => porHref.get(h)!);
    // O ícone do grupo (menu recolhido) é o da primeira tela DELE, visível ou não: não muda com o papel.
    return itens.length ? [{ id: g.id, label: g.label, icon: porHref.get(g.hrefs[0]!)!.icon, itens }] : [];
  });
}

/** O "Início" só aparece para quem o vê (a interface do vínculo pode escondê-lo). */
export function veInicio(isPlatformAdmin: boolean, role: Role | null, settings?: InterfaceSettings): boolean {
  return searchable(isPlatformAdmin, role, settings).some((d) => d.href === "/app/inicio");
}

/** As telas de "Minha conta" que este papel vê. */
export function telasDaConta(isPlatformAdmin: boolean, role: Role | null, settings?: InterfaceSettings): NavDestination[] {
  const visivel = new Set(searchable(isPlatformAdmin, role, settings).map((d) => d.href));
  return MINHA_CONTA.filter((h) => visivel.has(h)).map((h) => porHref.get(h)!);
}

/** Em que grupo do menu (e em que tela) está a rota. `inicio` é o item solto do topo. */
export function ondeNoMenu(pathname: string): { grupo: string | null; href: string | null } {
  const onde = areaDaRota(pathname);
  if (!onde) return { grupo: null, href: null };
  if (onde.area === "inicio") return { grupo: "inicio", href: "/app/inicio" };
  const href = onde.abaHref;
  if (href && (MINHA_CONTA.includes(href) || FORA_DO_MENU.includes(href))) return { grupo: null, href };
  const grupo = (href && MENU.find((g) => g.hrefs.includes(href))?.id) || DA_AREA[onde.area];
  return { grupo, href };
}
