/**
 * Achados 1 e 18 da auditoria de 16/11: a listagem da agenda não dizia o
 * procedimento do compromisso. Remarcar então perguntava pelo tipo escolhido na
 * grade (agenda de outra pessoa), e o histórico dizia sempre "Agendamento".
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { listaAgendamentos } from "@/lib/agenda/consulta";

function agendaCom(extra: Record<string, unknown>, colunas: string[]): SupabaseClient {
  const linha = {
    id: "ag-1",
    title: "Título livre",
    starts_at: "2030-01-16T13:00:00.000Z",
    ends_at: "2030-01-16T13:30:00.000Z",
    time_zone: "America/Sao_Paulo",
    status: "confirmed",
    revision: 1,
    meeting_state: "none",
    meeting_url: null,
    owner_user_id: "u-bia",
    contact_id: null,
    contacts: null,
    ...extra,
  };
  const chain = {
    select: (cols: string) => {
      colunas.push(cols);
      return chain;
    },
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    limit: () => chain,
    in: () => chain,
    gte: () => chain,
    lt: () => chain,
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [linha], error: null }).then(res),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("a listagem traz o procedimento", () => {
  it("lê event_type_id e o nome do tipo, nas duas formas do embed", async () => {
    for (const embed of [{ name: "Retorno" }, [{ name: "Retorno" }]]) {
      const colunas: string[] = [];
      const r = await listaAgendamentos(
        agendaCom({ event_type_id: "tipo-retorno", calendar_event_types: embed }, colunas),
        "org",
        { ownerUserId: "u-bia", limite: 20 },
      );
      if (!r.ok) throw new Error(r.codigo);
      expect(colunas[0]).toContain("event_type_id");
      expect(colunas[0]).toMatch(/calendar_event_types\(name\b/);
      expect(r.agendamentos[0]).toMatchObject({ tipoId: "tipo-retorno", tipoNome: "Retorno" });
    }
  });

  it("tipo apagado (FK set null): os dois ficam nulos, sem inventar", async () => {
    const r = await listaAgendamentos(agendaCom({ event_type_id: null, calendar_event_types: null }, []), "org", { ownerUserId: "u-bia",
      limite: 20,
    });
    if (!r.ok) throw new Error(r.codigo);
    expect(r.agendamentos[0]).toMatchObject({ tipoId: null, tipoNome: null });
  });
});
