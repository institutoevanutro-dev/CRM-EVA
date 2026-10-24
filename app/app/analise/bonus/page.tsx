import type { Metadata } from "next";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { papelNoPrograma, podeCriarPrograma } from "@/lib/bonus/acesso";
import { lerPrograma } from "@/lib/bonus/fatos";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

import { AssumirAprovacao } from "./_components/AssumirAprovacao";
import { BonusClient } from "./_components/BonusClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Bônus" };

/**
 * Análise › Bônus. O servidor só decide QUAIS abas mostrar; o recorte do que
 * cada pessoa lê é das rotas `/api/v1/bonus/*` (participante só o próprio,
 * aprovador a equipe e a configuração).
 */
export default async function BonusPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  const t = (texto: string) => traduzir(texto, user.idioma);
  const admin = createAdminClient();
  const lido = org ? await lerPrograma(admin, org.orgId) : ({ status: "ausente" } as const);
  // Aprovador revogado: ninguém mais configura pela tela. Erro na leitura não
  // acusa nada (melhor faltar o aviso que acusar à toa).
  let aprovadorSaiu = false;
  if (org && lido.status === "ok") {
    const { data, error } = await admin
      .from("user_organizations")
      .select("id")
      .eq("organization_id", org.orgId)
      .eq("user_id", lido.programa.aprovadorUserId)
      .is("revoked_at", null)
      .maybeSingle();
    aprovadorSaiu = !error && !data;
  }
  let podeAssumir = false;
  if (org && aprovadorSaiu) {
    const { data } = await admin.from("organizations").select("created_by").eq("id", org.orgId).maybeSingle();
    podeAssumir = podeCriarPrograma(user, (data as { created_by?: string | null } | null)?.created_by ?? null);
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-[2rem] leading-tight">{t("Bônus")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("O placar do mês, a fila de hoje e, para quem aprova, a equipe inteira.")}
        </p>
      </header>
      {aprovadorSaiu ? (
        <div className="rounded-md border border-border p-3 text-sm" data-testid="aprovador-fora-da-equipe">
          <p>
            {t("Quem aprova o bônus não faz mais parte da equipe. Só o dono da organização ou um administrador da plataforma pode assumir a função.")}
          </p>
          {podeAssumir ? <AssumirAprovacao userId={user.id} /> : null}
        </div>
      ) : null}
      {lido.status === "erro" ? (
        <p className="text-sm text-destructive">{t("Não foi possível ler o programa de bônus.")}</p>
      ) : (
        <BonusClient
          papel={
            lido.status === "ok"
              ? { existe: true, ...papelNoPrograma(lido.programa, user.id) }
              : { existe: false, aprovador: false, participante: false }
          }
        />
      )}
    </div>
  );
}
