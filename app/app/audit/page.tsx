import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROLE_RANK } from "@/lib/auth/types";
import { AuditClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Histórico de alterações" };

export default async function AuditPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const idioma = user.idioma;
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Histórico de alterações")}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir("Tudo o que foi criado, alterado ou apagado na clínica, e por quem. Visível para gestores e administradores.", idioma)}
        </p>
      </header>
      <AuditClient />
    </div>
  );
}
