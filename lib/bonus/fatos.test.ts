import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";

import { lerPrograma, paraTarefaDoMes, programasAtivos } from "./fatos";

const SP = "America/Sao_Paulo";

describe("tarefa do banco para o cálculo", () => {
  it("prazo às 23h de São Paulo é daquele dia, não do seguinte em UTC", () => {
    const t = paraTarefaDoMes(
      { id: "t1", status: "done", due_date: "2026-11-10T23:00:00-03:00", missed_due_date: null, closed_at: "2026-11-11T01:30:00Z" },
      SP,
    );
    expect(t).toEqual({ id: "t1", diaDoPrazo: "2026-11-10", situacao: "feita", diaDoFechamento: "2026-11-10", prazoTrocadoAposVencer: false });
  });

  it("prazo trocado depois de vencido usa o prazo ORIGINAL e fica marcado", () => {
    const t = paraTarefaDoMes(
      { id: "t2", status: "pending", due_date: "2026-12-05T12:00:00Z", missed_due_date: "2026-11-28T12:00:00Z", closed_at: null },
      SP,
    );
    expect(t).toMatchObject({ diaDoPrazo: "2026-11-28", situacao: "aberta", prazoTrocadoAposVencer: true });
  });

  it("in_progress é aberta; cancelled é cancelada", () => {
    const base = { id: "t3", due_date: "2026-11-10T12:00:00Z", missed_due_date: null, closed_at: null };
    expect(paraTarefaDoMes({ ...base, status: "in_progress" }, SP).situacao).toBe("aberta");
    expect(paraTarefaDoMes({ ...base, status: "cancelled", closed_at: "2026-11-09T12:00:00Z" }, SP).situacao).toBe("cancelada");
  });
});

describe("programas ativos", () => {
  it("regra inválida sai da lista e deixa aviso no log, sem derrubar os outros", async () => {
    const linha = (id: string, organization_id: string, regras: unknown) => ({
      id, organization_id, aprovador_user_id: "u1", ativo: true, regras, created_at: "2026-03-01T12:00:00Z",
      organizations: { timezone: "Fuso/Inexistente", settings: {} },
    });
    const data = [linha("p1", "org-ok", {}), linha("p2", "org-ruim", { participantes: "x" })];
    const consulta = { select: () => consulta, eq: () => consulta, limit: async () => ({ data, error: null }) };
    const admin = { from: () => consulta } as unknown as SupabaseClient;
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const r = await programasAtivos(admin);

    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.programas.map((p) => p.id)).toEqual(["p1"]);
    expect(r.programas[0]!.fuso).toBe("America/Sao_Paulo");
    expect(aviso).toHaveBeenCalledWith(
      "[bonus] programa ativo com regras inválidas",
      expect.objectContaining({ organizationId: "org-ruim", motivo: expect.stringMatching(/^regras_invalidas:/) }),
    );
    aviso.mockRestore();
  });
});

describe("início do programa", () => {
  it("created_at perto da meia-noite UTC cai no dia local do fuso", async () => {
    const linha = {
      id: "p1", organization_id: "org", aprovador_user_id: "u1", ativo: true, regras: {},
      created_at: "2026-03-15T02:00:00Z",
      organizations: { timezone: "America/Sao_Paulo", settings: {} },
    };
    const consulta = { select: () => consulta, eq: () => consulta, maybeSingle: async () => ({ data: linha, error: null }) };
    const admin = { from: () => consulta } as unknown as SupabaseClient;
    const r = await lerPrograma(admin, "org");
    expect(r.status === "ok" && r.programa.inicio).toBe("2026-03-14");
  });
});
