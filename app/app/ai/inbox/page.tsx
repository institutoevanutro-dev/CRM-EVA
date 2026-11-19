import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { AgentInboxList } from "./_components/AgentInboxList";

export const dynamic = "force-dynamic";

// O "Lembrete de caso parado" saiu daqui (decisão do André, 18/11): mora em
// Configurações › Distribuição de atendimento. A Central mostra só os avisos.
export default async function AgentInboxPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  const canResolve = ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6">
      <header>
        <h1 className="titulo-tela">{traduzir("Central de avisos", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "O que o assistente passou para a equipe: conexões caídas, tarefas que falharam, atendimentos passados a pessoas.",
            idioma,
          )}
        </p>
      </header>
      <AgentInboxList canResolve={canResolve} />
    </div>
  );
}
