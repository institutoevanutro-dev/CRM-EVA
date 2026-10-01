import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { upsertContatosDoCelular } from "./contatos-do-celular";

/** Banco falso: `contactsNoBanco` = {phone, name}; só casa o que o filtro pede. */
function fakeAdmin(contactsNoBanco: Array<{ phone: string; name: string | null }>, falhaEm: string[] = []) {
  const chamadas: Array<{ tabela: string; set: Record<string, unknown>; filtros: unknown[] }> = [];
  const inserts: unknown[] = [];
  const from = (tabela: string) => ({
    insert: (r: unknown) => (inserts.push(r), Promise.resolve({ error: null })),
    update: (set: Record<string, unknown>) => {
      const filtros: unknown[] = [];
      const q: Record<string, unknown> = {};
      q.eq = (c: string, v: unknown) => (filtros.push(["eq", c, v]), q);
      q.is = (c: string, v: unknown) => (filtros.push(["is", c, v]), q);
      q.in = (c: string, v: string[]) => (filtros.push(["in", c, v]), q);
      q.or = (e: string) => (filtros.push(["or", e]), q);
      q.select = async () => {
        chamadas.push({ tabela, set, filtros });
        const variantes = (filtros.find((f) => (f as string[])[0] === "in") as [string, string, string[]])[2];
        if (variantes.some((p) => falhaEm.includes(p))) return { data: null, error: { message: "boom" } };
        const casados = contactsNoBanco.filter((c) => variantes.includes(c.phone) && !c.name);
        casados.forEach((c) => (c.name = set.display_name as string));
        return { data: casados.map(() => ({ id: "x" })), error: null };
      };
      return q;
    },
  });
  return { from, chamadas, inserts };
}

describe("upsertContatosDoCelular (só atualiza)", () => {
  it("preenche nome vazio de contato existente, filtrando por org, não mesclado e nome vazio", async () => {
    const banco = [{ phone: "+5511999998888", name: null }];
    const admin = fakeAdmin(banco);
    const r = await upsertContatosDoCelular(admin as never, "org-1", [{ waId: "5511999998888", nome: "Maria" }]);
    expect(r).toEqual({ processados: 1 });
    expect(banco[0]!.name).toBe("Maria");
    const { tabela, set, filtros } = admin.chamadas[0]!;
    expect(tabela).toBe("contacts");
    expect(set).toEqual({ display_name: "Maria" });
    expect(filtros).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(filtros).toContainEqual(["is", "is_merged_into", null]);
    expect(filtros).toContainEqual(["or", "display_name.is.null,display_name.eq."]);
    expect(admin.inserts).toHaveLength(0);
  });

  it("nome já preenchido no CRM fica intocado", async () => {
    const banco = [{ phone: "+5511999998888", name: "Editado" }];
    const r = await upsertContatosDoCelular(fakeAdmin(banco) as never, "org-1", [{ waId: "5511999998888", nome: "Maria" }]);
    expect(r).toEqual({ processados: 0 });
    expect(banco[0]!.name).toBe("Editado");
  });

  it("número sem contato no CRM não cria nada; sem nome nem consulta", async () => {
    const admin = fakeAdmin([]);
    const r = await upsertContatosDoCelular(admin as never, "org-1", [
      { waId: "5521988887777", nome: "Ana" },
      { waId: "5521977776666", nome: null },
      { waId: "5521966665555", nome: "  " },
    ]);
    expect(r).toEqual({ processados: 0 });
    expect(admin.chamadas).toHaveLength(1);
    expect(admin.inserts).toHaveLength(0);
  });

  it("casa pelas duas grafias do nono dígito", async () => {
    const admin = fakeAdmin([]);
    await upsertContatosDoCelular(admin as never, "org-1", [{ waId: "553198966398", nome: "Bia" }]);
    expect(admin.chamadas[0]!.filtros).toContainEqual(["in", "phone_number", ["+553198966398", "+5531998966398"]]);
  });

  it("erro numa atualização não interrompe as demais", async () => {
    const banco = [{ phone: "+2", name: null }];
    const r = await upsertContatosDoCelular(fakeAdmin(banco, ["+1"]) as never, "org-1", [
      { waId: "1", nome: "A" },
      { waId: "2", nome: "B" },
    ]);
    expect(r).toEqual({ processados: 1 });
  });
});
