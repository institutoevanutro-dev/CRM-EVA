/**
 * `GET`/`PUT /api/v1/comentarios/frases` — as frases de abertura de conversa
 * no Direct.
 *
 * O que estes testes protegem, e por quê:
 *
 *  1. Ler é `agent`, escrever é `manager` — mesmos pisos de
 *     `instagram_comments` e `instagram_comment_rules_write` (migration 0280).
 *  2. A escrita passa pela FUNÇÃO (`fn_definir_frases_de_comentario`), nunca
 *     por `.update({ settings })`. Um read-modify-write naquele jsonb já
 *     apagou `visibility_mode` em silêncio, e essa chave é lida pela RLS.
 *  3. Campo em branco volta ao padrão na LEITURA, e vai em branco para o
 *     banco — gravar o padrão congelaria a frase de hoje em quem só queria a
 *     de fábrica.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { fail } from "@/lib/api/wrappers";
import { FRASES_PADRAO } from "@/lib/comentarios/gatilho-direct";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const auditSpy = vi.fn(async (_arg: Record<string, unknown>) => undefined);
vi.mock("@/lib/audit", () => ({ audit: (arg: unknown) => auditSpy(arg as Record<string, unknown>) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { GET, PUT } = await import("@/app/api/v1/comentarios/frases/route");

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const USUARIO = "dddddddd-0000-4000-8000-000000000001";

let settingsNoBanco: Record<string, unknown> | null;
let chamadasDeRpc: Array<{ nome: string; args: Record<string, unknown> }>;
let updatesDiretos: number;
let linhasAfetadas: number;

function liberarPapel() {
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG },
    user: { id: USUARIO, idioma: "pt" },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsNoBanco = {};
  chamadasDeRpc = [];
  updatesDiretos = 0;
  linhasAfetadas = 1;
  liberarPapel();

  vi.mocked(createClient).mockResolvedValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { settings: settingsNoBanco }, error: null }),
        }),
      }),
      update: () => {
        updatesDiretos++;
        return { eq: async () => ({ error: null }) };
      },
    }),
  } as never);

  vi.mocked(createAdminClient).mockReturnValue({
    async rpc(nome: string, args: Record<string, unknown>) {
      chamadasDeRpc.push({ nome, args });
      return { data: linhasAfetadas, error: null };
    },
    from: () => ({
      update: () => {
        updatesDiretos++;
        return { eq: async () => ({ error: null }) };
      },
    }),
  } as never);
});

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/comentarios/frases", {
    method: "PUT",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

describe("GET", () => {
  it("organização sem nada configurado recebe CAMPO VAZIO, com o padrão ao lado", async () => {
    // Esta expectativa já esteve invertida, e o e2e é que pegou: devolvendo o
    // padrão como VALOR, o campo da tela nasce preenchido e o primeiro Salvar
    // congela a frase de fábrica de hoje dentro da organização.
    const corpo = await (await GET()).json();
    expect(corpo.data.frases).toEqual({ preco: "", agendamento: "" });
    expect(corpo.data.padrao).toEqual(FRASES_PADRAO);
  });

  it("devolve o que a organização configurou, e o padrão ao lado para a tela mostrar", async () => {
    settingsNoBanco = { comentarios: { preco: "Oi! Qual seu objetivo?" } };

    const corpo = await (await GET()).json();

    expect(corpo.data.frases.preco).toBe("Oi! Qual seu objetivo?");
    expect(corpo.data.frases.agendamento).toBe("");
    expect(corpo.data.padrao).toEqual(FRASES_PADRAO);
  });

  it("exige papel de leitura", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden_role", "não", 403),
    } as never);

    expect((await GET()).status).toBe(403);
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("agent");
  });
});

describe("PUT", () => {
  it("grava pela FUNÇÃO, nunca por update direto no jsonb da organização", async () => {
    const res = await PUT(pedido({ preco: "Oi! O que você busca?", agendamento: "Oi! Quando?" }));

    expect(res.status).toBe(200);
    expect(updatesDiretos).toBe(0);
    expect(chamadasDeRpc).toEqual([
      {
        nome: "fn_definir_frases_de_comentario",
        args: {
          p_org: ORG,
          p_actor: USUARIO,
          p_frases: { preco: "Oi! O que você busca?", agendamento: "Oi! Quando?" },
        },
      },
    ]);
  });

  it("escrever exige manager, não agent", async () => {
    await PUT(pedido({ preco: "a", agendamento: "b" }));
    expect(vi.mocked(requireRole).mock.calls[0]![0]).toBe("manager");
  });

  it("campo em branco vai em branco para o banco e volta como padrão na resposta", async () => {
    const res = await PUT(pedido({ preco: "", agendamento: "  " }));
    const corpo = await res.json();

    expect(chamadasDeRpc[0]!.args.p_frases).toEqual({ preco: "", agendamento: "" });
    expect(corpo.data.frases).toEqual({ preco: "", agendamento: "" });
  });

  it("organização que não existe é 404, não 200 silencioso", async () => {
    linhasAfetadas = 0;

    const res = await PUT(pedido({ preco: "a", agendamento: "b" }));

    expect(res.status).toBe(404);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("a trilha registra quem mudou, sem o texto", async () => {
    await PUT(pedido({ preco: "segredo comercial", agendamento: "outro" }));

    const entrada = auditSpy.mock.calls[0]![0];
    expect(entrada.action).toBe("comment.frases_updated");
    expect(entrada.organizationId).toBe(ORG);
    expect(JSON.stringify(entrada)).not.toContain("segredo comercial");
  });

  it("texto absurdamente longo é recusado antes de chegar ao banco", async () => {
    const res = await PUT(pedido({ preco: "x".repeat(1001), agendamento: "b" }));

    expect(res.status).toBe(422);
    expect(chamadasDeRpc).toEqual([]);
  });
});
