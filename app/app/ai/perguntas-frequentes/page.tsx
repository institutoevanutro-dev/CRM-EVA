import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { PerguntasFrequentesClient } from "./_client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Perguntas frequentes" };

export default async function PerguntasFrequentesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Perguntas frequentes", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Respostas que você escreveu e que saem sem chamar a IA quando a mensagem é claramente uma destas perguntas. Na dúvida, a IA responde como sempre.",
            idioma,
          )}
        </p>
      </header>
      <PerguntasFrequentesClient />
    </div>
  );
}
