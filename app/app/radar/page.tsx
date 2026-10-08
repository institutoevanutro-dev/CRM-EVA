import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { CabecalhoDaPagina } from "@/components/shell/CabecalhoDaPagina";
import { traduzir } from "@/lib/i18n/dicionario";
import { RiskRadarList } from "./_components/RiskRadarList";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Radar" };

export default async function RadarPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`), sem reler o `locale` cru.
  const idioma = user.idioma;
  const t = (texto: string) => traduzir(texto, idioma);

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <CabecalhoDaPagina
        titulo={t("Radar de risco")}
        descricao={t(
          "Conversas abertas que esfriaram e precisam de você. Se o assistente já marcou um retorno, ela aparece como “retorno agendado”; sem próximo passo, há risco de perder o paciente.",
        )}
      />
      <RiskRadarList />
    </div>
  );
}
