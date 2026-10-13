// @vitest-environment node
//
// A rota de exportação da conversa em PDF. `requireRole` roda DE VERDADE (só o
// que ele consulta é falso), para o papel ser medido na regra da casa e não num
// mock que devolve o que o teste quer. O PDF é lido de dentro do arquivo.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { extractPdfText } from "@/lib/ai/rag/extractors/pdf";
import { LIMITE_DE_MENSAGENS } from "@/lib/conversas/exporta-pdf";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONV_A = "33333333-3333-4333-8333-333333333333";
const CONV_B = "55555555-5555-4555-8555-555555555555";
const CONTATO_A = "44444444-4444-4444-8444-444444444444";
const ANA = "11111111-1111-4111-8111-111111111111";

type Linha = Record<string, unknown>;

const estado = vi.hoisted(() => ({
  usuario: null as Record<string, unknown> | null,
  papel: "agent" as string | null,
  tabelas: {} as Record<string, Record<string, unknown>[]>,
  /** Simula a RLS: conversas que a sessão NÃO enxerga. */
  invisiveis: new Set<string>(),
  tabelasLidas: [] as string[],
  auditadas: [] as Record<string, unknown>[],
  limite: [] as Array<{ allowed: boolean; count: number; limit: number; window_sec: number }>,
}));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/audit", () => ({
  audit: async (e: Record<string, unknown>) => void estado.auditadas.push(e),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => estado.usuario,
  resolveActiveOrg: async () => ({ orgId: ORG_A, name: "Clínica A", role: estado.papel ?? "viewer" }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: async () => new Map([[ANA, "Ana Souza"]]),
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => estado.limite.shift() ?? { allowed: true, count: 1, limit: 5, window_sec: 60 }),
}));
vi.mock("@/lib/branding/saida", async (original) => ({
  ...(await original<typeof import("@/lib/branding/saida")>()),
  marcaDaSaida: async () => ({ nome: "Marca", logoUrl: null, accent: "#0f766e", accentFg: "#ffffff", origens: { nome: "padrao", cor: "padrao" } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async () => ({ data: estado.papel, error: null }),
    from: (tabela: string) => {
      estado.tabelasLidas.push(tabela);
      const filtros: Array<[string, unknown]> = [];
      let limite: number | null = null;
      const linhas = (): Linha[] => {
        let saida = (estado.tabelas[tabela] ?? []).filter((l) => filtros.every(([c, v]) => l[c] === v));
        if (tabela === "conversations") saida = saida.filter((l) => !estado.invisiveis.has(String(l.id)));
        if (tabela === "messages") {
          saida = saida
            .filter((l) => !estado.invisiveis.has(String(l.conversation_id)))
            .sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)));
        }
        return limite === null ? saida : saida.slice(0, limite);
      };
      const cadeia = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => (filtros.push([coluna, valor]), cadeia),
        order: () => cadeia,
        limit: (n: number) => ((limite = n), cadeia),
        maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
        then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
          Promise.resolve({ data: linhas(), error: null }).then(ok, falha),
      };
      return cadeia;
    },
  }),
}));

import { GET } from "./route";

function mensagem(id: string, minuto: number, parcial: Linha = {}): Linha {
  const quando = new Date(Date.parse("2026-09-01T12:00:00.000Z") + minuto * 60_000).toISOString();
  return {
    id,
    organization_id: ORG_A,
    conversation_id: CONV_A,
    direction: "inbound",
    type: "text",
    status: "received",
    body: `mensagem ${id}`,
    sent_via: "external_device",
    sent_by_user_id: null,
    sent_at: quando,
    created_at: quando,
    metadata: {},
    ...parcial,
  };
}

function semear(): void {
  estado.tabelas = {
    organizations: [
      { id: ORG_A, legal_name: "Clínica A LTDA", display_name: "Clínica A", timezone: "America/Sao_Paulo" },
      { id: ORG_B, legal_name: "Clínica B LTDA", display_name: "Clínica B", timezone: "America/Sao_Paulo" },
    ],
    conversations: [
      { id: CONV_A, organization_id: ORG_A, contact_id: CONTATO_A, channel: "whatsapp" },
      { id: CONV_B, organization_id: ORG_B, contact_id: "c-b", channel: "whatsapp" },
    ],
    contacts: [
      { id: CONTATO_A, organization_id: ORG_A, name: "José da Silva", display_name: null, phone_number: "+5527999990000", cpf_cifrado: "NAO-PODE-SAIR" },
      { id: "c-b", organization_id: ORG_B, name: "Paciente da Outra Clínica", display_name: null, phone_number: null },
    ],
    messages: [
      mensagem("m1", 0, { body: "Estou com dor de cabeça" }),
      mensagem("m2", 2, { direction: "outbound", sent_via: "ai", status: "sent", body: "Posso ajudar a agendar", metadata: { ai_actor_id: "a", tool_calls: ["crm_segredo"] } }),
      mensagem("m3", 5, { direction: "outbound", sent_via: "user", sent_by_user_id: ANA, status: "read", body: "Consulta marcada" }),
      mensagem("mb", 1, { organization_id: ORG_B, conversation_id: CONV_B, body: "Segredo da outra clínica" }),
    ],
    conversation_notes: [
      { id: "n1", organization_id: ORG_A, conversation_id: CONV_A, body: "NOTA INTERNA: paciente difícil" },
    ],
  };
}

const chamar = (id = CONV_A, query = "formato=pdf") =>
  GET(new NextRequest(`http://localhost/api/v1/conversations/${id}/export?${query}`), {
    params: Promise.resolve({ id }),
  });
const tick = () => new Promise((r) => setTimeout(r, 0));
const textoDoPdf = async (res: Response) =>
  (await extractPdfText(Buffer.from(await res.arrayBuffer()))).replace(/\s+/g, " ");

beforeEach(() => {
  estado.usuario = { id: ANA, idioma: "pt-BR", full_name: "Ana Souza", email: "ana@clinica.test", organizations: [], is_platform_admin: false };
  estado.papel = "agent";
  estado.invisiveis = new Set();
  estado.tabelasLidas = [];
  estado.auditadas = [];
  estado.limite = [];
  semear();
});

describe("GET /api/v1/conversations/[id]/export: quem pode", () => {
  it("sem sessão: 401, e nada é lido", async () => {
    estado.usuario = null;
    const res = await chamar();
    expect(res.status).toBe(401);
    expect(estado.tabelasLidas).toEqual([]);
  });

  it.each(["viewer", "provider", null])("papel %s não leva o arquivo: 403, sem ler conversa nem auditar exportação", async (papel) => {
    estado.papel = papel;
    const res = await chamar();
    expect(res.status).toBe(403);
    expect(estado.tabelasLidas).toEqual([]);
    await tick();
    expect(estado.auditadas.filter((a) => a.action === "conversation.exported")).toEqual([]);
  });

  it.each(["agent", "manager", "admin"])("papel %s exporta", async (papel) => {
    estado.papel = papel;
    expect((await chamar()).status).toBe(200);
  });

  it("sessão de acompanhamento do suporte não exporta, mesmo com acesso total", async () => {
    estado.usuario = { ...estado.usuario, support: { id: "s", status: "active", access_mode: "full", organization_id: ORG_A, name: "Clínica A" } };
    const res = await chamar();
    expect(res.status).toBe(403);
    expect(estado.tabelasLidas).toEqual([]);
  });
});

describe("GET /api/v1/conversations/[id]/export: qual conversa", () => {
  it("conversa de OUTRA organização: 404, nada dela sai e nada é auditado", async () => {
    const res = await chamar(CONV_B);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("Segredo da outra clínica");
    await tick();
    expect(estado.auditadas).toEqual([]);
  });

  it("conversa que a sessão não enxerga (RLS de visibilidade): 404", async () => {
    estado.invisiveis.add(CONV_A);
    const res = await chamar();
    expect(res.status).toBe(404);
    expect(estado.tabelasLidas).toEqual(["conversations"]);
    await tick();
    expect(estado.auditadas).toEqual([]);
  });

  it("id que não é uuid: 404; formato desconhecido: 422; nenhum dos dois lê o banco", async () => {
    expect((await chamar("nao-e-uuid")).status).toBe(404);
    expect((await chamar(CONV_A, "formato=csv")).status).toBe(422);
    expect(estado.tabelasLidas).toEqual([]);
  });
});

describe("GET /api/v1/conversations/[id]/export: o que sai", () => {
  it("devolve um PDF baixável com as mensagens, autores e horário da organização", async () => {
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="historico-conversa-jose-da-silva-\d{4}-\d{2}-\d{2}\.pdf"$/,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get("X-Export-Truncated")).toBe("0");

    const bytes = Buffer.from(await res.clone().arrayBuffer());
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");

    const texto = await textoDoPdf(res);
    expect(texto).toContain("Clínica A");
    expect(texto).toContain("José da Silva · 01/09/2026 09:00 · recebida");
    expect(texto).toContain("Estou com dor de cabeça");
    expect(texto).toContain("Assistente virtual (IA) · 01/09/2026 09:02 · enviada");
    expect(texto).toContain("Ana Souza (equipe) · 01/09/2026 09:05 · enviada");
    expect(texto).toContain("Exportado por: Ana Souza em");
  });

  it("nota interna NÃO sai: a tabela nem é consultada", async () => {
    const res = await chamar();
    expect(estado.tabelasLidas).not.toContain("conversation_notes");
    expect([...new Set(estado.tabelasLidas)].sort()).toEqual(["contacts", "conversations", "messages", "organizations"]);
    const texto = await textoDoPdf(res);
    expect(texto).not.toContain("NOTA INTERNA");
    expect(texto).not.toContain("paciente difícil");
  });

  it("dado interno da IA e campo cifrado do contato não saem", async () => {
    const texto = await textoDoPdf(await chamar());
    expect(texto).not.toContain("crm_segredo");
    expect(texto).not.toContain("NAO-PODE-SAIR");
    expect(texto).not.toContain("Segredo da outra clínica");
  });

  it("contato anonimizado sai com o rótulo anônimo, no documento e no nome do arquivo", async () => {
    estado.tabelas.contacts = [
      { id: CONTATO_A, organization_id: ORG_A, name: "Cliente Anonimizado #7", display_name: "Cliente Anonimizado #7", phone_number: null },
    ];
    estado.tabelas.messages = estado.tabelas.messages!.map((m) => ({ ...m, body: "[mensagem anonimizada]" }));
    const res = await chamar();
    expect(res.headers.get("Content-Disposition")).toContain("historico-conversa-cliente-anonimizado-7-");
    const texto = await textoDoPdf(res);
    expect(texto).toContain("Cliente Anonimizado #7");
    expect(texto).not.toContain("José");
    expect(texto).not.toContain("99999");
    expect(texto).not.toContain("dor de cabeça");
  });
});

describe("GET /api/v1/conversations/[id]/export: auditoria", () => {
  it("uma linha por exportação, com quem, qual conversa e contagem, sem texto de mensagem", async () => {
    await chamar();
    await tick();
    expect(estado.auditadas).toHaveLength(1);
    expect(estado.auditadas[0]).toEqual({
      action: "conversation.exported",
      actorUserId: ANA,
      organizationId: ORG_A,
      resourceType: "conversation",
      resourceId: CONV_A,
      requestId: expect.any(String),
      metadata: { mensagens: 3, formato: "pdf", truncada: false, acesso: "leitura" },
    });
    expect(JSON.stringify(estado.auditadas[0])).not.toMatch(/dor de cabeça|José|99999/);
  });
});

describe("GET /api/v1/conversations/[id]/export: limites", () => {
  it("além do teto da pessoa: 429 com Retry-After, sem gastar o da organização nem ler o banco", async () => {
    estado.limite = [{ allowed: false, count: 6, limit: 5, window_sec: 60 }];
    const res = await chamar();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(estado.tabelasLidas).toEqual([]);
    await tick();
    expect(estado.auditadas).toEqual([]);
  });

  it("pessoa dentro do teto e organização fora: 429 pelo teto da organização", async () => {
    estado.limite = [
      { allowed: true, count: 1, limit: 5, window_sec: 60 },
      { allowed: false, count: 21, limit: 20, window_sec: 60 },
    ];
    const res = await chamar();
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("20");
    expect(estado.tabelasLidas).toEqual([]);
  });

  it("dois pedidos ao mesmo tempo: um gera, o outro recebe 429 em vez de dobrar a memória", async () => {
    const [a, b] = await Promise.all([chamar(), chamar()]);
    expect([a.status, b.status].sort()).toEqual([200, 429]);
    // O que foi recusado não deixa o contador preso: o próximo passa.
    expect((await chamar()).status).toBe(200);
  });

  it("exatamente no limite sai inteira; uma a mais, sai cortada, avisada, com as mais recentes", async () => {
    const com = (n: number) => {
      estado.tabelas.messages = Array.from({ length: n }, (_, i) => mensagem(`g${String(i).padStart(4, "0")}`, i, { body: `linha numero ${i} fim` }));
    };

    com(LIMITE_DE_MENSAGENS);
    const inteira = await chamar();
    expect(inteira.headers.get("X-Export-Truncated")).toBe("0");
    expect(await textoDoPdf(inteira)).not.toContain("passa do limite");

    estado.auditadas = [];
    com(LIMITE_DE_MENSAGENS + 1);
    const cortada = await chamar();
    expect(cortada.status).toBe(200);
    expect(cortada.headers.get("X-Export-Truncated")).toBe("1");
    const texto = await textoDoPdf(cortada);
    expect(texto).toContain(`passa do limite de ${LIMITE_DE_MENSAGENS} mensagens`);
    expect(texto).toContain(`linha numero ${LIMITE_DE_MENSAGENS} fim`);
    expect(texto).not.toContain("linha numero 0 fim");
    await tick();
    expect(estado.auditadas[0]).toMatchObject({ metadata: { mensagens: LIMITE_DE_MENSAGENS, truncada: true } });
  }, 120_000);
});
