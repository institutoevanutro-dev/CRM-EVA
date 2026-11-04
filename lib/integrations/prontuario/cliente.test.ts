import { beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: log.warn, error: log.error, info: vi.fn() } }));

import {
  CODIGO_DO_PRONTUARIO_VINCULO_NAO_CONFIRMADO,
  enviarExameAoProntuario,
  estadoDosExames,
} from "./cliente";

const ORG = "11111111-1111-4111-8111-111111111111";
const SEGREDO = "s".repeat(32);
const env = (p: Record<string, string | undefined> = {}) => ({
  PRONTUARIO_URL: "https://prontuario.exemplo.com.br",
  PRONTUARIO_EXAMES_SEGREDO: SEGREDO,
  PRONTUARIO_ORGANIZATION_ID: ORG,
  ...p,
});

describe("estadoDosExames", () => {
  it("desligada: três vazias, outra organização, org que não é UUID", () => {
    expect(estadoDosExames(ORG, {})).toEqual({ estado: "desligada" });
    expect(estadoDosExames(ORG, { PRONTUARIO_URL: "", PRONTUARIO_EXAMES_SEGREDO: "", PRONTUARIO_ORGANIZATION_ID: "" })).toEqual({ estado: "desligada" });
    expect(estadoDosExames("22222222-2222-4222-8222-222222222222", env())).toEqual({ estado: "desligada" });
    expect(estadoDosExames("nao-uuid", env({ PRONTUARIO_ORGANIZATION_ID: "nao-uuid" }))).toEqual({ estado: "desligada" });
  });

  it("inválida pelo motivo", () => {
    expect(estadoDosExames(ORG, env({ PRONTUARIO_EXAMES_SEGREDO: ` ${"s".repeat(31)} ` }))).toEqual({ estado: "invalida", motivo: "segredo_curto" });
    expect(estadoDosExames(ORG, env({ PRONTUARIO_EXAMES_SEGREDO: "" }))).toEqual({ estado: "invalida", motivo: "segredo_curto" });
    for (const url of [
      "http://prontuario.exemplo.com.br",
      "https://prontuario.exemplo.com.br/api",
      "https://prontuario.exemplo.com.br/?x=1",
      "https://usuario@prontuario.exemplo.com.br",
      "https://prontuario.exemplo.com.br/#a",
      "nao-e-url",
    ])
      expect(estadoDosExames(ORG, env({ PRONTUARIO_URL: url })), url).toEqual({ estado: "invalida", motivo: "url_invalida" });
  });

  it("ligada: https e http em loopback (e2e)", () => {
    expect(estadoDosExames(ORG, env())).toEqual({ estado: "ligada", url: "https://prontuario.exemplo.com.br", segredo: SEGREDO });
    expect(estadoDosExames(ORG, env({ PRONTUARIO_URL: "http://127.0.0.1:47814" }))).toMatchObject({ estado: "ligada", url: "http://127.0.0.1:47814" });
    expect(estadoDosExames(ORG, env({ PRONTUARIO_URL: "http://localhost:47814/" }))).toMatchObject({ estado: "ligada" });
  });
});

const CFG = { url: "https://prontuario.exemplo.com.br", segredo: SEGREDO };
const CORPO = { contact_id: "c0c0c0c0-0000-4000-8000-000000000001", message_id: "a1a1a1a1-0000-4000-8000-000000000001", enviado_por: "Atendente Fictícia" };
const EXAME = "e0e0e0e0-0000-4000-8000-000000000001";

const json = (status: number, corpo: unknown) =>
  new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
const erro = (status: number, code: string) => json(status, { error: { code, message: "texto do prontuário" } });

function falso(...respostas: Array<Response | Error>) {
  const f = vi.fn(async () => {
    const r = respostas.shift();
    if (!r) throw new Error("sem mais respostas");
    if (r instanceof Error) throw r;
    return r;
  });
  return f;
}

beforeEach(() => vi.clearAllMocks());

describe("enviarExameAoProntuario: o pedido", () => {
  it("cabeçalhos exatos, segredo só no cabeçalho, redirect error, corpo do contrato", async () => {
    const f = falso(json(201, { exam_id: EXAME, ja_existia: false }));
    await enviarExameAoProntuario(CFG, CORPO, { fetch: f as unknown as typeof fetch });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://prontuario.exemplo.com.br/api/integracoes/crm/exames");
    expect(url).not.toContain(SEGREDO);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${SEGREDO}`,
      "Content-Type": "application/json",
      "Idempotency-Key": CORPO.message_id,
    });
    expect(JSON.parse(init.body as string)).toEqual(CORPO);
  });
});

describe("enviarExameAoProntuario: cada resposta do Prontuário (tabela 5.3)", () => {
  const casos: Array<[string, Response[], string, number]> = [
    ["404 paciente_nao_vinculado", [erro(404, "paciente_nao_vinculado")], "paciente_nao_vinculado", 1],
    ["404 midia_nao_encontrada", [erro(404, "midia_nao_encontrada")], "midia_nao_encontrada", 1],
    ["404 sem código", [json(404, "<html>404</html>")], "prontuario_configuracao", 1],
    ["409 contato_com_varios_pacientes", [erro(409, "contato_com_varios_pacientes")], "contato_com_varios_pacientes", 1],
    ["409 midia_ainda_nao_disponivel", [erro(409, "midia_ainda_nao_disponivel")], "midia_ainda_nao_disponivel", 1],
    ["409 vínculo não confirmado", [erro(409, CODIGO_DO_PRONTUARIO_VINCULO_NAO_CONFIRMADO)], "vinculo_nao_confirmado", 1],
    ["422 formato_nao_aceito", [erro(422, "formato_nao_aceito")], "formato_nao_aceito", 1],
    ["413 grande_demais", [erro(413, "grande_demais")], "grande_demais", 1],
    ["413 pedido_grande_demais", [erro(413, "pedido_grande_demais")], "prontuario_configuracao", 1],
    ["400 pedido_invalido", [erro(400, "pedido_invalido")], "prontuario_configuracao", 1],
    ["401 nao_autorizado", [erro(401, "nao_autorizado")], "prontuario_configuracao", 1],
    ["503 integracao_desligada", [erro(503, "integracao_desligada")], "prontuario_configuracao", 1],
    ["503 crm_nao_configurado", [erro(503, "crm_nao_configurado")], "prontuario_configuracao", 1],
    ["503 crm_recusou_chave", [erro(503, "crm_recusou_chave")], "prontuario_configuracao", 1],
    ["429 limite_de_pedidos", [erro(429, "limite_de_pedidos")], "prontuario_indisponivel", 1],
    ["503 crm_indisponivel duas vezes", [erro(503, "crm_indisponivel"), erro(503, "crm_indisponivel")], "prontuario_sem_acesso_ao_crm", 2],
    ["503 indisponivel duas vezes", [erro(503, "indisponivel"), erro(503, "indisponivel")], "prontuario_indisponivel", 2],
    ["503 manutenção (texto) duas vezes", [json(503, "Em manutenção"), json(503, "Em manutenção")], "prontuario_indisponivel", 2],
    ["502 duas vezes", [json(502, "bad gateway"), json(502, "bad gateway")], "prontuario_indisponivel", 2],
    ["504 duas vezes", [json(504, ""), json(504, "")], "prontuario_indisponivel", 2],
    ["500", [json(500, { error: "x" })], "prontuario_indisponivel", 1],
    ["2xx inválido", [json(201, { ok: true })], "prontuario_indisponivel", 1],
    ["exam_id que não é UUID", [json(201, { exam_id: "x", ja_existia: false })], "prontuario_indisponivel", 1],
  ];
  it.each(casos)("%s", async (_n, respostas, codigo, chamadas) => {
    const f = falso(...respostas);
    const r = await enviarExameAoProntuario(CFG, CORPO, { fetch: f as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, codigo, tentativas: chamadas });
    expect(f).toHaveBeenCalledTimes(chamadas);
  });

  it("rede caindo duas vezes → indisponível, sem status", async () => {
    const f = falso(new TypeError("fetch failed"), new TypeError("fetch failed"));
    const r = await enviarExameAoProntuario(CFG, CORPO, { fetch: f as unknown as typeof fetch });
    expect(r).toEqual({ ok: false, codigo: "prontuario_indisponivel", statusDoProntuario: null, codigoDoProntuario: null, tentativas: 2 });
  });

  it("201 → sucesso; 200 ja_existia → sucesso que já estava", async () => {
    expect(await enviarExameAoProntuario(CFG, CORPO, { fetch: falso(json(201, { exam_id: EXAME, ja_existia: false })) as unknown as typeof fetch }))
      .toEqual({ ok: true, examId: EXAME, jaExistia: false, tentativas: 1 });
    expect(await enviarExameAoProntuario(CFG, CORPO, { fetch: falso(json(200, { exam_id: EXAME, ja_existia: true })) as unknown as typeof fetch }))
      .toEqual({ ok: true, examId: EXAME, jaExistia: true, tentativas: 1 });
  });
});

describe("enviarExameAoProntuario: a nova tentativa", () => {
  it("repete com a MESMA chave e o MESMO corpo", async () => {
    const f = falso(erro(503, "crm_indisponivel"), json(201, { exam_id: EXAME, ja_existia: false }));
    const r = await enviarExameAoProntuario(CFG, CORPO, { fetch: f as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, tentativas: 2 });
    const [, a] = f.mock.calls[0] as unknown as [string, RequestInit];
    const [, b] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(b.headers).toEqual(a.headers);
    expect(b.body).toBe(a.body);
  });

  it("1ª estoura e a 2ª volta 200 ja_existia → jaExistia false (a 1ª gravou)", async () => {
    const f = falso(new DOMException("timeout", "TimeoutError"), json(200, { exam_id: EXAME, ja_existia: true }));
    expect(await enviarExameAoProntuario(CFG, CORPO, { fetch: f as unknown as typeof fetch })).toMatchObject({ ok: true, jaExistia: false, tentativas: 2 });
  });

  it("1ª 502 e a 2ª 200 ja_existia → jaExistia false; 1ª 503 crm_indisponivel → vale o que o Prontuário disse", async () => {
    expect(await enviarExameAoProntuario(CFG, CORPO, { fetch: falso(json(502, ""), json(200, { exam_id: EXAME, ja_existia: true })) as unknown as typeof fetch }))
      .toMatchObject({ jaExistia: false });
    expect(await enviarExameAoProntuario(CFG, CORPO, { fetch: falso(erro(503, "crm_indisponivel"), json(200, { exam_id: EXAME, ja_existia: true })) as unknown as typeof fetch }))
      .toMatchObject({ jaExistia: true });
  });

  it("corpo de 1 MiB → indisponível sem repetir", async () => {
    // JSON VÁLIDO de 1 MiB (sucesso + espaços): sem o teto, passaria por sucesso.
    const f = falso(new Response(JSON.stringify({ exam_id: EXAME, ja_existia: false }) + " ".repeat(1024 * 1024), { status: 201 }));
    const r = await enviarExameAoProntuario(CFG, CORPO, { fetch: f as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, codigo: "prontuario_indisponivel", tentativas: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("prazo total: sem a segunda tentativa quando sobra menos de 1 s dos 40 s", async () => {
    let t = 0;
    const f = vi.fn(async () => {
      t += 39_500;
      throw new TypeError("fetch failed");
    });
    const r = await enviarExameAoProntuario(CFG, CORPO, { fetch: f as unknown as typeof fetch, agora: () => t });
    expect(r).toMatchObject({ ok: false, codigo: "prontuario_indisponivel", tentativas: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("o log nunca leva segredo, URL nem nome", async () => {
    await enviarExameAoProntuario(CFG, CORPO, { fetch: falso(erro(401, "nao_autorizado")) as unknown as typeof fetch, requestId: "req-1" });
    expect(log.error).toHaveBeenCalledWith("prontuario.exames.envio", expect.objectContaining({ codigo: "prontuario_configuracao", status: 401, request_id: "req-1", message_id: CORPO.message_id }));
    const tudo = JSON.stringify([log.error.mock.calls, log.warn.mock.calls]);
    expect(tudo).not.toContain(SEGREDO);
    expect(tudo).not.toContain("prontuario.exemplo");
    expect(tudo).not.toContain("Atendente Fictícia");
  });
});
