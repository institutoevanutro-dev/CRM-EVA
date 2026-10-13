import { afterEach, describe, expect, it } from "vitest";

import type { Lead } from "@/lib/types/leads";

import { anexarTarefasAosNegocios, type LinhaDaTarefaNoQuadro } from "./tarefas-no-quadro";

// Casos portados do PR #2760 do upstream (melgarafael/DeskcommCRM), mais o do fuso.
const AGORA = new Date("2026-10-11T12:00:00-03:00");
const ONTEM = "2026-10-10T09:00:00-03:00";
const AMANHA = "2026-10-12T09:00:00-03:00";

const lead = (id: string): Lead => ({ id }) as Lead;

const tarefa = (
  lead_id: string | null,
  resto: Partial<LinhaDaTarefaNoQuadro> = {},
): LinhaDaTarefaNoQuadro => ({ lead_id, due_date: null, status: "pending", ...resto });

describe("anexarTarefasAosNegocios — o selo de tarefas do card", () => {
  const fusoOriginal = process.env.TZ;
  afterEach(() => {
    process.env.TZ = fusoOriginal;
  });

  it("⭐ conta as abertas e, entre elas, as que passaram do prazo", () => {
    const [negocio] = anexarTarefasAosNegocios(
      [lead("l1")],
      [
        tarefa("l1", { due_date: ONTEM }),
        tarefa("l1", { due_date: AMANHA, status: "in_progress" }),
        tarefa("l1"),
      ],
      AGORA,
    );

    expect(negocio?.tarefas).toEqual({ abertas: 3, atrasadas: 1 });
  });

  it("encerrada não conta: nem a concluída, nem a cancelada com prazo vencido", () => {
    const [negocio] = anexarTarefasAosNegocios(
      [lead("l1")],
      [
        tarefa("l1", { due_date: AMANHA }),
        tarefa("l1", { due_date: ONTEM, status: "done" }),
        tarefa("l1", { due_date: ONTEM, status: "cancelled" }),
      ],
      AGORA,
    );

    expect(negocio?.tarefas).toEqual({ abertas: 1, atrasadas: 0 });
  });

  it("negócio só com tarefas encerradas não ganha selo de zero", () => {
    const [negocio] = anexarTarefasAosNegocios([lead("l1")], [tarefa("l1", { status: "done" })], AGORA);

    expect(negocio).not.toHaveProperty("tarefas");
  });

  it("cada negócio conta só as SUAS; tarefa avulsa e tarefa de negócio fora do quadro não entram em card nenhum", () => {
    const negocios = anexarTarefasAosNegocios(
      [lead("l1"), lead("l2"), lead("l3")],
      [tarefa("l1"), tarefa("l2", { due_date: ONTEM }), tarefa("l2"), tarefa(null), tarefa("fora-do-quadro")],
      AGORA,
    );

    expect(negocios.map((n) => n.tarefas)).toEqual([
      { abertas: 1, atrasadas: 0 },
      { abertas: 2, atrasadas: 1 },
      undefined,
    ]);
  });

  it("sem linha nenhuma devolve a MESMA lista (o quadro não recria os objetos à toa)", () => {
    const leads = [lead("l1")];
    expect(anexarTarefasAosNegocios(leads, [], AGORA)).toBe(leads);
  });

  it("⭐ fuso: 'atrasada' é o INSTANTE do prazo no horário da clínica, com o servidor em UTC ou em Tóquio", () => {
    // Prazo: hoje às 23h30 de Brasília (em UTC já é dia 12, 02h30).
    const prazo = "2026-10-11T23:30:00-03:00";
    const as21h = new Date("2026-10-11T21:00:00-03:00"); // em UTC já é dia 12, 00h00
    const as23h45 = new Date("2026-10-11T23:45:00-03:00");

    for (const fuso of ["UTC", "America/Sao_Paulo", "Asia/Tokyo"]) {
      process.env.TZ = fuso;
      const antes = anexarTarefasAosNegocios([lead("l1")], [tarefa("l1", { due_date: prazo })], as21h);
      const depois = anexarTarefasAosNegocios([lead("l1")], [tarefa("l1", { due_date: prazo })], as23h45);
      // O mesmo prazo como o Postgres devolve (timestamptz em UTC).
      const emUtc = anexarTarefasAosNegocios(
        [lead("l1")],
        [tarefa("l1", { due_date: "2026-10-12T02:30:00+00:00" })],
        as21h,
      );

      expect(antes[0]?.tarefas, fuso).toEqual({ abertas: 1, atrasadas: 0 });
      expect(emUtc[0]?.tarefas, fuso).toEqual({ abertas: 1, atrasadas: 0 });
      expect(depois[0]?.tarefas, fuso).toEqual({ abertas: 1, atrasadas: 1 });
    }
  });
});
