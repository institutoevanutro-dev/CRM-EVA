import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";

import { ListaDeCampanhas } from "./_client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Campanhas" };

export default async function CampanhasPage() {
  // A API das campanhas só responde a gerente; sem esta guarda, atendente e
  // recepção abriam a tela e viam "Erro ao carregar as campanhas" (item 232).
  // O mesmo piso do catálogo (`minRole: "manager"`), que tira o link do menu.
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  return <ListaDeCampanhas />;
}
