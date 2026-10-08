/**
 * Análise → Painel do funil. Os números de um funil no período, juntos e cada
 * um com a sua régua (`docs/superpowers/specs/2026-10-06-painel-do-funil-design.md`).
 *
 * `manager` pela mesma razão de Meta Ads (`app/app/ads/meta/page.tsx`):
 * investimento, receita e ROAS são da empresa inteira. A rota repete o piso.
 */
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { PainelDoFunilClient } from "./_components/PainelDoFunilClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Painel do funil" };

export default async function PainelDoFunilPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const plataforma = user.is_platform_admin && !user.support;
  if (!plataforma && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) redirect("/403");
  // Quem não pode conectar não deve ler "vá em Configurações › Meta Ads": a tela
  // lá é `admin`, e mandar um manager para um 403 é pior que dizer a verdade.
  const podeConectar = plataforma || ROLE_RANK[activeOrg.role] >= ROLE_RANK.admin;
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div
      data-superficie="clara"
      className="-m-6 flex min-h-[calc(100%+3rem)] flex-col gap-6 bg-bg p-6 text-text"
    >
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Painel do funil")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          {t(
            "Quem chegou, quem interagiu, quem compareceu e quanto custou cada venda, no mesmo período e no mesmo funil. Embaixo de cada número está o que ele conta.",
          )}
        </p>
      </header>
      <PainelDoFunilClient podeConectar={podeConectar} />
    </div>
  );
}
