import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { upsertContatosDoCelular } from "./contatos-do-celular";

function fakeAdmin(falhaEm: string[] = []) {
  const rpc = vi.fn(async (_fn: string, args: { p_chat_id: string }) =>
    falhaEm.includes(args.p_chat_id) ? { data: null, error: { message: "boom" } } : { data: "id", error: null },
  );
  return { rpc };
}

describe("upsertContatosDoCelular", () => {
  it("chama fn_upsert_wa_contact por contato, com o nome em p_notify e o waId em p_chat_id", async () => {
    const admin = fakeAdmin();
    const r = await upsertContatosDoCelular(admin as never, "org-1", [
      { waId: "5511999998888", nome: "Maria" },
      { waId: "5521988887777", nome: null },
    ]);
    expect(r).toEqual({ processados: 2 });
    expect(admin.rpc).toHaveBeenCalledTimes(2);
    expect(admin.rpc).toHaveBeenNthCalledWith(1, "fn_upsert_wa_contact", expect.objectContaining({ p_org: "org-1", p_kind: "phone", p_chat_id: "5511999998888", p_notify: "Maria" }));
    expect(admin.rpc).toHaveBeenNthCalledWith(2, "fn_upsert_wa_contact", expect.objectContaining({ p_chat_id: "5521988887777", p_notify: null }));
  });

  it("erro numa RPC não interrompe as demais e não conta", async () => {
    const admin = fakeAdmin(["1"]);
    const r = await upsertContatosDoCelular(admin as never, "org-1", [
      { waId: "1", nome: "A" },
      { waId: "2", nome: "B" },
    ]);
    expect(admin.rpc).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ processados: 1 });
  });
});

describe("contrato do baseline", () => {
  it("a definição EM VIGOR de fn_upsert_wa_contact preenche nome só quando vazio (é o que sustenta 'nunca sobrescreve nome editado')", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    const cabecalho = "create or replace function public.fn_upsert_wa_contact(";
    const ultima = baseline.lastIndexOf(cabecalho);
    expect(ultima).toBeGreaterThan(0);
    const corpo = baseline.slice(ultima, baseline.indexOf("$$;", baseline.indexOf("$$", ultima + cabecalho.length) + 2));
    expect(corpo).toContain("coalesce(display_name, nullif(p_notify, ''))");
    expect(baseline.indexOf(cabecalho, ultima + 1)).toBe(-1);
  });
});
