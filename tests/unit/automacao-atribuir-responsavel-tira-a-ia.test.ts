/**
 * "ATRIBUIR RESPONSÁVEL" EM NEGÓCIO QUE ESTAVA COM A IA.
 *
 * `crm_leads_owner_kind_coherence` exige o trio coerente: dono humano é
 * `owner_kind='user'` com `owner_agent_id` nulo. A ação `assign_owner` gravava
 * só `owner_user_id` — num negócio que estava com um agente de IA o banco
 * recusava a escrita e a automação falhava; num negócio sem dono, o responsável
 * ficava sem `owner_kind`. Agora o patch sai de `resolveOwnerPatch`, a mesma
 * régua das outras escritas de dono. Porte do original 332da1f5b (webtecnica).
 *
 * Só o banco é dublê; o executor é o de verdade.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/assign-owner";
import type { ActionCtx } from "@/lib/automation/types";

const ORG = "88800000-0000-4000-8000-000000000001";
const GERENTE = "88800000-0000-4000-8000-000000000002";
const LEAD = "88800000-0000-4000-8000-000000000003";

type Escrita = { tabela: string; valores: Record<string, unknown> };

function banco(escritas: Escrita[]): SupabaseClient {
  const tabela = (nome: string) => {
    const cadeia: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "in", "is", "order", "limit"]) cadeia[m] = () => cadeia;
    cadeia.maybeSingle = async () => ({ data: { user_id: GERENTE, role: "manager" }, error: null });
    cadeia.update = (valores: Record<string, unknown>) => {
      escritas.push({ tabela: nome, valores });
      return cadeia;
    };
    cadeia.then = (resolve: (v: { error: null }) => unknown) => resolve({ error: null });
    return cadeia;
  };
  return { from: tabela } as unknown as SupabaseClient;
}

function ctx(admin: SupabaseClient): ActionCtx {
  return {
    admin,
    organizationId: ORG,
    ruleId: "88800000-0000-4000-8000-000000000004",
    ruleName: "Automação de teste",
    event: { id: "e-1", organization_id: ORG, event_type: "lead.created" } as unknown as ActionCtx["event"],
    context: { lead: { id: LEAD } },
    requestId: "test-request-id",
  };
}

describe("assign_owner grava o trio do dono coerente", () => {
  it("owner_user_id, owner_kind='user' e owner_agent_id=null — tira a IA do negócio", async () => {
    const escritas: Escrita[] = [];
    const resultado = await getAction("assign_owner")!.execute(ctx(banco(escritas)), { user_id: GERENTE });

    expect(resultado.status).toBe("success");
    expect(escritas).toHaveLength(1);
    expect(escritas[0]!.tabela).toBe("crm_leads");
    expect(escritas[0]!.valores).toMatchObject({
      owner_user_id: GERENTE,
      owner_kind: "user",
      owner_agent_id: null,
    });
  });
});
