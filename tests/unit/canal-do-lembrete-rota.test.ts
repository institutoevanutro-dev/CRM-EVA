/**
 * A rota que fixa o número do lembrete do compromisso: quem pode salvar, em
 * qual organização, qual número é aceito e o que fica na auditoria. Sessão,
 * banco e auditoria são dublados; o handler e a regra de escrita são os de verdade.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { lerCanalDoLembrete } from "@/lib/agenda/canal-do-lembrete";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";

const auditSpy = vi.fn(async () => undefined);
vi.mock("@/lib/audit", () => ({ audit: auditSpy }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "c05e7a00-0000-4000-8000-000000000001";
const CLINICA = "c05e7a00-0000-4000-8000-0000000000c1";
const OUTRO = "c05e7a00-0000-4000-8000-0000000000c2";

const filtros: Record<string, Array<[string, string, unknown]>> = {};
const updates: Array<{ linha: Record<string, unknown>; filtro: Array<[string, string, unknown]> }> = [];
const banco: { settings: unknown; canalExiste: boolean } = { settings: null, canalExiste: true };

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from(tabela: string) {
      const lista: Array<[string, string, unknown]> = [];
      filtros[tabela] ??= [];
      let update: Record<string, unknown> | undefined;
      const fim = async () => {
        filtros[tabela]!.push(...lista);
        if (update) {
          updates.push({ linha: update, filtro: lista });
          return { error: null };
        }
        if (tabela === "channel_sessions") return { data: banco.canalExiste ? { id: CLINICA } : null, error: null };
        return { data: { settings: banco.settings }, error: null };
      };
      const q: Record<string, unknown> = new Proxy(
        {},
        {
          get(_a, prop) {
            if (prop === "then") return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => fim().then(ok, ko);
            if (prop === "maybeSingle") return fim;
            return (...args: unknown[]) => {
              if (prop === "update") update = args[0] as Record<string, unknown>;
              else if (prop !== "select") lista.push([String(prop), String(args[0]), args[1]]);
              return q;
            };
          },
        },
      );
      return q;
    },
  }),
}));

const { PATCH } = await import("@/app/api/v1/settings/agenda/canal-do-lembrete/route");

function pedido(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/settings/agenda/canal-do-lembrete", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const comoGerente = () =>
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "u1" },
    org: { orgId: ORG, role: "manager" },
  } as never);

beforeEach(() => {
  for (const k of Object.keys(filtros)) delete filtros[k];
  updates.length = 0;
  banco.settings = { agenda: { confirmation_delay_minutes: 10, unknown_protection_minutes: 1440 }, outra: 1 };
  banco.canalExiste = true;
  auditSpy.mockClear();
  vi.mocked(requireRole).mockReset();
});

describe("PATCH /api/v1/settings/agenda/canal-do-lembrete", () => {
  it("quem não é gerente não salva, e o banco nem é lido", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const res = await PATCH(pedido({ channel_session_id: CLINICA }));
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(filtros).toEqual({});
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("gerente fixa o número na PRÓPRIA organização, sem tocar nos prazos, e audita de/para", async () => {
    comoGerente();
    const res = await PATCH(pedido({ channel_session_id: CLINICA }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ channel_session_id: CLINICA });
    // O número é procurado na organização da sessão, entre os de envio automático, não arquivados.
    const canal = filtros.channel_sessions!;
    expect(canal).toContainEqual(["eq", "id", CLINICA]);
    expect(canal).toContainEqual(["eq", "organization_id", ORG]);
    expect(canal.some(([op, col]) => op === "in" && col === "provider")).toBe(true);
    expect(canal).toContainEqual(["is", "archived_at", null]);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.filtro).toEqual([["eq", "id", ORG]]);
    expect(updates[0]!.linha.settings).toEqual({
      agenda: { confirmation_delay_minutes: 10, unknown_protection_minutes: 1440 },
      outra: 1,
      agenda_lembrete: { channel_session_id: CLINICA },
    });
    expect(lerCanalDoLembrete(updates[0]!.linha.settings)).toBe(CLINICA);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agenda.canal_do_lembrete_changed",
        organizationId: ORG,
        actorUserId: "u1",
        metadata: { de: null, para: CLINICA },
      }),
    );
    expect(AUDIT_ACTIONS as readonly string[]).toContain("agenda.canal_do_lembrete_changed");
  });

  it("null volta ao automático", async () => {
    comoGerente();
    banco.settings = { agenda_lembrete: { channel_session_id: CLINICA } };
    const res = await PATCH(pedido({ channel_session_id: null }));
    expect(res.status).toBe(200);
    expect(filtros.channel_sessions).toBeUndefined();
    expect(lerCanalDoLembrete(updates[0]!.linha.settings)).toBeNull();
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ metadata: { de: CLINICA, para: null } }));
  });

  it("número que não é da organização (ou arquivado, ou não automático): 422, sem gravar", async () => {
    comoGerente();
    banco.canalExiste = false;
    const res = await PATCH(pedido({ channel_session_id: OUTRO }));
    expect(res.status).toBe(422);
    expect(updates).toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("mesmo valor que já vale: responde ok, não grava nem audita", async () => {
    comoGerente();
    banco.settings = { agenda_lembrete: { channel_session_id: CLINICA } };
    const res = await PATCH(pedido({ channel_session_id: CLINICA }));
    expect(res.status).toBe(200);
    expect(updates).toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["sem o campo", {}],
    ["não é uuid", { channel_session_id: "zap-1" }],
    ["número", { channel_session_id: 1 }],
    ["organização no corpo", { channel_session_id: CLINICA, organization_id: OUTRO }],
  ])("recusa %s com 422, sem gravar nem auditar", async (_nome, corpo) => {
    comoGerente();
    const res = await PATCH(pedido(corpo));
    expect(res.status).toBe(422);
    expect(updates).toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });
});
