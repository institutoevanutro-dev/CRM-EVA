"use client";
import Link from "next/link";
import { useT } from "@/hooks/i18n/useT";
import { usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import { CaretDown, CaretDoubleLeft, CaretDoubleRight, Gear, SignOut } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { SearchTrigger } from "@/components/shell/SearchTrigger";
import { VersionFooter } from "@/components/shell/VersionFooter";
import { LogotipoDoProduto, SimboloDoProduto } from "@/components/branding/MarcaDoProduto";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { marcaEhADoProduto } from "@/lib/branding";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import {
  GRUPO_NO_RODAPE,
  NAV_DESTINATIONS,
  NAV_GROUPS,
  abasDaArea,
  areaDaRota,
  areasDoMenu,
} from "@/lib/navigation/registry";


interface SidebarContentProps {
  collapsed: boolean;
  showCollapseControl?: boolean;
  onNavigate?: () => void;
}

/**
 * Navegação principal no desenho do PrecificaEva e do Eva Financeiro (pedido do dono,
 * 10/10/2026): cada área é um grupo que abre e fecha mostrando as suas telas, a busca de
 * telas e a pessoa logada moram aqui, e o botão de recolher fica no topo.
 *
 * Não decide nada: `areasDoMenu()` e `abasDaArea()` (lib/navigation/registry.ts) resolvem
 * o que este papel vê, e este componente desenha.
 */
const ROTULO_DO_RODAPE = "Configurações";

function iniciais(nome: string | null | undefined, email: string | undefined): string {
  const partes = (nome ?? "").trim().split(/\s+/).filter(Boolean);
  if (partes.length) return partes.slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  return (email ?? "").slice(0, 2).toUpperCase();
}

export function SidebarContent({
  collapsed,
  showCollapseControl = true,
  onNavigate,
}: SidebarContentProps) {
  const t = useT();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [saindo, sair] = useTransition();
  const { user, activeOrg, signOut } = useAuth();
  const quem = [
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
  ] as const;
  // No menu a área Organização aparece como "Configurações", o nome que todo mundo procura.
  const areas = areasDoMenu(...quem).map((a) =>
    a.id === GRUPO_NO_RODAPE ? { ...a, label: ROTULO_DO_RODAPE, icon: Gear } : a,
  );
  const onde = areaDaRota(pathname);
  const atual = onde?.area ?? null;
  const abaAtual = onde?.abaHref ?? null;
  // Aberto = o que a pessoa escolheu; sem escolha, só o grupo da tela atual.
  const [escolha, setEscolha] = useState<Record<string, boolean>>({});
  const aberto = (id: string) => escolha[id] ?? atual === id;
  const alternar = (id: string) => setEscolha((e) => ({ ...e, [id]: !aberto(id) }));

  const papeis: Record<string, string> = { admin: t("Administrador"), manager: t("Gestor"), agent: t("Atendente"), viewer: t("Leitura") };
  const papel = papeis[activeOrg?.role ?? ""];

  const brand = useMarcaDaInstalacao();
  const nome = activeOrg?.marca?.nome ?? brand.name;
  const logo = activeOrg?.marca?.logoUrl || brand.logoUrl;
  const marcaDoProduto = marcaEhADoProduto({ name: nome, logoUrl: logo ?? null });

  const estiloDoItem = (ativo: boolean) =>
    cn(
      "relative flex items-center gap-3 rounded-lg px-3 py-2 text-[15px] transition-colors",
      ativo
        ? "bg-sidebar-active font-medium text-gold before:absolute before:top-1/2 before:left-0 before:h-6 before:w-[3px] before:-translate-y-1/2 before:rounded-r-full before:bg-gold"
        : "text-sidebar-fg hover:bg-sidebar-active",
    );

  const grupo = (item: (typeof areas)[number]) => {
    const Icone = item.icon;
    const ativa = atual === item.id;
    if (item.id === "inicio") {
      return (
        <Link
          key={item.id}
          href={item.href}
          title={collapsed ? t(item.label) : undefined}
          aria-current={ativa ? "page" : undefined}
          onClick={onNavigate}
          className={cn(estiloDoItem(ativa), "py-2.5", collapsed && "justify-center px-2")}
        >
          <Icone size={20} weight={ativa ? "fill" : "light"} aria-hidden />
          {!collapsed && <span className="truncate">{t(item.label)}</span>}
        </Link>
      );
    }
    const { principais, mais } = abasDaArea(item.id, ...quem);
    const vistas = [...principais, ...mais].map((d) => d.href);
    // O aviso de conexão caída só para quem pode abrir Conexões e agir.
    const temSaude = NAV_DESTINATIONS.some((d) => d.group === item.id && d.healthDot && vistas.includes(d.href));
    const hub = NAV_GROUPS.find((g) => g.id === item.id)?.hub;
    const expandido = !collapsed && aberto(item.id);
    // O nome do grupo de origem ("Organização") continua no rótulo das telas: é por ele
    // que leitor de tela e testes acham a lista.
    const rotuloDasTelas = `${t("Telas de")} ${t(NAV_GROUPS.find((g) => g.id === item.id)?.label ?? item.label)}`;
    return (
      <div key={item.id}>
        <div className="flex items-center">
          {/* O nome leva à área (e ela abre); na área em que a pessoa já está, abre e fecha. */}
          <Link
            href={item.href}
            title={collapsed ? t(item.label) : undefined}
            aria-current={ativa ? "page" : undefined}
            onClick={(e) => {
              if (ativa && !collapsed) {
                e.preventDefault();
                alternar(item.id);
              } else onNavigate?.();
            }}
            className={cn(
              "relative flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-sidebar-active",
              collapsed
                ? cn("justify-center px-2", ativa ? "bg-sidebar-active text-gold" : "text-sidebar-fg")
                : "text-xs font-semibold tracking-[0.18em] text-gold uppercase",
            )}
          >
            {collapsed && <Icone size={20} weight={ativa ? "fill" : "light"} aria-hidden />}
            {!collapsed && <span className="truncate">{t(item.label)}</span>}
            {temSaude && <ConnectionHealthDot className={cn(collapsed ? "absolute top-1.5 right-1.5" : "ml-1")} />}
          </Link>
          {!collapsed && (
            <button
              type="button"
              onClick={() => alternar(item.id)}
              aria-expanded={expandido}
              aria-label={`${expandido ? t("Fechar") : t("Abrir")} ${t(item.label)}`}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gold hover:bg-sidebar-active"
            >
              <CaretDown size={14} aria-hidden className={cn("transition-transform", expandido && "rotate-180")} />
            </button>
          )}
        </div>
        {expandido && (
          <nav aria-label={rotuloDasTelas} className="mt-0.5 mb-2 space-y-0.5">
            {principais.map((d) => {
              const Ic = d.icon;
              const ligada = d.href === abaAtual;
              return (
                <Link key={d.href} href={d.href} aria-current={ligada ? "page" : undefined} onClick={onNavigate} className={estiloDoItem(ligada)}>
                  <Ic size={18} weight={ligada ? "fill" : "light"} aria-hidden />
                  <span className="truncate">{t(d.label)}</span>
                </Link>
              );
            })}
            {mais.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger className={cn(estiloDoItem(mais.some((d) => d.href === abaAtual)), "w-full text-sidebar-muted")}>
                  <span className="pl-[30px]">{t("Mais")}</span>
                  <CaretDown size={12} aria-hidden className="-rotate-90" />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start">
                  {mais.map((d) => (
                    <DropdownMenuItem key={d.href} asChild>
                      <Link href={d.href} aria-current={d.href === abaAtual ? "page" : undefined} onClick={onNavigate}>
                        {t(d.label)}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {hub && item.id !== GRUPO_NO_RODAPE && (
              // A página com todas as telas da área, organizadas por jornada.
              <Link
                href={hub.href}
                aria-current={pathname === hub.href ? "page" : undefined}
                onClick={onNavigate}
                className={cn(estiloDoItem(pathname === hub.href), "text-sm text-sidebar-muted")}
              >
                <span className="pl-[30px]">{t("Ver tudo")}</span>
              </Link>
            )}
          </nav>
        )}
      </div>
    );
  };

  const recolher = showCollapseControl && (
    <button
      type="button"
      onClick={() => startTransition(() => toggleSidebar(collapsed))}
      disabled={isPending}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gold hover:bg-sidebar-active"
      aria-label={collapsed ? t("Expandir sidebar") : t("Recolher sidebar")}
      title={collapsed ? t("Expandir sidebar") : t("Recolher sidebar")}
    >
      {collapsed ? <CaretDoubleRight size={16} aria-hidden /> : <CaretDoubleLeft size={16} aria-hidden />}
    </button>
  );

  return (
    <>
      <div className={cn("flex min-h-[4.5rem] items-center gap-2 px-4 py-3", collapsed ? "flex-col justify-center px-2" : "justify-between")}>
        <div className="flex min-w-0 items-center">
        {logo && !collapsed ? (
          // Sem moldura: o menu é verde nos dois temas, então o logo aparece direto
          // sobre ele (a moldura branca existia para o menu escuro de antes).
          // <img> e não next/image: a URL vem de quem hospeda (banco ou .env).
          // eslint-disable-next-line @next/next/no-img-element
          <span className="flex min-w-0 items-center gap-2.5">
            <img src={logo} alt={nome} className="h-9 w-auto max-w-[9rem] shrink-0 object-contain" />
            {/* O nome ao lado do logo só quando a ORGANIZAÇÃO definiu nome próprio: o
                logo da instalação costuma já trazer o nome escrito, e repetido ocuparia
                a faixa duas vezes. Na serifa do site da clínica. */}
            {activeOrg?.marca?.nome ? (
              <span aria-hidden className="flex min-w-0 flex-col">
                <span className="truncate font-titulo text-xl font-semibold leading-none text-sidebar-fg">{nome}</span>
                <span className="mt-1 text-[10px] font-medium tracking-[0.3em] text-gold uppercase">{t("CRM")}</span>
              </span>
            ) : null}
          </span>
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
        {recolher}
      </div>
      <div aria-hidden className="mx-4 mb-2 h-px bg-gradient-to-r from-transparent via-gold/70 to-transparent" />
      <div className={cn("px-3 pb-2", collapsed && "px-2")}>
        <SearchTrigger naLateral recolhida={collapsed} atalho={showCollapseControl} />
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-2" aria-label={t("Navegação principal")}>
        {areas.map(grupo)}
      </nav>
      <div className="border-t border-white/10 p-2">
        <div className={cn("flex items-center gap-3 rounded-lg bg-sidebar-active px-3 py-2", collapsed && "justify-center px-0")}>
          <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-gold/50 text-xs font-semibold text-gold">
            {iniciais(user.full_name, user.email)}
          </span>
          {!collapsed && (
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-sidebar-fg">{user.full_name ?? user.email}</span>
              {papel && <span className="truncate text-xs text-gold">{papel}</span>}
            </span>
          )}
        </div>
        <button
          type="button"
          disabled={saindo}
          onClick={() => sair(async () => { await signOut(); })}
          title={collapsed ? t("Sair") : undefined}
          aria-label={collapsed ? t("Sair") : undefined}
          className={cn("mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-fg hover:bg-sidebar-active", collapsed && "justify-center px-2")}
        >
          <SignOut size={18} aria-hidden />
          {!collapsed && <span>{t("Sair")}</span>}
        </button>
        <VersionFooter collapsed={collapsed} onNavigate={onNavigate} />
      </div>
    </>
  );
}

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <aside
      className={cn(
        "fundo-lateral sticky top-0 z-30 flex h-screen shrink-0 flex-col text-sidebar-fg shadow-[inset_-1px_0_0_rgba(255,255,255,0.06)] transition-[width] duration-200",
        collapsed ? "w-16" : "w-64",
      )}
    >
      <SidebarContent collapsed={collapsed} />
    </aside>
  );
}
