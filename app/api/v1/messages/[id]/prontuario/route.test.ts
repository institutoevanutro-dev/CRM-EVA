import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  suporte: vi.fn(),
  papel: vi.fn(),
  rate: vi.fn(),
  visivel: vi.fn(),
  buscar: vi.fn(),
  ler: vi.fn(),
  registrar: vi.fn(),
  tocar: vi.fn(),
  audit: vi.fn(),
  logError: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: m.suporte }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: m.papel }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: m.rate }));
vi.mock("@/lib/audit", () => ({ audit: m.audit }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: m.logError, info: vi.fn() } }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/prontuario/midias", () => ({ buscarMidia: m.buscar }));
vi.mock("@/lib/prontuario/exames-enviados", () => ({
  lerExameEnviado: m.ler,
  registrarExameEnviado: m.registrar,
  tocarMensagem: m.tocar,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const filtros: unknown[][] = [];
    const chain = {
      select: () => chain,
      eq: (...a: unknown[]) => (filtros.push(a), chain),
      maybeSingle: async () => m.visivel(filtros),
    };
    return { from: () => chain };
  },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const MSG = "aaaaaaaa-0000-4000-8000-00000000000a";
const CONTATO = "cccccccc-0000-4000-8000-00000000000c";
const EXAME = "eeeeeeee-0000-4000-8000-00000000000e";
const SEGREDO = "x".repeat(40);

const { POST } = await import("./route");
const pedir = (id = MSG) => POST(new Request("https://crm.exemplo.test/x", { method: "POST" }) as never, { params: Promise.resolve({ id }) });

const midia = (p: Record<string, unknown> = {}) => ({
  message_id: MSG, contact_id: CONTATO, conversation_id: "c", sent_at: new Date(), mime: "application/pdf",
  size_bytes: "2048", filename: "exame-ficticio.pdf", type: "document", storage_path: `${ORG}/c/${MSG}.pdf`, pendente: false, ...p,
});
const usuario = (p: Record<string, unknown> = {}) => ({ id: USER, full_name: "Atendente Fictícia", idioma: "pt-BR", support: null, ...p });
const resp = (status: number, corpo: unknown) => new Response(JSON.stringify(corpo), { status });
const erro = (status: number, code: string) => resp(status, { error: { code, message: "texto que não pode vazar" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PRONTUARIO_URL", "https://prontuario.exemplo.com.br");
  vi.stubEnv("PRONTUARIO_EXAMES_SEGREDO", SEGREDO);
  vi.stubEnv("PRONTUARIO_ORGANIZATION_ID", ORG);
  vi.stubGlobal("fetch", m.fetch);
  m.suporte.mockResolvedValue(null);
  m.papel.mockResolvedValue({ ok: true, user: usuario(), org: { orgId: ORG, role: "agent" } });
  m.rate.mockResolvedValue({ allowed: true, limit: 30, count: 1 });
  m.visivel.mockResolvedValue({ data: { id: MSG }, error: null });
  m.ler.mockResolvedValue(null);
  m.buscar.mockResolvedValue(midia());
  m.registrar.mockImplementation(async (r: { messageId: string; jaExistia: boolean; userId: string }) => ({
    registro: { message_id: r.messageId, ja_existia: r.jaExistia, enviado_em: "2026-11-04T12:00:00.000Z", enviado_por_user_id: r.userId },
    novo: true,
  }));
  m.fetch.mockResolvedValue(resp(201, { exam_id: EXAME, ja_existia: false }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const nadaSaiu = () => {
  expect(m.fetch).not.toHaveBeenCalled();
  expect(m.registrar).not.toHaveBeenCalled();
};

describe("quem pode", () => {
  it("o bloqueio de suporte vem antes de tudo", async () => {
    m.suporte.mockResolvedValueOnce(new Response(null, { status: 403 }));
    expect((await pedir()).status).toBe(403);
    expect(m.papel).not.toHaveBeenCalled();
  });

  it("viewer/provider: requireRole('agent') recusa", async () => {
    m.papel.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await pedir()).status).toBe(403);
    expect(m.papel).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "messages" }));
    nadaSaiu();
  });

  it("sessão de acompanhamento em modo full → 403, mesmo com papel emprestado", async () => {
    m.papel.mockResolvedValueOnce({ ok: true, user: usuario({ support: { status: "active", scope: "full" } }), org: { orgId: ORG, role: "admin" } });
    const r = await pedir();
    expect(r.status).toBe(403);
    expect((await r.json()).error.message).toBe("O envio ao prontuário é só da equipe da clínica.");
    nadaSaiu();
  });
});

describe("configuração", () => {
  it("desligada → 409 sem chamar nada", async () => {
    vi.stubEnv("PRONTUARIO_URL", "");
    vi.stubEnv("PRONTUARIO_EXAMES_SEGREDO", "");
    vi.stubEnv("PRONTUARIO_ORGANIZATION_ID", "");
    const r = await pedir();
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("prontuario_desligado");
    nadaSaiu();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("inválida → 502 prontuario_configuracao, logger.error e linha de falha", async () => {
    vi.stubEnv("PRONTUARIO_EXAMES_SEGREDO", "curto");
    const r = await pedir();
    expect(r.status).toBe(502);
    const corpo = await r.json();
    expect(corpo.error.code).toBe("prontuario_configuracao");
    expect(corpo.error.message).toBe("A integração com o Prontuário não está configurada. Avise o administrador.");
    expect(m.logError).toHaveBeenCalledWith("prontuario.exames.config_invalida", expect.objectContaining({ motivo: "segredo_curto" }));
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "prontuario.exam_send_failed", metadata: expect.objectContaining({ codigo: "config_segredo_curto" }),
    }));
    nadaSaiu();
  });
});

describe("checagem local", () => {
  it("id malformado → 422; mensagem invisível → 404; nada audita", async () => {
    expect((await pedir("x")).status).toBe(422);
    m.visivel.mockResolvedValueOnce({ data: null, error: null });
    expect((await pedir()).status).toBe(404);
    nadaSaiu();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("registro existente → 200 sem chamar o Prontuário e sem auditar", async () => {
    const existente = { message_id: MSG, ja_existia: false, enviado_em: "2026-11-01T00:00:00.000Z", enviado_por_user_id: USER };
    m.ler.mockResolvedValueOnce(existente);
    const r = await pedir();
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual(existente);
    nadaSaiu();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it.each([
    ["inelegível", null, 422, "fora_do_prontuario"],
    ["61 dias", midia({ sent_at: new Date(Date.now() - 61 * 24 * 3600 * 1000) }), 422, "fora_do_prontuario"],
    ["pendente", midia({ pendente: true, storage_path: null }), 409, "midia_ainda_nao_disponivel"],
    ["heic", midia({ mime: "image/heic" }), 422, "formato_nao_aceito"],
    ["10 MiB + 1", midia({ size_bytes: String(10 * 1024 * 1024 + 1) }), 422, "grande_demais"],
  ])("%s → %s %s, sem chamar e sem auditar", async (_n, linha, status, codigo) => {
    m.buscar.mockResolvedValueOnce(linha);
    const r = await pedir();
    expect(r.status).toBe(status);
    expect((await r.json()).error.code).toBe(codigo);
    nadaSaiu();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("pool indisponível → 500", async () => {
    m.buscar.mockRejectedValueOnce(new Error("SUPABASE_DB_URL ausente"));
    expect((await pedir()).status).toBe(500);
  });
});

describe("o envio", () => {
  it("caminho em maiúsculas → corpo e Idempotency-Key com o id do banco, em minúsculas", async () => {
    await pedir(MSG.toUpperCase());
    expect(m.buscar).toHaveBeenCalledWith(expect.anything(), { organizationId: ORG, messageId: MSG });
    const [, init] = m.fetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(MSG);
    expect(JSON.parse(init.body as string)).toEqual({ contact_id: CONTATO, message_id: MSG, enviado_por: "Atendente Fictícia" });
  });

  it("enviado_por aparado, até 120, e o padrão sem nome", async () => {
    m.papel.mockResolvedValueOnce({ ok: true, user: usuario({ full_name: `  ${"N".repeat(130)}  ` }), org: { orgId: ORG } });
    await pedir();
    expect(JSON.parse((m.fetch.mock.calls[0] as [string, RequestInit])[1].body as string).enviado_por).toBe("N".repeat(120));
    m.papel.mockResolvedValueOnce({ ok: true, user: usuario({ full_name: "   " }), org: { orgId: ORG } });
    await pedir();
    expect(JSON.parse((m.fetch.mock.calls[1] as [string, RequestInit])[1].body as string).enviado_por).toBe("Equipe da clínica");
  });

  it("sucesso: 201, grava, toca a mensagem, audita exam_sent SEM exam_id, resposta sem exam_id", async () => {
    const r = await pedir();
    expect(r.status).toBe(201);
    const corpo = await r.json();
    expect(corpo.data).toEqual({ message_id: MSG, ja_existia: false, enviado_em: "2026-11-04T12:00:00.000Z", enviado_por_user_id: USER });
    expect(JSON.stringify(corpo)).not.toContain(EXAME);
    expect(m.registrar).toHaveBeenCalledWith({ organizationId: ORG, messageId: MSG, examId: EXAME, jaExistia: false, userId: USER });
    expect(m.tocar).toHaveBeenCalledWith(ORG, MSG);
    expect(m.audit).toHaveBeenCalledWith({
      action: "prontuario.exam_sent", actorUserId: USER, organizationId: ORG, resourceType: "message", resourceId: MSG,
      requestId: expect.any(String), metadata: { contact_id: CONTATO, ja_existia: false },
    });
    expect(JSON.stringify(m.audit.mock.calls)).not.toContain(EXAME);
  });

  it("200 ja_existia → 200; 23505 (outro clique gravou) → 200", async () => {
    m.fetch.mockResolvedValueOnce(resp(200, { exam_id: EXAME, ja_existia: true }));
    expect((await pedir()).status).toBe(200);
    m.registrar.mockResolvedValueOnce({
      registro: { message_id: MSG, ja_existia: false, enviado_em: "2026-11-04T11:00:00.000Z", enviado_por_user_id: "outra" },
      novo: false,
    });
    const r = await pedir();
    expect(r.status).toBe(200);
    expect((await r.json()).data.enviado_por_user_id).toBe("outra");
  });

  const DESFECHOS: Array<[string, () => Response[], number, string, string, string]> = [
    ["paciente não vinculado", () => [erro(404, "paciente_nao_vinculado")], 409, "paciente_nao_vinculado",
      "Este contato ainda não está ligado a um paciente no Prontuário.",
      "Este contacto todavía no está vinculado a un paciente en la historia clínica."],
    ["vínculo não confirmado", () => [erro(409, "vinculo_nao_confirmado")], 409, "vinculo_nao_confirmado",
      "Este contato ainda não está confirmado no Prontuário. Peça para confirmar o vínculo lá.",
      "Este contacto aún no está confirmado en la historia clínica. Pida que confirmen el vínculo allí."],
    ["vários pacientes", () => [erro(409, "contato_com_varios_pacientes")], 409, "contato_com_varios_pacientes",
      "Este contato está ligado a mais de um paciente no Prontuário; corrija o vínculo lá.",
      "Este contacto está vinculado a más de un paciente en la historia clínica; corrija el vínculo allí."],
    ["mídia não encontrada", () => [erro(404, "midia_nao_encontrada")], 422, "midia_nao_encontrada",
      "O Prontuário não encontrou este arquivo na conversa. Se ele acabou de chegar, tente em instantes.",
      "La historia clínica no encontró este archivo en la conversación. Si acaba de llegar, intente en unos instantes."],
    ["formato", () => [erro(422, "formato_nao_aceito")], 422, "formato_nao_aceito",
      "O Prontuário aceita só PDF, JPG ou PNG. Peça ao paciente um PDF ou foto comum.",
      "La historia clínica solo acepta PDF, JPG o PNG. Pida al paciente un PDF o una foto común."],
    ["grande", () => [erro(413, "grande_demais")], 422, "grande_demais",
      "O arquivo passa de 10 MB, o limite do Prontuário.", "El archivo supera los 10 MB, el límite de la historia clínica."],
    ["401", () => [erro(401, "nao_autorizado")], 502, "prontuario_configuracao",
      "A integração com o Prontuário não está configurada. Avise o administrador.",
      "La integración con la historia clínica no está configurada. Avise al administrador."],
    ["429 do Prontuário", () => [erro(429, "limite_de_pedidos")], 502, "prontuario_indisponivel",
      "O Prontuário recebeu muitos envios agora. Tente em um minuto.",
      "La historia clínica recibió muchos envíos ahora. Intente en un minuto."],
    ["503 crm_indisponivel duas vezes", () => [erro(503, "crm_indisponivel"), erro(503, "crm_indisponivel")], 502, "prontuario_sem_acesso_ao_crm",
      "O Prontuário não conseguiu buscar o arquivo no CRM. Tente de novo em instantes.",
      "La historia clínica no pudo obtener el archivo del CRM. Intente de nuevo en unos instantes."],
    ["503 duas vezes", () => [erro(503, "indisponivel"), erro(503, "indisponivel")], 502, "prontuario_indisponivel",
      "O Prontuário não respondeu. Tente de novo em instantes.", "La historia clínica no respondió. Intente de nuevo en unos instantes."],
  ];

  it.each(DESFECHOS)("%s → %s %s, frase em pt e es, linha de falha", async (_n, respostas, status, codigo, pt, es) => {
    for (const [idioma, fraseEsperada] of [["pt-BR", pt], ["es", es]] as const) {
      vi.clearAllMocks();
      m.papel.mockResolvedValue({ ok: true, user: usuario({ idioma }), org: { orgId: ORG } });
      for (const r of respostas()) m.fetch.mockResolvedValueOnce(r);
      const r = await pedir();
      expect(r.status).toBe(status);
      expect([429, 503]).not.toContain(r.status);
      const corpo = await r.json();
      expect(corpo.error).toMatchObject({ code: codigo, message: fraseEsperada });
      expect(JSON.stringify(corpo)).not.toContain("texto que não pode vazar");
      expect(m.registrar).not.toHaveBeenCalled();
      expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
        action: "prontuario.exam_send_failed", resourceId: MSG,
        metadata: expect.objectContaining({ contact_id: CONTATO, codigo, tentativas: respostas().length }),
      }));
    }
  });

  it("sem resposta → 502 e a linha de falha diz sem_resposta", async () => {
    m.fetch.mockRejectedValue(new TypeError("fetch failed"));
    const r = await pedir();
    expect(r.status).toBe(502);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "prontuario.exam_send_failed",
      metadata: expect.objectContaining({ codigo: "sem_resposta", status_do_prontuario: null, tentativas: 2 }),
    }));
  });
});
