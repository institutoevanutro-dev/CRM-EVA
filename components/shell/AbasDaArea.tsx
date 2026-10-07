"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef } from "react";
import { CaretDown } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";
import { useAuth } from "@/hooks/auth/AuthProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NAV_GROUPS, abasDaArea, areaDaRota } from "@/lib/navigation/registry";
import { gravarUltimaAba } from "@/lib/navigation/ultima-aba";
import { cn } from "@/lib/utils";

/**
 * Abas da área da tela atual, logo abaixo da barra do topo (spec
 * docs/superpowers/specs/2026-10-07-cores-e-menu-design.md). O menu lateral mostra só as
 * áreas; aqui o colaborador vê as telas daquela área e, embaixo, a frase do que a tela
 * atual faz (o `description` do catálogo). Nenhuma rota muda: tudo sai do catálogo.
 */
export function AbasDaArea() {
  const t = useT();
  const pathname = usePathname();
  const { user, activeOrg } = useAuth();
  const onde = areaDaRota(pathname);
  const area = onde && onde.area !== "inicio" ? onde.area : null;
  const abaHref = onde?.abaHref ?? null;

  useEffect(() => {
    if (area && abaHref) gravarUltimaAba(area, abaHref);
  }, [area, abaHref]);

  // Telas que ocupam a janela inteira (o Inbox) descontam a altura destas abas com
  // `var(--altura-das-abas)`; sem isso a página passa a rolar e listas abertas fecham.
  const raiz = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const html = document.documentElement;
    const publicar = () => html.style.setProperty("--altura-das-abas", `${raiz.current?.offsetHeight ?? 0}px`);
    publicar();
    const el = raiz.current;
    const obs = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(publicar) : null;
    if (el) obs?.observe(el);
    return () => {
      obs?.disconnect();
      html.style.setProperty("--altura-das-abas", "0px");
    };
  }, [area]);

  if (!area) return null;
  const grupo = NAV_GROUPS.find((g) => g.id === area);
  if (!grupo) return null;
  const { principais, mais } = abasDaArea(
    area,
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
  );
  if (principais.length + mais.length === 0) return null;
  const atual = [...principais, ...mais].find((d) => d.href === abaHref);
  const ativa = (href: string) => href === abaHref;
  const estiloDaAba = (ligada: boolean) =>
    cn(
      "flex items-center gap-1 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors",
      ligada ? "border-gold font-medium text-text" : "border-transparent text-text-muted hover:text-text",
    );

  return (
    <div ref={raiz} className="border-b bg-surface px-3 md:px-6">
      <nav aria-label={`${t("Telas de")} ${t(grupo.label)}`} className="-mb-px flex gap-1 overflow-x-auto">
        {principais.map((d) => (
          <Link
            key={d.href}
            href={d.href}
            aria-current={ativa(d.href) ? "page" : undefined}
            className={estiloDaAba(ativa(d.href))}
          >
            {t(d.label)}
          </Link>
        ))}
        {mais.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger className={estiloDaAba(mais.some((d) => ativa(d.href)))}>
              {t("Mais")}
              <CaretDown size={12} aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {mais.map((d) => (
                <DropdownMenuItem key={d.href} asChild>
                  <Link href={d.href} aria-current={ativa(d.href) ? "page" : undefined}>
                    {t(d.label)}
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {grupo.hub && (
          // A página com todas as telas da área, organizadas por jornada (o antigo "Ver tudo em…").
          <Link
            href={grupo.hub.href}
            aria-current={pathname === grupo.hub.href ? "page" : undefined}
            className={cn(estiloDaAba(pathname === grupo.hub.href), "ml-auto text-xs")}
          >
            {t("Ver tudo")}
          </Link>
        )}
      </nav>
      {atual && <p className="py-2 text-xs text-text-muted">{t(atual.description)}</p>}
    </div>
  );
}
