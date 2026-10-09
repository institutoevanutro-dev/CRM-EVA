import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { BibliotecaDeMidias } from "./_client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Biblioteca de mídias" };

export default async function BibliotecaDeMidiasPage() {
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
        <h1 className="text-[2rem] leading-tight">{traduzir("Biblioteca de mídias", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Suba uma vez e o agente e os follow-ups reutilizam. Trocar o arquivo não mexe em nenhuma automação.",
            idioma,
          )}
        </p>
      </header>
      <BibliotecaDeMidias />
    </div>
  );
}
