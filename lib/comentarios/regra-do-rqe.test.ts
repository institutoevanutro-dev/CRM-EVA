import { beforeEach, describe, expect, it, vi } from "vitest";

const avisos = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: avisos.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { medicoSemRqe, regraDoRqeDaOrganizacao } from "./regra-do-rqe";

describe("medicoSemRqe: só o booleano false desliga a regra do RQE", () => {
  it("settings.medico_sem_rqe = false desliga", () => {
    expect(medicoSemRqe({ medico_sem_rqe: false })).toBe(false);
  });

  it.each<[string, unknown]>([
    ["chave ausente", {}],
    ["true", { medico_sem_rqe: true }],
    ["null", { medico_sem_rqe: null }],
    ['a string "false"', { medico_sem_rqe: "false" }],
    ["o número 0", { medico_sem_rqe: 0 }],
    ["string vazia", { medico_sem_rqe: "" }],
    ["settings null", null],
    ["settings undefined", undefined],
    ["settings que é texto", "medico_sem_rqe=false"],
    ["settings que é número", 0],
    ["settings que é lista", [false]],
    ["a chave dentro de comentarios, e não no nível de cima", { comentarios: { medico_sem_rqe: false } }],
  ])("%s vale ligada (o lado seguro)", (_caso, settings) => {
    expect(medicoSemRqe(settings)).toBe(true);
  });
});

type Resposta = { data: unknown; error: { message: string } | null } | Error;

/** Um cliente que só sabe responder `from().select().eq().maybeSingle()`. */
function clienteQueDevolve(resposta: Resposta) {
  const tabelas: string[] = [];
  const filtros: Array<[string, unknown]> = [];
  const cadeia = {
    select: () => cadeia,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);
      return cadeia;
    },
    maybeSingle: async () => {
      if (resposta instanceof Error) throw resposta;
      return resposta;
    },
  };
  const cliente = {
    from: (tabela: string) => {
      tabelas.push(tabela);
      return cadeia;
    },
  };
  return { cliente: cliente as never, tabelas, filtros };
}

describe("regraDoRqeDaOrganizacao: a leitura do banco, que nunca derruba quem chama", () => {
  beforeEach(() => avisos.warn.mockClear());

  it("lê settings da organização pedida e aplica a mesma régua", async () => {
    const { cliente, tabelas, filtros } = clienteQueDevolve({
      data: { settings: { medico_sem_rqe: false } },
      error: null,
    });
    expect(await regraDoRqeDaOrganizacao(cliente, "org-1")).toBe(false);
    expect(tabelas).toEqual(["organizations"]);
    expect(filtros).toEqual([["id", "org-1"]]);
  });

  it("organização que a leitura não acha vale ligada", async () => {
    const { cliente } = clienteQueDevolve({ data: null, error: null });
    expect(await regraDoRqeDaOrganizacao(cliente, "org-1")).toBe(true);
  });

  it.each<[string, Resposta]>([
    ["erro do banco", { data: null, error: { message: "banco fora do ar" } }],
    ["exceção", new Error("rede caiu")],
  ])("%s vale ligada, e fica no log", async (_caso, resposta) => {
    const { cliente } = clienteQueDevolve(resposta);
    expect(await regraDoRqeDaOrganizacao(cliente, "org-1")).toBe(true);
    expect(avisos.warn).toHaveBeenCalledWith(
      expect.stringContaining("regra do RQE"),
      expect.objectContaining({ organizationId: "org-1" }),
    );
  });
});
