"use client";
import Link from "next/link";
import { useT } from "@/hooks/i18n/useT";
import { usePathname } from "next/navigation";
import { useTransition } from "react";
import { CaretDoubleLeft, CaretDoubleRight, Gear } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { VersionFooter } from "@/components/shell/VersionFooter";
import { LogotipoDoProduto, SimboloDoProduto } from "@/components/branding/MarcaDoProduto";
import { marcaEhADoProduto } from "@/lib/branding";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import {
  GRUPO_NO_RODAPE,
  NAV_DESTINATIONS,
  abasDaArea,
  areaDaRota,
  areasDoMenu,
} from "@/lib/navigation/registry";
import { useUltimaAba } from "@/lib/navigation/ultima-aba";


interface SidebarContentProps {
  collapsed: boolean;
  showCollapseControl?: boolean;
  onNavigate?: () => void;
}

/**
 * Navegação principal, agrupada por objetivo.
 *
 * Não decide nada: `sidebarGroups()` (lib/navigation/registry.ts) resolve quais
 * grupos e destinos este papel vê, e este componente desenha. Antes, a lista de
 * itens e sete `usePermission()` viviam aqui — e divergiam do hub de
 * Configurações e das abas de IA, que mantinham suas próprias listas.
 */
const ROTULO_DO_RODAPE = "Configurações";

export function SidebarContent({
  collapsed,
  showCollapseControl = true,
  onNavigate,
}: SidebarContentProps) {
  const t = useT();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const { user, activeOrg } = useAuth();
  // Menu por ÁREA (spec 2026-10-07-cores-e-menu): as telas de cada área viram abas no
  // topo (`AbasDaArea`). Com 6 linhas, a régua de 900px do navegacao.spec.ts sobra.
  const quem = [
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
  ] as const;
  const areas = areasDoMenu(...quem);
  const atual = areaDaRota(pathname)?.area ?? null;
  const doMeio = areas.filter((a) => a.id !== GRUPO_NO_RODAPE);
  // No rodapé a área Organização aparece como "Configurações", o nome que todo mundo procura.
  const organizacao = areas.find((a) => a.id === GRUPO_NO_RODAPE);
  const rodape = organizacao && { ...organizacao, label: ROTULO_DO_RODAPE };

  // A área abre na última aba usada nela (gravada por `AbasDaArea`).
  const ultimaAba = useUltimaAba();

  const brand = useMarcaDaInstalacao();
  const nome = activeOrg?.marca?.nome ?? brand.name;
  const logo = activeOrg?.marca?.logoUrl || brand.logoUrl;
  const marcaDoProduto = marcaEhADoProduto({ name: nome, logoUrl: logo ?? null });

  // `item` = a área; o rótulo do rodapé é o de Configurações, não o do grupo ("Organização").
  const linkDaArea = (item: (typeof areas)[number], Icone: typeof item.icon) => {
    const ativa = atual === item.id;
    // Só o que este papel vê AGORA: a aba guardada pode ser de outra empresa, de outro
    // usuário na mesma máquina, ou de uma tela que a interface passou a esconder.
    const vistas =
      item.id === "inicio"
        ? []
        : (({ principais, mais }) => [...principais, ...mais])(abasDaArea(item.id, ...quem)).map((d) => d.href);
    const guardada = ultimaAba[item.id];
    const destino = guardada && vistas.includes(guardada) ? guardada : item.href;
    // O aviso de conexão caída só para quem pode abrir Conexões e agir.
    const temSaude = NAV_DESTINATIONS.some(
      (d) => d.group === item.id && d.healthDot && vistas.includes(d.href),
    );
    return (
      <Link
        key={item.id}
        href={destino}
        title={collapsed ? t(item.label) : undefined}
        aria-current={ativa ? "page" : undefined}
        onClick={onNavigate}
        className={cn(
          "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
          ativa
            ? "bg-sidebar-active font-medium text-gold before:absolute before:top-1/2 before:left-0 before:h-5 before:w-1 before:-translate-y-1/2 before:rounded-r-full before:bg-gold"
            : "text-sidebar-fg hover:bg-sidebar-active",
          collapsed && "justify-center px-2",
        )}
      >
        <Icone size={20} weight={ativa ? "fill" : "regular"} aria-hidden />
        {!collapsed && <span className="truncate">{t(item.label)}</span>}
        {temSaude && (
          <ConnectionHealthDot className={cn(collapsed ? "absolute top-1.5 right-1.5" : "ml-auto")} />
        )}
      </Link>
    );
  };

  return (
    <>
      <div className={cn("flex h-14 items-center px-4", collapsed ? "justify-center" : "justify-start")}>
        {logo && !collapsed ? (
          // Sem moldura: o menu é verde nos dois temas, então o logo aparece direto
          // sobre ele (a moldura branca existia para o menu escuro de antes).
          // <img> e não next/image: a URL vem de quem hospeda (banco ou .env).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt={nome} className="h-8 w-auto max-w-[10rem] object-contain" />
        ) : marcaDoProduto ? (
          collapsed ? (
            <SimboloDoProduto nome={nome} className="h-8 w-8" />
          ) : (
            <LogotipoDoProduto nome={nome} className="h-8 w-auto" />
          )
        ) : (
          <span className={cn("font-semibold tracking-tight", collapsed && "sr-only")}>{nome}</span>
        )}
        {collapsed && !marcaDoProduto && (
          <span aria-hidden className="text-lg font-bold text-gold">
            {[...nome][0]?.toUpperCase() ?? brand.initial}
          </span>
        )}
      </div>
      <div aria-hidden className="mx-4 mb-2 h-px bg-gradient-to-r from-transparent via-gold/70 to-transparent" />
      <nav className="flex-1 space-y-1 overflow-y-auto p-2" aria-label={t("Navegação principal")}>
        {doMeio.map((a) => linkDaArea(a, a.icon))}
      </nav>
      <div className="border-t border-white/10 p-2">
        {rodape && <div className="mb-1">{linkDaArea(rodape, Gear)}</div>}
        <VersionFooter collapsed={collapsed} onNavigate={onNavigate} />
        {showCollapseControl && (
          <button
            type="button"
            onClick={() => startTransition(() => toggleSidebar(collapsed))}
            disabled={isPending}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-sidebar-muted hover:bg-sidebar-active hover:text-sidebar-fg",
              collapsed && "justify-center px-2",
            )}
            aria-label={collapsed ? t("Expandir sidebar") : t("Recolher sidebar")}
          >
            {collapsed ? <CaretDoubleRight size={14} aria-hidden /> : <CaretDoubleLeft size={14} aria-hidden />}
            {!collapsed && <span>{t("Recolher")}</span>}
          </button>
        )}
      </div>
    </>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <aside
      className={cn(
        "sticky top-0 z-30 flex h-screen shrink-0 flex-col bg-sidebar text-sidebar-fg shadow-[inset_-1px_0_0_rgba(255,255,255,0.06)] transition-[width] duration-200",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <SidebarContent collapsed={collapsed} />
    </aside>
  );
}
