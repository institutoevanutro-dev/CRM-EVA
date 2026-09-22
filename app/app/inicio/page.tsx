import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { PainelInicio } from "./_components/PainelInicio";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Início" };

/**
 * INÍCIO — a primeira tela (`homeDaInterface`). O que cada pessoa precisa fazer
 * hoje e, para gerente/admin, o que impede o CRM de funcionar.
 * Spec: docs/superpowers/specs/2026-09-21-painel-inicio-design.md
 */
export default async function InicioPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app/settings/profile");
  const t = (texto: string) => traduzir(texto, user.idioma);
  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Início")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("O que precisa da sua atenção hoje, num lugar só.")}
        </p>
      </header>
      <PainelInicio />
    </div>
  );
}
