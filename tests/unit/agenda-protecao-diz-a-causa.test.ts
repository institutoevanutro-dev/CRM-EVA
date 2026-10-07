import { afterEach, expect, it, vi } from "vitest";
import { protecaoAgendaPg, protecaoAgendaSupabase } from "@/lib/agenda/protecao-followup";
import { logger } from "@/lib/logger";

/**
 * Quando a leitura da agenda falha, a cobrança é adiada. Sem a causa no log, o
 * adiamento vira silêncio: medido em produção (07/10/2026), milhares de avisos
 * "proteção indisponível" por hora e nenhum dizendo o porquê. E o aviso saía
 * uma vez POR CONTATO da leitura (404 de uma vez no radar), não uma por falha.
 */
afterEach(() => vi.restoreAllMocks());

const agora = new Date("2026-10-07T12:00:00Z");

it("leitura pelo Supabase que falha: um aviso só, com a mensagem e o código do erro", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit", "gt"]) q[m] = () => q;
  q.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: null, error: { message: "URI too long", code: "PGRST000" } }).then(resolve);
  const db = { from: () => q } as never;
  const r = await protecaoAgendaSupabase(db, "org", ["a", "b", "c"], agora);
  expect([...r.values()].every((p) => p.motivo === "leitura_indisponivel")).toBe(true);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]![1]).toMatchObject({ origem: "supabase", erro: "URI too long", codigo: "PGRST000" });
});

it("leitura pelo Postgres que falha: o aviso diz a causa", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  const db = { query: async () => { throw Object.assign(new Error("connection terminated"), { code: "57P01" }); } } as never;
  const p = await protecaoAgendaPg(db, "org", "contato", agora);
  expect(p.motivo).toBe("leitura_indisponivel");
  expect(warn.mock.calls[0]![1]).toMatchObject({ origem: "pg", erro: "connection terminated", codigo: "57P01" });
});
