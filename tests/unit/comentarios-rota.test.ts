/**
 * `POST /api/v1/comentarios/:id/publicar` e `POST /api/v1/comentarios/regras`
 * (Task 8 de 9 — "comentários no CRM"). Duas coisas que o RLS já garante mas a
 * doutrina do repo pede conferidas de novo na rota, explicitamente:
 *
 *  1. Publicar exige papel `agent+` (mesmo piso de `instagram_comments_write`,
 *     migration 0279); criar regra exige `manager+`
 *     (`instagram_comment_rules_write`).
 *  2. A organização do RECURSO é filtrada explicitamente — um comentário de
 *     OUTRA organização não é alcançado só porque o id bateu.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { fail } from "@/lib/api/wrappers";

const auditSpy = vi.fn(async () => undefined);
const responderComentarioSpy = vi.fn(async () => ({ replyId: "reply-1" }));

vi.mock("@/lib/audit", () => ({ audit: auditSpy }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/channels", async (original) => {
  const real = await original<typeof import("@/lib/channels")>();
  return {
    ...real,
    getAdapter: vi.fn(() => ({
      responderComentario: responderComentarioSpy,
      codes: { notConfigured: "x_nao_configurado", sendFailed: "x_erro_de_envio", unknownError: "x_erro" },
    })),
  };
});

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const OUTRA_ORG = "aaaaaaaa-0000-4000-8000-000000000002";
const COMENTARIO_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const SESSAO_ID = "cccccccc-0000-4000-8000-000000000001";
const USUARIO = "dddddddd-0000-4000-8000-000000000001";

interface LinhaComentario {
  id: string;
  organization_id: string;
  situacao: string;
  external_id: string;
  channel_session_id: string | null;
  media_id?: string;
  comentado_em?: string;
}

interface EstadoFake {
  comentarios: LinhaComentario[];
  sessoes: Array<{ id: string; organization_id: string; provider: string; ig_account_id: string }>;
  atualizacoes: Array<Record<string, unknown>>;
  insercoesDeRegra: Array<Record<string, unknown>>;
}

function clienteFalso(estado: EstadoFake): unknown {
  return {
    from(tabela: string) {
      if (tabela === "instagram_comments") {
        const filtros: Array<[string, unknown]> = [];
        let patch: Record<string, unknown> | null = null;
        const cadeia = {
          select: () => cadeia,
          update: (p: Record<string, unknown>) => {
            patch = p;
            return cadeia;
          },
          eq: (col: string, val: unknown) => {
            filtros.push([col, val]);
            return cadeia;
          },
          not: (col: string, _op: string, val: unknown) => {
            filtros.push([`not_${col}`, val]);
            return cadeia;
          },
          order: () => cadeia,
          limit: () => cadeia,
          maybeSingle: async () => {
            const porId = filtros.find(([c]) => c === "id")?.[1];
            const porOrg = filtros.find(([c]) => c === "organization_id")?.[1];
            const porMidia = filtros.find(([c]) => c === "media_id")?.[1];
            if (patch) {
              // update — casa por id + organization_id, como a rota faz.
              const alvo = estado.comentarios.find(
                (c) => c.id === porId && c.organization_id === porOrg,
              );
              if (!alvo) return { data: null, error: null };
              Object.assign(alvo, patch);
              estado.atualizacoes.push({ id: alvo.id, ...patch });
              return { data: { id: alvo.id, situacao: alvo.situacao, resposta_publica_id: alvo.channel_session_id }, error: null };
            }
            if (porMidia !== undefined) {
              // resolução do canal por mídia (rota de regras)
              const linha = estado.comentarios
                .filter((c) => c.organization_id === porOrg && c.media_id === porMidia && c.channel_session_id)
                .at(0);
              return { data: linha ? { channel_session_id: linha.channel_session_id } : null, error: null };
            }
            // leitura por id + organization_id (rota de publicar)
            const achado = estado.comentarios.find(
              (c) => c.id === porId && c.organization_id === porOrg,
            );
            return { data: achado ?? null, error: null };
          },
        };
        return cadeia;
      }
      if (tabela === "channel_sessions") {
        const filtros: Array<[string, unknown]> = [];
        const cadeia = {
          select: () => cadeia,
          eq: (col: string, val: unknown) => {
            filtros.push([col, val]);
            return cadeia;
          },
          maybeSingle: async () => {
            const porId = filtros.find(([c]) => c === "id")?.[1];
            const porOrg = filtros.find(([c]) => c === "organization_id")?.[1];
            const achado = estado.sessoes.find((s) => s.id === porId && s.organization_id === porOrg);
            return { data: achado ?? null, error: null };
          },
        };
        return cadeia;
      }
      if (tabela === "instagram_comment_rules") {
        let linha: Record<string, unknown> | null = null;
        const cadeia = {
          insert: (row: Record<string, unknown>) => {
            linha = row;
            estado.insercoesDeRegra.push(row);
            return cadeia;
          },
          select: () => cadeia,
          single: async () => ({
            data: linha ? { id: "regra-1", ...linha } : null,
            error: null,
          }),
        };
        return cadeia;
      }
      throw new Error(`tabela inesperada no fake: ${tabela}`);
    },
  };
}

function estadoPadrao(): EstadoFake {
  return {
    comentarios: [
      {
        id: COMENTARIO_ID,
        organization_id: ORG,
        situacao: "esperando_voce",
        external_id: "ext-1",
        channel_session_id: SESSAO_ID,
        media_id: "midia-1",
        comentado_em: "2026-09-26T10:00:00.000Z",
      },
    ],
    sessoes: [{ id: SESSAO_ID, organization_id: ORG, provider: "meta_instagram", ig_account_id: "ig-1" }],
    atualizacoes: [],
    insercoesDeRegra: [],
  };
}

function autorizacaoOk(role: "agent" | "manager" | "admin" = "agent") {
  return {
    ok: true as const,
    user: {
      id: USUARIO,
      email: "agente@example.com",
      full_name: null,
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR" as const,
      organizations: [{ organization_id: ORG, organization_name: "Org", role }],
    },
    org: { orgId: ORG, name: "Org", role },
  };
}

function negado() {
  return {
    ok: false as const,
    response: fail("forbidden_role", "Sem permissão.", 403, {}),
  };
}

function pedido(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/comentarios/${COMENTARIO_ID}/publicar`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function publicar(estado: EstadoFake, body: unknown = { texto: "Chame no Direct!" }) {
  vi.mocked(createClient).mockResolvedValue(clienteFalso(estado) as never);
  const { POST } = await import("@/app/api/v1/comentarios/[id]/publicar/route");
  return POST(pedido(body), { params: Promise.resolve({ id: COMENTARIO_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  responderComentarioSpy.mockClear();
  responderComentarioSpy.mockResolvedValue({ replyId: "reply-1" });
});

describe("POST /api/v1/comentarios/:id/publicar — exige papel agent+", () => {
  it("pede requireRole com o mínimo 'agent'", async () => {
    vi.mocked(requireRole).mockResolvedValue(autorizacaoOk("agent"));
    await publicar(estadoPadrao());
    expect(requireRole).toHaveBeenCalledWith("agent", expect.objectContaining({ resource: "instagram_comments" }));
  });

  it("papel insuficiente (viewer/agent negado pelo gate): a rota devolve a resposta 403 do gate, sem publicar nada", async () => {
    vi.mocked(requireRole).mockResolvedValue(negado());
    const res = await publicar(estadoPadrao());
    expect(res.status).toBe(403);
    expect(responderComentarioSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/comentarios/:id/publicar — organização do comentário é conferida", () => {
  it("comentário existe, mas em OUTRA organização: 404, não vaza entre tenants", async () => {
    vi.mocked(requireRole).mockResolvedValue(autorizacaoOk("agent"));
    const estado = estadoPadrao();
    estado.comentarios[0]!.organization_id = OUTRA_ORG;
    const res = await publicar(estado);
    expect(res.status).toBe(404);
    expect(responderComentarioSpy).not.toHaveBeenCalled();
  });

  it("comentário na própria organização, esperando_voce: publica, grava o desfecho e audita", async () => {
    vi.mocked(requireRole).mockResolvedValue(autorizacaoOk("agent"));
    const estado = estadoPadrao();
    const res = await publicar(estado, { texto: "Te chamamos no Direct!" });

    expect(res.status).toBe(200);
    expect(responderComentarioSpy).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, sessionRef: "ig-1", commentId: "ext-1", texto: "Te chamamos no Direct!" }),
    );
    expect(estado.comentarios[0]!.situacao).toBe("respondido_manualmente");
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "comment.replied_manually", organizationId: ORG, resourceId: COMENTARIO_ID }),
    );
  });

  it("comentário que já saiu de esperando_voce (outro clique venceu a corrida): 409, sem publicar de novo", async () => {
    vi.mocked(requireRole).mockResolvedValue(autorizacaoOk("agent"));
    const estado = estadoPadrao();
    estado.comentarios[0]!.situacao = "respondido_manualmente";
    const res = await publicar(estado);
    expect(res.status).toBe(409);
    expect(responderComentarioSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/comentarios/regras — exige papel manager+", () => {
  async function criarRegra(estado: EstadoFake, body: Record<string, unknown>) {
    vi.mocked(createClient).mockResolvedValue(clienteFalso(estado) as never);
    const { POST } = await import("@/app/api/v1/comentarios/regras/route");
    return POST(
      new NextRequest("http://localhost/api/v1/comentarios/regras", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("pede requireRole com o mínimo 'manager'", async () => {
    vi.mocked(requireRole).mockResolvedValue(autorizacaoOk("manager"));
    await criarRegra(estadoPadrao(), {
      media_id: "midia-1",
      palavra: "preço",
      texto_do_direct: "O valor é R$150.",
      frase_publica: "Te chamamos no Direct!",
    });
    expect(requireRole).toHaveBeenCalledWith(
      "manager",
      expect.objectContaining({ resource: "instagram_comment_rules" }),
    );
  });

  it("agent (abaixo de manager) negado pelo gate: nenhuma regra é inserida", async () => {
    vi.mocked(requireRole).mockResolvedValue(negado());
    const estado = estadoPadrao();
    const res = await criarRegra(estado, {
      media_id: "midia-1",
      palavra: "preço",
      texto_do_direct: "x",
      frase_publica: "y",
    });
    expect(res.status).toBe(403);
    expect(estado.insercoesDeRegra).toHaveLength(0);
  });

  it("mídia sem nenhum comentário na organização: 422, não cria regra órfã de canal", async () => {
    vi.mocked(requireRole).mockResolvedValue(autorizacaoOk("manager"));
    const estado = estadoPadrao();
    const res = await criarRegra(estado, {
      media_id: "midia-nunca-vista",
      palavra: "preço",
      texto_do_direct: "x",
      frase_publica: "y",
    });
    expect(res.status).toBe(422);
    expect(estado.insercoesDeRegra).toHaveLength(0);
  });

  it("mídia com comentário na organização: cria a regra com o channel_session_id resolvido, e audita", async () => {
    vi.mocked(requireRole).mockResolvedValue(autorizacaoOk("manager"));
    const estado = estadoPadrao();
    const res = await criarRegra(estado, {
      media_id: "midia-1",
      palavra: "preço",
      texto_do_direct: "O valor é R$150.",
      frase_publica: "Te chamamos no Direct!",
    });
    expect(res.status).toBe(201);
    expect(estado.insercoesDeRegra).toEqual([
      expect.objectContaining({
        organization_id: ORG,
        channel_session_id: SESSAO_ID,
        media_id: "midia-1",
        palavra: "preço",
      }),
    ]);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: "instagram_comment_rule.created", organizationId: ORG }),
    );
  });
});
