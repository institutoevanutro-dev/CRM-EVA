/**
 * `GET`/`POST /api/v1/comentarios/vocabulario` — as palavras que o dono libera
 * para a IA usar sozinha.
 *
 * O que estes testes protegem:
 *  1. Ler é `agent`, decidir é `manager`.
 *  2. A palavra é guardada NORMALIZADA (minúscula, sem acento): fora dessa
 *     forma ela nunca casa com o token da trava e a feature morre calada.
 *  3. A rota RECONFERE o gatilho: um POST à mão não libera "custa".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

const auditSpy = vi.fn(async (_arg: Record<string, unknown>) => undefined);
vi.mock("@/lib/audit", () => ({ audit: (arg: unknown) => auditSpy(arg as Record<string, unknown>) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { GET, POST } = await import("@/app/api/v1/comentarios/vocabulario/route");

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const USUARIO = "dddddddd-0000-4000-8000-000000000001";

let comentariosRespondidos: string[];
let decididasNoBanco: Array<{ palavra: string; aprovada: boolean }>;
let upserts: Array<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  comentariosRespondidos = [];
  decididasNoBanco = [];
  upserts = [];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG },
    user: { id: USUARIO, idioma: "pt" },
  } as never);

  vi.mocked(createClient).mockResolvedValue({
    from: (tabela: string) => ({
      select: () => ({
        eq: () => {
          if (tabela === "instagram_comment_vocabulario") {
            return { order: async () => ({ data: decididasNoBanco, error: null }) };
          }
          return {
            eq: () => ({
              order: () => ({
                limit: async () => ({
                  data: comentariosRespondidos.map((texto) => ({ texto })),
                  error: null,
                }),
              }),
            }),
          };
        },
      }),
      upsert: async (linha: Record<string, unknown>) => {
        upserts.push(linha);
        return { error: null };
      },
    }),
  } as never);
});

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/comentarios/vocabulario", {
    method: "POST",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

describe("GET", () => {
  it("devolve candidatos calculados da fila e o que já foi decidido", async () => {
    comentariosRespondidos = ["conteudo fantastico", "fantastico"];
    decididasNoBanco = [{ palavra: "didatico", aprovada: true }];

    const corpo = await (await GET()).json();

    expect(corpo.data.candidatos).toEqual([{ palavra: "fantastico", vezes: 2 }]);
    expect(corpo.data.decididas).toEqual([{ palavra: "didatico", aprovada: true }]);
  });

  it("palavra já decidida não volta como candidato", async () => {
    comentariosRespondidos = ["fantastico demais"];
    decididasNoBanco = [{ palavra: "fantastico", aprovada: false }];

    const corpo = await (await GET()).json();

    expect(corpo.data.candidatos).toEqual([]);
  });

  it("ler exige agent", async () => {
    await GET();
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("agent");
  });
});

describe("POST", () => {
  it("grava a decisão com a palavra normalizada", async () => {
    const res = await POST(pedido({ palavra: "  Didático  ", aprovada: true }));

    expect(res.status).toBe(200);
    expect(upserts[0]).toMatchObject({ palavra: "didatico", aprovada: true, organization_id: ORG });
  });

  it("escrever exige manager", async () => {
    await POST(pedido({ palavra: "didatico", aprovada: true }));
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
  });

  // Global Constraint: o dono não pode liberar gatilho nem pela rota.
  it("RECUSA palavra de gatilho, mesmo vinda direto na rota", async () => {
    const res = await POST(pedido({ palavra: "custa", aprovada: true }));

    expect(res.status).toBe(422);
    expect(upserts).toEqual([]);
  });

  // A ordem normalizar -> gatilho é o que impede liberar "Custa" ou "Nutrólogo"
  // pela forma crua. Sem estes dois, trocar `palavra` por `parsed.data.palavra`
  // na checagem deixa a suíte inteira verde e abre a trava.
  it("RECUSA palavra de gatilho com maiúscula, porque normaliza ANTES de checar", async () => {
    const res = await POST(pedido({ palavra: "Custa", aprovada: true }));
    expect(res.status).toBe(422);
    expect(upserts).toEqual([]);
  });

  it("RECUSA palavra de gatilho com acento e espaços, pelo mesmo motivo", async () => {
    const res = await POST(pedido({ palavra: "  Nutrólogo ", aprovada: true }));
    expect(res.status).toBe(422);
    expect(upserts).toEqual([]);
  });

  it("recusa palavra vazia e palavra com espaço no meio", async () => {
    expect((await POST(pedido({ palavra: "  ", aprovada: true }))).status).toBe(422);
    expect((await POST(pedido({ palavra: "duas palavras", aprovada: true }))).status).toBe(422);
  });

  it("a trilha registra quem decidiu, a palavra e a decisão", async () => {
    await POST(pedido({ palavra: "didatico", aprovada: true }));

    const e = auditSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(e.action).toBe("comment.vocabulary_decided");
    expect(e.metadata).toMatchObject({ palavra: "didatico", aprovada: true });
  });
});
