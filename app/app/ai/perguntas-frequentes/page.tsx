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
    <div className="flex h-full flex-col gap-6">
      <header>
        <h1 className="titulo-tela">{traduzir("Perguntas frequentes", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Respostas que você escreveu e que saem sem chamar a IA quando a mensagem é claramente uma destas perguntas. Na dúvida, a IA responde como sempre.",
            idioma,
          )}
        </p>
        {/* Resposta 17 do André (18/11): não juntar as duas FAQs, só explicar. */}
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Diferente de “Perguntas e respostas” em O que o agente sabe: lá a IA lê o conteúdo e responde com as palavras dela; aqui sai o seu texto, igual, sem IA.",
            idioma,
          )}
        </p>
      </header>
      <PerguntasFrequentesClient />
    </div>
  );
}
