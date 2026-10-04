import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";

import { TagReportClient } from "./_components/TagReportClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Por etiqueta" };

export default async function TagReportPage() {
  const user = await requireAuth();
  const t = (texto: string) => traduzir(texto, user.idioma);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("Por etiqueta")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Qual assunto ocupou a operação no período — e quanto tempo ele esperou.")}
        </p>
      </header>

      <TagReportClient />
    </div>
  );
}
