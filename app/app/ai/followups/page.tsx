import { ErroDeLeitura } from "@/components/empty/ErroDeLeitura";
import { CabecalhoDaPagina } from "@/components/shell/CabecalhoDaPagina";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { ROLE_RANK } from "@/lib/auth/types";
import { createClient } from "@/lib/supabase/server";
import type { FollowupFlowPointerRow } from "@/hooks/followup/useFollowupFlows";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { lerConfigDosBloqueios } from "@/lib/followup/bloqueios-obrigatorios";
import { FlowsList } from "./_components/FlowsList";
import { HorarioDeEnvio } from "./_components/HorarioDeEnvio";
import { QueueTab } from "./_components/QueueTab";

export const dynamic = "force-dynamic";

const FLOW_COLUMNS = "id, name, status, active_version_id, handoff_policy, updated_at";

export default async function FollowupFlowsPage() {
  const user = await requireAuth();
  // `t` local em vez do hook: esta página é componente de SERVIDOR, e lá o
  // idioma vem resolvido em `user.idioma` (a cadeia pessoa → organização →
  // padrão vive em `lib/auth/server.ts`).
  const t = (texto: string) => traduzir(texto, user.idioma);
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  // Fluxos (edição) segue exigindo manager+; a Fila (leitura) é de qualquer
  // member — o gate por tela fica dentro das abas (canWrite), não na rota.

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("followup_flow_pointers")
    .select(FLOW_COLUMNS)
    .eq("organization_id", activeOrg.orgId)
    .order("updated_at", { ascending: false });

  const flows = (data ?? []) as unknown as FollowupFlowPointerRow[];

  const { data: org } = await supabase
    .from("organizations")
    .select("settings, timezone")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  // Config ilegível abre como "sem limite": a tela existe justamente para consertá-la.
  const janela = lerConfigDosBloqueios(org?.settings)?.janela ?? null;
  const canWrite = ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <CabecalhoDaPagina
        titulo="Follow-ups"
        descricao={t("Mensagens automáticas para retomar a conversa — depois de um silêncio, de uma mudança de etapa, de um aviso de outro sistema ou de uma resposta do contato.")}
      />
      <HorarioDeEnvio
        initial={janela && { dias: janela.dias, intervalos: janela.intervalos }}
        timezone={org?.timezone ?? "America/Sao_Paulo"}
        canWrite={canWrite}
      />
      <Tabs defaultValue="fluxos" className="flex flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="fluxos">{t("Fluxos")}</TabsTrigger>
          <TabsTrigger value="fila">{t("Fila")}</TabsTrigger>
        </TabsList>
        <TabsContent value="fluxos">
          {error ? (
            <ErroDeLeitura texto={t("Não foi possível carregar os follow-ups. Recarregue a página.")} />
          ) : (
            <FlowsList initialData={flows} canWrite={canWrite} />
          )}
        </TabsContent>
        <TabsContent value="fila">
          <QueueTab canWrite={canWrite} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
