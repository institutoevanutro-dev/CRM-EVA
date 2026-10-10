// @vitest-environment node
/**
 * O PONTO DO JEV: SEM CHAVE, NADA SAI DA MÁQUINA.
 *
 * Fase 1 do porte (melgarafael/DeskcommCRM #1575, #1696). O Jev nasce DESLIGADO:
 * sem `JEV_API_KEY` no ambiente, nenhuma chamada a api.typesafe.ai, nem com o
 * interruptor ligado e o aceite dado. Com a chave, só sai o que uma tarefa
 * ligada pergunta, e o texto já chega aqui limpo (quem chama passa o scrub).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ chave: "" as string, base: "" as string }));
vi.mock("@/lib/env", () => ({
  env: new Proxy({}, { get: (_t, k) => (k === "JEV_API_KEY" ? H.chave : k === "JEV_API_BASE_URL" ? H.base : undefined) }),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { reiniciarDisjuntor } from "./disjuntor";
import { perguntarAoJev } from "./ponto";

const ORG = "11111111-1111-4111-8111-111111111111";
const LIGADO = {
  jev: {
    ligado: true,
    aceite: { em: "2026-10-09T12:00:00.000Z", por: "22222222-2222-4222-8222-222222222222" },
  },
};
const pergunta = { humano: { tipo: "noul" as const, instrucao: "pede uma pessoa?" } };

function respostaOk() {
  return new Response(
    JSON.stringify({ model: "jev-1.13.0", answers: { humano: { type: "noul", noul: 0.12 } }, usage: { input_tokens: 400 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  H.chave = "";
  H.base = "";
  reiniciarDisjuntor();
  fetchSpy = vi.fn(async () => respostaOk());
  vi.stubGlobal("fetch", fetchSpy);
});

describe("zero chamadas sem chave", () => {
  it("sem JEV_API_KEY: nada sai, mesmo com o Jev ligado e aceito na organização", async () => {
    const r = await perguntarAoJev({ organizationId: ORG, settings: LIGADO, estado: "oi", perguntas: pergunta });
    expect(r).toMatchObject({ ok: false, motivo: "sem_credencial" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("chave só de espaços conta como ausente", async () => {
    H.chave = "   ";
    await perguntarAoJev({ organizationId: ORG, settings: LIGADO, estado: "oi", perguntas: pergunta });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("com chave, só o que a organização ligou", () => {
  beforeEach(() => {
    H.chave = "apikey_teste";
  });

  it.each([
    ["interruptor desligado", { jev: { ...LIGADO.jev, ligado: false } }],
    ["sem aceite do administrador", { jev: { ligado: true, aceite: null } }],
    ["config ausente (toda instalação)", {}],
    ["tarefa desligada", { jev: { ...LIGADO.jev, tarefas: { humano: { estado: "desligada" } } } }],
  ])("%s: nada sai", async (_nome, settings) => {
    const r = await perguntarAoJev({ organizationId: ORG, settings, estado: "oi", perguntas: pergunta });
    expect(r.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ligado e aceito: a tarefa nova nasce observando e pergunta ao System One", async () => {
    const r = await perguntarAoJev({ organizationId: ORG, settings: LIGADO, estado: "oi", perguntas: pergunta });
    expect(r.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer apikey_teste" });
  });

  it("base fora do padrão passa pela allowlist (o dublê do e2e)", async () => {
    H.base = "http://127.0.0.1:4010/";
    await perguntarAoJev({ organizationId: ORG, settings: LIGADO, estado: "oi", perguntas: pergunta });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe("http://127.0.0.1:4010/v1/systemone");
  });

  it("depois de falhar, o disjuntor segura as próximas sem sair para a rede", async () => {
    fetchSpy.mockImplementation(async () => new Response("x", { status: 503 }));
    await perguntarAoJev({ organizationId: ORG, settings: LIGADO, estado: "oi", perguntas: pergunta });
    const r = await perguntarAoJev({ organizationId: ORG, settings: LIGADO, estado: "oi", perguntas: pergunta });
    expect(r).toMatchObject({ ok: false, motivo: "disjuntor_aberto" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("nunca lança, nem com a rede caindo", async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error("ECONNRESET");
    });
    const r = await perguntarAoJev({ organizationId: ORG, settings: LIGADO, estado: "oi", perguntas: pergunta });
    expect(r).toMatchObject({ ok: false, motivo: "provedor_indisponivel" });
  });
});
