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
  // Saudação pela hora de Brasília (o servidor roda em UTC) e só o primeiro nome.
  const agora = new Date();
  const hora = Number(agora.toLocaleString("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "America/Sao_Paulo" }));
  const saudacao = hora < 12 ? t("Bom dia") : hora < 18 ? t("Boa tarde") : t("Boa noite");
  const primeiroNome = user.full_name?.trim().split(/\s+/)[0];
  const hoje = agora.toLocaleDateString(user.idioma === "es" ? "es" : "pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Sao_Paulo",
  });
  return (
    <div className="flex h-full flex-col gap-8 p-6 md:p-8">
      <header>
        <p className="text-xs font-medium tracking-[0.18em] text-gold uppercase">{t("Início")}</p>
        <h1 className="mt-1 text-[2.25rem] leading-tight">
          {primeiroNome ? `${saudacao}, ${primeiroNome}` : saudacao}
        </h1>
        <p className="mt-1 text-sm text-text-muted first-letter:uppercase">
          {hoje} · {t("O que precisa da sua atenção hoje, num lugar só.")}
        </p>
      </header>
      <PainelInicio />
    </div>
  );
}
