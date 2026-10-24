import { describe, expect, it } from "vitest";

import { paraTarefaDoMes } from "./fatos";

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
