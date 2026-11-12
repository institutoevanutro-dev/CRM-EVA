"use client";
import Link from "next/link";
import { useT } from "@/hooks/i18n/useT";
import { usePathname } from "next/navigation";
import { useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { CaretDown, CaretDoubleLeft, CaretDoubleRight, Gear, House, SignOut } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { toggleSidebar } from "@/app/actions/shell/toggleSidebar";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { SearchTrigger } from "@/components/shell/SearchTrigger";
import { VersionFooter } from "@/components/shell/VersionFooter";
import { LogotipoDoProduto, SimboloDoProduto } from "@/components/branding/MarcaDoProduto";
import { marcaEhADoProduto } from "@/lib/branding";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import { CONFIGURACOES, gruposDoMenu, ondeNoMenu, telasDaConta, veInicio } from "@/lib/navigation/menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePrefetchPorIntencao } from "@/hooks/navigation/prefetchPorIntencao";


interface SidebarContentProps {
  collapsed: boolean;
  showCollapseControl?: boolean;
  onNavigate?: () => void;
  /** Recolher otimista (D1.10): quem guarda o estado é o `AppShell`. */
  onAlternarRecolhido?: () => void;
}

/** Grupos abertos, por navegador. Preferência de conveniência: perder não quebra nada. */
const CHAVE_DOS_GRUPOS = "menu:grupos-abertos";

const ouvintesDosGrupos = new Set<() => void>();

function assinarGrupos(avisar: () => void): () => void {
  ouvintesDosGrupos.add(avisar);
  window.addEventListener("storage", avisar);
  return () => {
    ouvintesDosGrupos.delete(avisar);
    window.removeEventListener("storage", avisar);
  };
}

function lerGruposCru(): string {
  try {
    return window.localStorage.getItem(CHAVE_DOS_GRUPOS) ?? "{}";
  } catch {
    return "{}";
  }
}

function interpretarGrupos(cru: string): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(cru);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function gravarGrupos(grupos: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(CHAVE_DOS_GRUPOS, JSON.stringify(grupos));
  } catch {
    // Navegação privada ou armazenamento cheio: o menu só não lembra.
  }
  for (const avisar of ouvintesDosGrupos) avisar();
}

/**
 * Navegação principal no desenho do PrecificaEva e do Eva Financeiro (pedido do dono,
 * 10/10/2026): cada área é um grupo que abre e fecha mostrando as suas telas, a busca de
 * telas e a pessoa logada moram aqui, e o botão de recolher fica no topo.
 *
 * Não decide nada: `areasDoMenu()` e `abasDaArea()` (lib/navigation/registry.ts) resolvem
 * o que este papel vê, e este componente desenha.
 */

function iniciais(nome: string | null | undefined, email: string | undefined): string {
  const partes = (nome ?? "").trim().split(/\s+/).filter(Boolean);
  if (partes.length) return partes.slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  return (email ?? "").slice(0, 2).toUpperCase();
}

export function SidebarContent({
  collapsed,
  showCollapseControl = true,
  onNavigate,
  onAlternarRecolhido,
}: SidebarContentProps) {
  const t = useT();
  const pathname = usePathname();
  const [saindo, sair] = useTransition();
  const { user, activeOrg, signOut } = useAuth();
  // O menu não pede tela nenhuma sozinho, só quando alguém vai para ela (porte do
  // original #3613): ver hooks/navigation/prefetchPorIntencao.ts.
  const intencao = usePrefetchPorIntencao();
  const quem = [
    user.is_platform_admin && !user.support,
    activeOrg?.role ?? null,
    activeOrg?.interface_settings,
  ] as const;
  // Grupos pelo que a pessoa veio fazer (lib/navigation/menu.ts); cada um mostra todas as suas telas.
  const grupos = gruposDoMenu(...quem);
  const conta = telasDaConta(...quem);
  const onde = ondeNoMenu(pathname);
  const atual = onde.grupo;
  const abaAtual = onde.href;
  // Os outros grupos: o que a pessoa deixou aberto, guardado no navegador. No servidor
  // e na hidratação vale "{}" (useSyncExternalStore), então o HTML não diverge.
  const guardadoCru = useSyncExternalStore(assinarGrupos, lerGruposCru, () => "{}");
  const guardado = useMemo(() => interpretarGrupos(guardadoCru), [guardadoCru]);
  // O grupo da tela atual: sempre aberto ao chegar na tela; fecha só se a pessoa
  // fechar durante a visita. Zerado ao trocar de grupo, ajustando no render.
  const [fechouNestaVisita, setFechouNestaVisita] = useState(false);
  const [visita, setVisita] = useState(atual);
  if (visita !== atual) {
    setVisita(atual);
    setFechouNestaVisita(false);
  }
  const aberto = (id: string) => (id === atual ? !fechouNestaVisita : guardado[id] === true);
  const alternar = (id: string) => {
    const vaiAbrir = !aberto(id);
    if (id === atual) setFechouNestaVisita(!vaiAbrir);
    gravarGrupos({ ...guardado, [id]: vaiAbrir });
  };

  const papeis: Record<string, string> = { admin: t("Administrador"), manager: t("Gestor"), agent: t("Atendente"), viewer: t("Leitura") };
  const papel = papeis[activeOrg?.role ?? ""];

  const brand = useMarcaDaInstalacao();
  const nome = activeOrg?.marca?.nome ?? brand.name;
  // O menu é verde nos dois temas: da instalação vale o logo para FUNDO ESCURO (a
  // logo "escuro" da Conta); o da organização continua na frente, como sempre.
  const logo = activeOrg?.marca?.logoUrl || brand.logoEscuroUrl || brand.logoUrl;
  const marcaDoProduto = marcaEhADoProduto({ name: nome, logoUrl: logo ?? null });

  const estiloDoItem = (ativo: boolean) =>
    cn(
      "relative flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-[15px] transition-colors lg:min-h-10",
      ativo
        ? "bg-sidebar-active font-medium text-gold before:absolute before:top-1/2 before:left-0 before:h-6 before:w-[3px] before:-translate-y-1/2 before:rounded-r-full before:bg-gold"
        : "text-sidebar-fg hover:bg-sidebar-active",
    );

  const inicio = (
    <Link
      href="/app/inicio"
      {...intencao("/app/inicio")}
      title={collapsed ? t("Início") : undefined}
      aria-current={atual === "inicio" ? "page" : undefined}
      onClick={onNavigate}
      className={cn(estiloDoItem(atual === "inicio"), "py-2.5", collapsed && "justify-center px-2")}
    >
      <House size={20} weight={atual === "inicio" ? "fill" : "light"} aria-hidden />
      {!collapsed && <span className="truncate">{t("Início")}</span>}
    </Link>
  );

  const grupo = (item: (typeof grupos)[number]) => {
    const Icone = item.icon;
    const ativa = atual === item.id;
    // O aviso de conexão caída só para quem pode abrir Conexões e agir.
    const temSaude = item.itens.some((d) => d.healthDot);
    const expandido = !collapsed && aberto(item.id);
    return (
      <div key={item.id}>
        {collapsed ? (
          // Recolhido não há lista para abrir: o ícone leva à primeira tela do grupo.
          <Link
            href={item.itens[0]!.href}
            {...intencao(item.itens[0]!.href)}
            title={t(item.label)}
            aria-current={ativa ? "page" : undefined}
            onClick={onNavigate}
            className={cn(
              "relative flex min-h-11 items-center justify-center rounded-lg px-2 transition-colors hover:bg-sidebar-active lg:min-h-10",
              ativa ? "bg-sidebar-active text-gold" : "text-sidebar-fg",
            )}
          >
            <Icone size={20} weight={ativa ? "fill" : "light"} aria-hidden />
            {temSaude && <ConnectionHealthDot className="absolute top-1.5 right-1.5" />}
          </Link>
        ) : (
          // Aberto, o nome do grupo SÓ abre e fecha (D1.10): antes ele às vezes levava à
          // primeira tela e às vezes só abria, conforme a tela em que se estava. Abre na
          // hora; só a seta gira — animar a altura falha calado no Safari (ver a coluna
          // de horários no globals.css).
          <button
            type="button"
            onClick={() => alternar(item.id)}
            aria-expanded={expandido}
            className="rotulo-secao flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-gold transition-colors hover:bg-sidebar-active lg:min-h-10"
          >
            <span className="min-w-0 flex-1 truncate">{t(item.label)}</span>
            {temSaude && <ConnectionHealthDot />}
            <CaretDown
              size={14}
              aria-hidden
              className={cn("shrink-0 transition-transform duration-150 motion-reduce:transition-none", expandido && "rotate-180")}
            />
          </button>
        )}
        {expandido && (
          <nav aria-label={`${t("Telas de")} ${t(item.label)}`} className="mt-0.5 mb-2 space-y-0.5">
            {item.itens.map((d) => {
              const Ic = d.icon;
              const ligada = d.href === abaAtual;
              return (
                <Link key={d.href} href={d.href} {...intencao(d.href)} aria-current={ligada ? "page" : undefined} onClick={onNavigate} className={estiloDoItem(ligada)}>
                  <Ic size={18} weight={ligada ? "fill" : "light"} aria-hidden />
                  <span className="truncate">{t(d.label)}</span>
                </Link>
              );
            })}
          </nav>
        )}
      </div>
    );
  };

  // Otimista (D1.10): o menu muda no clique; o cookie segue para a primeira pintura
  // da próxima carga, e o servidor não redesenha o layout por causa disto.
  const recolher = showCollapseControl && (
    <button
      type="button"
      onClick={() => {
        onAlternarRecolhido?.();
        toggleSidebar(collapsed).catch(() => undefined);
      }}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gold hover:bg-sidebar-active"
      aria-label={collapsed ? t("Expandir sidebar") : t("Recolher sidebar")}
      title={collapsed ? t("Expandir sidebar") : t("Recolher sidebar")}
    >
      {collapsed ? <CaretDoubleRight size={16} aria-hidden /> : <CaretDoubleLeft size={16} aria-hidden />}
    </button>
  );

  return (
    <>
      {/* `h-14` como a barra do topo: logo-moldura-no-tema-escuro.spec.ts mede este retângulo. */}
      <div className={cn("flex h-14 items-center gap-2 px-4", collapsed ? "justify-center px-2" : "justify-between")}>
        <div className="flex min-w-0 items-center">
        {logo && !collapsed ? (
          // Sem moldura: o menu é verde nos dois temas, então o logo aparece direto
          // sobre ele (a moldura branca existia para o menu escuro de antes).
          // <img> e não next/image: a URL vem de quem hospeda (banco ou .env).
          // eslint-disable-next-line @next/next/no-img-element
          <span className="flex min-w-0 items-center gap-2.5">
            <img src={logo} alt={nome} className="h-8 w-auto max-w-[9rem] shrink-0 object-contain" />
            {/* O nome ao lado do logo só quando a ORGANIZAÇÃO definiu nome próprio: o
                logo da instalação costuma já trazer o nome escrito, e repetido ocuparia
                a faixa duas vezes. Na serifa do site da clínica. */}
            {activeOrg?.marca?.nome ? (
              <span aria-hidden className="flex min-w-0 flex-col">
                <span className="truncate font-titulo text-[19px] leading-6 font-medium text-sidebar-fg">{nome}</span>
                <span className="mt-1 text-[10px] font-medium tracking-[0.3em] text-gold uppercase">{t("CRM")}</span>
              </span>
            ) : null}
          </span>
        ) : marcaDoProduto ? (
          collapsed ? (
            <SimboloDoProduto nome={nome} sobreFunda className="h-8 w-8" />
          ) : (
            <LogotipoDoProduto nome={nome} sobreFunda className="h-8 w-auto" />
          )
        ) : (
          // Sem logo, o nome em texto (contrato visual comum): o nome em creme e "CRM" em
          // dourado, Lora 500 19/24; embaixo, o nome da clínica quando é outro.
          <span className={cn("flex min-w-0 flex-col", collapsed && "sr-only")}>
            <span className="flex min-w-0 items-baseline gap-1.5 font-titulo text-[19px] leading-6 font-medium">
              <span className="truncate text-sidebar-fg">{nome}</span>
              {/crm$/i.test(nome.trim()) ? null : (
                <span className="shrink-0 text-gold">
                  {t("CRM")}
                </span>
              )}
            </span>
            {activeOrg?.name && activeOrg.name !== nome ? (
              <span className="nome-da-clinica mt-0.5 truncate text-gold">{activeOrg.name}</span>
            ) : null}
          </span>
        )}
        {collapsed && !marcaDoProduto && (
          <span aria-hidden className="text-lg font-bold text-gold">
            {[...nome][0]?.toUpperCase() ?? brand.initial}
          </span>
        )}
        </div>
        {!collapsed && recolher}
      </div>
      {collapsed && <div className="flex justify-center pb-1">{recolher}</div>}
      <div aria-hidden className="mx-4 mb-2 h-px bg-gradient-to-r from-transparent via-gold/70 to-transparent" />
      <div className={cn("px-3 pb-2", collapsed && "px-2")}>
        <SearchTrigger naLateral recolhida={collapsed} atalho={showCollapseControl} />
      </div>
      {/* Só os grupos rolam. O Início fica parado acima deles: com um grupo grande aberto numa
          janela baixa, a lista rolava e ele aparecia cortado embaixo da busca (print de 10/10/2026). */}
      <nav className="flex min-h-0 flex-1 flex-col p-2" aria-label={t("Navegação principal")}>
        {veInicio(...quem) && <div className="shrink-0 pb-1">{inicio}</div>}
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">{grupos.map(grupo)}</div>
      </nav>
      <div className="border-t border-white/10 p-2">
        {/* A página de Configurações lista também o que não tem tela no menu (atualização, canal oficial, modelos,
            voz). Fica fixa aqui, fora da área que rola: é o que se procura quando não se acha algo. */}
        <Link
          href={CONFIGURACOES}
          {...intencao(CONFIGURACOES)}
          title={collapsed ? t("Configurações") : undefined}
          aria-current={atual === "configuracoes" ? "page" : undefined}
          onClick={onNavigate}
          className={cn(estiloDoItem(atual === "configuracoes"), "mb-1 text-sm", collapsed && "justify-center px-2")}
        >
          <Gear size={18} weight={atual === "configuracoes" ? "fill" : "light"} aria-hidden />
          {!collapsed && <span className="truncate">{t("Configurações")}</span>}
        </Link>
        {/* "Minha conta" (Perfil, Segurança, Notificações) saiu dos grupos: abre pelo cartão de quem está logado.
            `modal={false}`: o menu modal trava a rolagem da página e a lateral `sticky` saía do lugar. */}
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger
            disabled={conta.length === 0}
            aria-label={t("Minha conta")}
            title={collapsed ? (user.full_name ?? user.email) : undefined}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg bg-sidebar-active px-3 py-2 text-left transition-colors hover:bg-white/15",
              abaAtual && conta.some((d) => d.href === abaAtual) && "ring-1 ring-gold/60",
              collapsed && "justify-center px-0",
            )}
          >
            <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-gold/50 text-xs font-semibold text-gold">
              {iniciais(user.full_name, user.email)}
            </span>
            {!collapsed && (
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-sidebar-fg">{user.full_name ?? user.email}</span>
                {papel && <span className="truncate text-xs text-gold">{papel}</span>}
              </span>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="min-w-[200px]">
            {conta.map((d) => (
              <DropdownMenuItem key={d.href} asChild>
                <Link href={d.href} {...intencao(d.href)} aria-current={d.href === abaAtual ? "page" : undefined} onClick={onNavigate}>
                  {t(d.label)}
                </Link>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          disabled={saindo}
          onClick={() => sair(async () => { await signOut(); })}
          title={collapsed ? t("Sair") : undefined}
          aria-label={collapsed ? t("Sair") : undefined}
          className={cn("mt-1 flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-sidebar-fg hover:bg-sidebar-active", collapsed && "justify-center px-2")}
        >
          <SignOut size={18} aria-hidden />
          {!collapsed && <span>{t("Sair")}</span>}
        </button>
        <VersionFooter collapsed={collapsed} onNavigate={onNavigate} />
      </div>
    </>
  );
}

export function Sidebar({
  collapsed,
  onAlternarRecolhido,
}: {
  collapsed: boolean;
  onAlternarRecolhido?: () => void;
}) {
  return (
    <aside
      className={cn(
        // O topo e a altura descontam `--faixas-de-cima` (porte do original
        // #3190): as faixas grudam em `top-0` com z-50, e uma barra em `top-0`
        // passaria por baixo delas, com o pé (Sair) abaixo da borda da tela.
        // A largura anima em 200 ms: exceção declarada no contrato de movimento.
        "fundo-lateral sticky top-[var(--faixas-de-cima,0px)] z-30 flex h-[calc(100dvh-var(--faixas-de-cima,0px))] shrink-0 flex-col text-sidebar-fg shadow-[inset_-1px_0_0_rgba(255,255,255,0.10)] transition-[width] duration-200 motion-reduce:transition-none",
        collapsed ? "w-16" : "w-64",
      )}
    >
      <SidebarContent collapsed={collapsed} onAlternarRecolhido={onAlternarRecolhido} />
    </aside>
  );
}
