import type { Metadata } from "next";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { papelNoPrograma } from "@/lib/bonus/acesso";
import { lerPrograma } from "@/lib/bonus/fatos";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";

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
  const lido = org ? await lerPrograma(createAdminClient(), org.orgId) : ({ status: "ausente" } as const);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header>
        <h1 className="text-[2rem] leading-tight">{t("Bônus")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("O placar do mês, a fila de hoje e, para quem aprova, a equipe inteira.")}
        </p>
      </header>
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
