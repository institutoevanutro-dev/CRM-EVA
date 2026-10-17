"use client";
import Link from "next/link";
import { useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { useOrganizationTransition } from "./OrganizationTransitionProvider";
import { CaretDown, Check, Storefront } from "@/lib/ui/icons";
import { useUser, useActiveOrg } from "@/hooks/auth/AuthProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { setActiveOrg } from "@/app/actions/shell/setActiveOrg";

export function TenantSwitcher() {
  const t = useT();
  const user = useUser();
  const active = useActiveOrg();
  const transition = useOrganizationTransition();
  const [isPending, setPending] = useState(false);
  const switchTo = async (orgId: string) => {
    if (orgId === active?.orgId) return;
    flushSync(() => { setPending(true); transition.begin(t("Carregando organização…")); });
    try {
      const result = await setActiveOrg(orgId);
      if (!result.ok) throw new Error(result.error);
      // Novo documento elimina QueryClient, subscriptions e respostas em voo.
      window.location.assign("/app/inbox");
    } catch {
      transition.cancel();
      setPending(false);
      toast.error(t("Não foi possível trocar de organização. Seu acesso pode ter mudado. Tente novamente."));
    }
  };

  // Uma organização só: não há o que trocar, mas há o que DIZER — o nome de
  // onde se está é a âncora da barra. Texto, não botão: um gatilho que abre um
  // menu de um item só é controle morto. Abaixo do `md` some, pelo mesmo
  // motivo do botão (ver o comentário dele): o cabeçalho do celular não cabe.
  if (user.organizations.length <= 1 && !user.is_platform_admin) {
    if (!active?.name) return null;
    return (
      <p className="hidden min-w-0 items-center gap-2 px-1 text-sm font-medium text-text md:flex">
        <Storefront size={16} weight="duotone" aria-hidden className="shrink-0 text-text-muted" />
        <span className="max-w-[220px] truncate">{active.name}</span>
      </p>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/*
          ⚠️ NO CELULAR ESTE BOTÃO É SÓ O ÍCONE, e isso não é economia de estilo:
          é o que faz o cabeçalho caber.

          Medido na tela, numa instalação real em 360px: com o nome escrito, o
          botão ocupava 153px e o cabeçalho tinha 14 sobreposições, a pior de
          96px — o nome da organização por baixo do campo de busca, e a busca por
          cima do sino. Hambúrguer + nome + busca + sino + avatar não cabem em
          360px, e o bloco do meio é `flex-1 justify-center` entre dois
          `shrink-0`: quando falta espaço ele transborda por cima dos vizinhos em
          vez de encolher.

          Só o ícone: 40px, e as sobreposições vão a zero. O nome completo
          continua a UM TOQUE, dentro do menu que este botão já abre — e
          continua no `aria-label`, para quem usa leitor de tela.

          `min-w-0` sozinho NÃO resolve (medido): ele deixa o flex comprimir o
          texto, mas a 18px visíveis o nome vira "M…", e as colisões de 13px com
          a busca continuam. O espaço é que não existe.
        */}
        <Button
          variant="ghost"
          size="sm"
          disabled={isPending || !!user.support}
          // Pílula com borda, e não texto solto: é o único controle à esquerda
          // da barra e precisa parecer clicável sem passar o mouse por cima.
          // Mesma altura (36px) dos botões da direita, para as duas pontas da
          // barra alinharem pela mesma linha.
          className="h-11 gap-2 rounded-full border border-border px-3 lg:h-9 md:max-w-[280px]"
          aria-label={`${t("Organização")}: ${active?.name ?? t("Selecionar org")}`}
          title={user.support ? "Saia do acompanhamento para trocar de organização" : undefined}
          data-testid="tenant-switcher"
        >
          <Storefront size={16} weight="duotone" aria-hidden />
          <span className="hidden max-w-[200px] truncate text-sm font-medium md:inline">
            {active?.name ?? "Selecionar org"}
          </span>
          <CaretDown size={12} aria-hidden className="hidden text-text-muted md:inline" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[min(18rem,calc(100vw-2rem))]">
        <DropdownMenuLabel className="text-xs font-medium text-text-muted">
          {t("Suas organizações")}
        </DropdownMenuLabel>
        {user.organizations.map((org) => {
          const atual = active?.orgId === org.organization_id;
          return (
            <DropdownMenuItem
              key={org.organization_id}
              data-testid={`tenant-switcher-item-${org.organization_id}`}
              onClick={() => { void switchTo(org.organization_id); }}
              aria-current={atual ? "true" : undefined}
              className="flex items-center gap-2.5 py-2"
            >
              {/* Inicial num disco: a lista de organizações se lê pela forma
                  antes do nome, como na barra lateral do Slack. */}
              <span
                aria-hidden
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-elevated text-xs font-semibold text-text"
              >
                {org.organization_name.trim().charAt(0).toUpperCase() || "?"}
              </span>
              <span className="min-w-0 flex-1 truncate">{org.organization_name}</span>
              {atual && <Check size={14} weight="bold" aria-hidden className="shrink-0 text-accent" />}
            </DropdownMenuItem>
          );
        })}
        {user.is_platform_admin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/admin/tenants">{t("Gerenciar organizações")}</Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
