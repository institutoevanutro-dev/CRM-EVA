import { expect, it } from "vitest";
import { ResumoFinanceiro } from "./cliente";

const base = {
  paciente_id: "11111111-1111-4111-8111-111111111111",
  consultado_em: "2026-09-24T12:00:00Z",
  limitado: false,
  propostas: [],
  vendas: [],
};

it("aceita contrato anterior durante implantação e nome no contrato novo", () => {
  expect(ResumoFinanceiro.parse({ ...base, versao: 1 }).paciente_nome).toBeUndefined();
  expect(ResumoFinanceiro.parse({ ...base, versao: 2, paciente_nome: "Paciente" }).paciente_nome).toBe("Paciente");
  expect(ResumoFinanceiro.safeParse({ ...base, versao: 2, paciente_nome: "" }).success).toBe(false);
});

it("sinais do paciente: opcionais (Financeiro antigo não manda) e validados quando vêm", () => {
  expect(ResumoFinanceiro.parse({ ...base, versao: 2 }).sinais).toEqual([]);
  const sinal = { id: "22222222-2222-4222-8222-222222222222", data: "2026-11-16", valor_cents: "15000", situacao: "aberto" };
  expect(ResumoFinanceiro.parse({ ...base, versao: 2, sinais: [sinal] }).sinais).toEqual([sinal]);
  expect(ResumoFinanceiro.safeParse({ ...base, versao: 2, sinais: [{ ...sinal, situacao: "outra" }] }).success).toBe(false);
});
