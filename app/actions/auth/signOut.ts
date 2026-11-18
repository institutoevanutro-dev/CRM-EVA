"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { audit } from "@/lib/audit";

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const hdrs = await headers();
  // "Sair" encerra só ESTE aparelho (auditoria 17/11, item 46). O padrão do
  // supabase-js é `global`: sair no iPhone derrubava o Mac e, com o login da
  // recepção compartilhado, os outros computadores. Encerrar todos é escolha
  // explícita em Configurações › Segurança (`signOutEverywhere`).
  await supabase.auth.signOut({ scope: "local" });

  // Clear active_org cookie too.
  const store = await cookies();
  store.delete("active_org");

  if (user) {
    await audit({
      action: "auth.logout",
      actorUserId: user.id,
      requestId: hdrs.get("x-request-id"),
      ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: hdrs.get("user-agent") ?? null,
    });
  }

  redirect("/login");
}
