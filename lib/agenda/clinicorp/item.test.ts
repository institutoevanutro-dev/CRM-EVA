import { describe, expect, it } from "vitest";

import { jsonComIdsGrandes, lerAgendaDaClinicorp, lerItemDaClinicorp, lerProfissionaisDaClinicorp } from "./item";

/**
 * O leitor da resposta de `GET /appointment/list` (Swagger oficial da Clinicorp).
 * Todo dado aqui é fictício. O formato é o do Swagger; o que ele não diz está
 * marcado como SUPOSIÇÃO em `item.ts` e tem caso próprio abaixo.
 */
const FUSO = "America/Sao_Paulo";

const agendamento = {
  ItemType: "APPOINTMENT",
  id: 5629499534213120,
  date: "2026-12-02T13:00:00.000Z", // 10:00 em São Paulo
  AtomicDate: 20261202,
  fromTime: "10:00",
  toTime: "11:30",
  Clinic_BusinessId: 7001,
  Dentist_PersonId: 9001,
  PatientName: "Paciente Fictícia da Silva",
  MobilePhone: "27999990000",
  Email: "ficticia@exemplo.test",
  Notes: "observação clínica fictícia",
  StatusId: 1,
  z_LastChange_Date: "2026-11-20T15:00:00.000Z",
};

describe("lerItemDaClinicorp", () => {
  it("agendamento vira intervalo no fuso da clínica, e nada do paciente sai", () => {
    const o = lerItemDaClinicorp(agendamento, FUSO);
    expect(o).toEqual({
      external_id: "5629499534213120",
      professional_id: "9001",
      clinic_id: "7001",
      starts_at: "2026-12-02T13:00:00.000Z",
      ends_at: "2026-12-02T14:30:00.000Z",
      status: "confirmed",
      external_updated_at: "2026-11-20T15:00:00.000Z",
    });
    const texto = JSON.stringify(o);
    for (const dado of ["Fictícia", "27999990000", "exemplo.test", "observação"]) expect(texto).not.toContain(dado);
  });

  it("sem AtomicDate, o dia vem de `date` quando ela é o instante do começo", () => {
    const { AtomicDate: _a, ...semAtomico } = agendamento;
    expect(lerItemDaClinicorp(semAtomico, FUSO)?.starts_at).toBe("2026-12-02T13:00:00.000Z");
  });

  it("SUPOSIÇÃO: `date` à meia-noite UTC que não casa com fromTime é só a data", () => {
    const { AtomicDate: _a, ...semAtomico } = agendamento;
    const o = lerItemDaClinicorp({ ...semAtomico, date: "2026-12-02T00:00:00.000Z" }, FUSO);
    expect(o?.starts_at).toBe("2026-12-02T13:00:00.000Z");
  });

  it("compromisso (ASSIGN) com AtomicDate e dia inteiro ocupa o dia local todo", () => {
    const o = lerItemDaClinicorp(
      { ItemType: "ASSIGN", id: 77, AtomicDate: 20261207, AllDay: "x", Dentist_PersonId: 9001, Name: "Curso" },
      FUSO,
    );
    expect(o?.starts_at).toBe("2026-12-07T03:00:00.000Z");
    expect(o?.ends_at).toBe("2026-12-08T03:00:00.000Z");
    expect(JSON.stringify(o)).not.toContain("Curso");
  });

  it("desmarcado ou excluído vira `cancelled` (libera o horário já copiado)", () => {
    expect(lerItemDaClinicorp({ ...agendamento, Canceled: "X" }, FUSO)?.status).toBe("cancelled");
    expect(lerItemDaClinicorp({ ...agendamento, Deleted: "x" }, FUSO)?.status).toBe("cancelled");
    expect(lerItemDaClinicorp({ ...agendamento, Canceled: "" }, FUSO)?.status).toBe("confirmed");
  });

  it("fica de fora: evento da unidade (sem profissional), sem horário, fim antes do começo, id inválido", () => {
    const { Dentist_PersonId: _p, ...semProfissional } = agendamento;
    expect(lerItemDaClinicorp(semProfissional, FUSO)).toBeNull();
    expect(lerItemDaClinicorp({ ...agendamento, toTime: null }, FUSO)).toBeNull();
    expect(lerItemDaClinicorp({ ...agendamento, toTime: "09:00" }, FUSO)).toBeNull();
    expect(lerItemDaClinicorp({ ...agendamento, id: "abc" }, FUSO)).toBeNull();
    expect(lerItemDaClinicorp({ ...agendamento, AtomicDate: 20261332 }, FUSO)).toBeNull();
  });
});

describe("lerAgendaDaClinicorp", () => {
  it("conta o que ficou de fora; resposta que não é lista é erro, não agenda vazia", () => {
    const r = lerAgendaDaClinicorp([agendamento, { id: 1 }], FUSO);
    expect(r.ocupacoes).toHaveLength(1);
    expect(r.ignorados).toBe(1);
    expect(() => lerAgendaDaClinicorp({ message: "erro" }, FUSO)).toThrow("resposta_fora_do_formato");
  });
});

describe("lerProfissionaisDaClinicorp", () => {
  it("guarda id e nome; CPF e e-mail ficam de fora", () => {
    const r = lerProfissionaisDaClinicorp([{ id: 9001, name: "Dra. Fictícia", cpf: "00000000000", email: "dra@exemplo.test" }]);
    expect(r).toEqual([{ professional_id: "9001", name: "Dra. Fictícia" }]);
  });
});

describe("jsonComIdsGrandes", () => {
  it("id acima de 2^53 não perde dígito; número comum segue número", () => {
    const r = jsonComIdsGrandes('[{"id": 9007199254740993, "Dentist_PersonId": 12}]') as Array<Record<string, unknown>>;
    expect(r[0]?.id).toBe("9007199254740993");
    expect(r[0]?.Dentist_PersonId).toBe(12);
  });
});
