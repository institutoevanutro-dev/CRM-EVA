import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { type Role } from "@/lib/auth/types";
import {
  Bell,
  BookOpen,
  Brain,
  Buildings,
  CalendarBlank,
  ChartBar,
  ChartLineUp,
  ClipboardText,
  ClockCountdown,
  ClockCounterClockwise,
  FileText,
  Flag,
  FlowArrow,
  Funnel,
  Gauge,
  House,
  Inbox,
  Kanban,
  Key,
  Lightbulb,
  ListChecks,
  Lock,
  Megaphone,
  Palette,
  Plugs,
  PlugsConnected,
  PuzzlePiece,
  Receipt,
  Robot,
  ScalesSimple,
  ShieldCheck,
  Signpost,
  Storefront,
  Tag,
  UserCircle,
  Users,
  UsersThree,
  WebhooksLogo,
} from "@/lib/ui/icons";

import {
  GRUPO_NO_RODAPE,
  NAV_CATALOG,
  NAV_GROUPS,
  type NavMetadata,
  type NavGroup,
  type NavGroupId,
} from "./catalogo";
import { destinosDaInterface, type InterfaceSettings } from "./interface";
export { NAV_GROUPS, GRUPO_NO_RODAPE } from "./catalogo";
export type { NavGroup, NavGroupId } from "./catalogo";
const ICONS = {
  Bell,
  BookOpen,
  Brain,
  Buildings,
  CalendarBlank,
  ChartBar,
  ChartLineUp,
  ClipboardText,
  ClockCountdown,
  ClockCounterClockwise,
  FileText,
  Flag,
  FlowArrow,
  Funnel,
  Gauge,
  House,
  Inbox,
  Kanban,
  Key,
  Lightbulb,
  ListChecks,
  Lock,
  Megaphone,
  Palette,
  Plugs,
  PlugsConnected,
  PuzzlePiece,
  Receipt,
  Robot,
  ScalesSimple,
  ShieldCheck,
  Signpost,
  Storefront,
  Tag,
  UserCircle,
  Users,
  UsersThree,
  WebhooksLogo,
};
export interface NavDestination extends Omit<NavMetadata, "icon"> {
  icon: PhosphorIcon;
}
export const NAV_DESTINATIONS: NavDestination[] = NAV_CATALOG.map((d) => ({
  ...d,
  icon: ICONS[d.icon],
}));
/**
 * Único ponto de decisão de permissão da navegação.
 *
 * É o que dispensa os sete `usePermission()` que o Sidebar chamava em sequência
 * — hooks não rodam em laço condicional, então cada permissão exigia sua linha.
 * Como função pura, um `.filter()` resolve todas.
 */
export { canSee } from "./interface";

/** Projeção do sidebar: só o uso diário, agrupado, sem grupo vazio. */
export function sidebarGroups(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
): Array<{ group: NavGroup; items: NavDestination[] }> {
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href),
  );
  return NAV_GROUPS.map((group) => ({
    group,
    items: NAV_DESTINATIONS.filter(
      (d) => d.group === group.id && (d.sidebar || (!group.hub && !!settings?.destinos)) && visible.has(d.href),
    ),
  })).filter(
    (g) =>
      g.items.length > 0 ||
      (g.group.hub && NAV_DESTINATIONS.some((d) => d.group === g.group.id && visible.has(d.href))),
  );
}

/**
 * Projeção do hub: TODAS as telas do grupo — inclusive as que já estão no
 * sidebar. O hub é inventário, não sobra; é onde se descobre o que existe.
 *
 * A ordem das seções é a de primeira aparição no registro, então reordenar a
 * jornada é reordenar o array — não há uma segunda lista para manter em sincronia.
 */
export function hubSections(
  group: NavGroupId,
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
): Array<{ section: string; items: NavDestination[] }> {
  const porSecao = new Map<string, NavDestination[]>();
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href),
  );
  for (const d of NAV_DESTINATIONS) {
    if (d.group !== group || !visible.has(d.href)) continue;
    const secao = d.section ?? "";
    const atual = porSecao.get(secao);
    if (atual) atual.push(d);
    else porSecao.set(secao, [d]);
  }
  return [...porSecao.entries()].map(([section, items]) => ({ section, items }));
}

/** Projeção do ⌘K: todo destino visível, do sidebar ou não. */
export function searchable(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
): NavDestination[] {
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href),
  );
  return NAV_DESTINATIONS.filter((d) => visible.has(d.href));
}

/* ── Menu por área (spec docs/superpowers/specs/2026-10-07-cores-e-menu-design.md) ──
 * O menu lateral mostra ÁREAS (Início + um item por grupo) e cada área mostra suas telas
 * como abas no topo (`components/shell/AbasDaArea.tsx`). `sidebar: true` no catálogo passa
 * a significar "aba principal"; as demais telas do grupo vão para o "Mais". */

export type AreaId = "inicio" | NavGroupId;
export interface AreaDoMenu {
  id: AreaId;
  label: string;
  icon: PhosphorIcon;
  /** Primeira aba visível da área (Configurações abre o próprio hub). */
  href: string;
}

const MAX_ABAS_PRINCIPAIS = 5;

// Telas que não estão no catálogo mas pertencem a uma área.
// ponytail: mapa à mão; vira campo do catálogo se passar de meia dúzia.
const ROTAS_FILHAS: Array<{ prefixo: string; area: NavGroupId; abaHref: string | null }> = [
  { prefixo: "/app/pipelines/", area: "crm", abaHref: "/app/kanban" },
  { prefixo: "/app/leads/", area: "crm", abaHref: null },
];

const ICONE_DA_AREA: Record<NavGroupId, PhosphorIcon> = {
  atendimento: ICONS.Inbox,
  crm: ICONS.Kanban,
  ia: ICONS.Robot,
  analise: ICONS.ChartLineUp,
  organizacao: ICONS.Buildings,
};

/** Em que área (e em que aba) está a rota. `null` = rota fora do menu. */
export function areaDaRota(pathname: string): { area: AreaId; abaHref: string | null } | null {
  if (pathname === "/app/inicio") return { area: "inicio", abaHref: null };
  const filha = ROTAS_FILHAS.find((r) => pathname.startsWith(r.prefixo));
  if (filha) return { area: filha.area, abaHref: filha.abaHref };
  let melhor: NavDestination | undefined;
  for (const d of NAV_DESTINATIONS) {
    if (d.href === "/app/inicio") continue;
    const casa = pathname === d.href || pathname.startsWith(d.href + "/");
    if (casa && (!melhor || d.href.length > melhor.href.length)) melhor = d;
  }
  if (melhor) return { area: melhor.group, abaHref: melhor.href };
  const hub = NAV_GROUPS.find((g) => g.hub && pathname === g.hub.href);
  if (hub) return { area: hub.id, abaHref: null };
  // Telas de configuração sem entrada no catálogo (canal oficial, atualização,
  // modelos). Depois do catálogo de propósito: /app/settings/tenant/pipelines é Vendas.
  if (pathname === "/app/settings/canal-oficial") return { area: "organizacao", abaHref: "/app/connections" };
  if (pathname.startsWith("/app/settings/")) return { area: "organizacao", abaHref: null };
  return null;
}

/** Abas da área: até 5 principais (`sidebar: true`), o resto no "Mais". Só o que o papel vê. */
export function abasDaArea(
  area: NavGroupId,
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
): { principais: NavDestination[]; mais: NavDestination[] } {
  const visivel = new Set(destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href));
  const todas = NAV_DESTINATIONS.filter(
    (d) => d.group === area && d.href !== "/app/inicio" && visivel.has(d.href),
  );
  const marcadas = todas.filter((d) => d.sidebar);
  // Papel que não vê nenhuma aba principal (ex.: agent na IA) recebe as primeiras telas
  // que vê como abas, em vez de uma barra só com "Mais".
  const principais = (marcadas.length ? marcadas : todas).slice(0, MAX_ABAS_PRINCIPAIS);
  return { principais, mais: todas.filter((d) => !principais.includes(d)) };
}

/** As áreas do menu lateral, na ordem dos grupos; área sem tela visível não aparece. */
export function areasDoMenu(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
): AreaDoMenu[] {
  const visivel = new Set(destinosDaInterface(settings, isPlatformAdmin, role).map((d) => d.href));
  const areas: AreaDoMenu[] = [];
  if (visivel.has("/app/inicio")) {
    areas.push({ id: "inicio", label: "Início", icon: ICONS.House, href: "/app/inicio" });
  }
  for (const g of NAV_GROUPS) {
    const { principais, mais } = abasDaArea(g.id, isPlatformAdmin, role, settings);
    const primeira = principais[0] ?? mais[0];
    if (!primeira) continue;
    const href = g.id === GRUPO_NO_RODAPE && g.hub ? g.hub.href : primeira.href;
    areas.push({ id: g.id, label: g.label, icon: ICONE_DA_AREA[g.id], href });
  }
  return areas;
}
