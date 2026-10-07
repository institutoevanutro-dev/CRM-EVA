import { expect, it, vi } from "vitest";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("./cliente", () => ({ consultaFinanceiro: vi.fn(async () => ({
  resumo: { paciente_nome: "Nome do paciente" },
})) }));

import { audit } from "@/lib/audit";
import { sincronizarNomesFinanceiro } from "./sincronizar-nomes";

it("repete organização, anonimização e nome vazio no UPDATE após a consulta remota", async () => {
  const filtros: string[] = [];
  const select = {
    eq(coluna: string, valor: unknown) { filtros.push(`select:${coluna}:${valor}`); return this; },
    or(valor: string) { filtros.push(`select:or:${valor}`); return this; },
    order() { return this; },
    async limit() { return { data: [{ id: "id-1", name: null }], error: null }; },
  };
  const update = {
    eq(coluna: string, valor: unknown) { filtros.push(`update:${coluna}:${valor}`); return this; },
    or(valor: string) { filtros.push(`update:or:${valor}`); return this; },
    async select() { return { data: [], error: null }; }, // nome editado antes do UPDATE
  };
  const admin = { from: () => ({
    select: () => select,
    update: () => update,
  }) };
  const resultado = await sincronizarNomesFinanceiro(
    admin as never,
    "org-1",
    { url: "https://financeiro.example.test", token: "segredo" },
  );
  expect(resultado).toEqual({ consultados: 1, atualizados: 0, falhas: 0 });
  expect(filtros).toContain("update:organization_id:org-1");
  expect(filtros).toContain("update:is_anonymized:false");
  expect(filtros).toContain("update:or:name.is.null,name.eq.");
  expect(audit).not.toHaveBeenCalled();
});

it("só pergunta de novo por quem nunca foi consultado ou foi há mais de 7 dias", async () => {
  const filtros: string[] = [];
  const select = {
    eq() { return this; },
    or(valor: string) { filtros.push(valor); return this; },
    order() { return this; },
    async limit() { return { data: [], error: null }; },
  };
  const admin = { from: () => ({ select: () => select, update: () => ({}) }) };
  const agora = new Date("2026-10-07T12:00:00.000Z");
  const resultado = await sincronizarNomesFinanceiro(admin as never, "org-1", { url: "https://f.example.test", token: "t" }, agora);
  expect(resultado).toEqual({ consultados: 0, atualizados: 0, falhas: 0 });
  expect(filtros).toContain("financeiro_name_lookup_at.is.null,financeiro_name_lookup_at.lt.2026-09-30T12:00:00.000Z");
});
