/**
 * Levar inscrições vivas de follow-up para a versão ATIVA do fluxo.
 *
 * Prova: a regra pura de "seguro" (`avaliaMigracao`), a operação sobre um
 * PostgREST em memória (isolamento entre organizações, dry-run sem escrita,
 * idempotência, evento gravado, `status`/`next_eval_at`/`updated_at` intactos,
 * motor ocupado fica para a próxima) e a rota (papel admin, Zod, audit).
 *
 * O que NÃO prova: a RLS de verdade (sessão do Postgres) — aqui mede-se o filtro
 * manual por organização, que é o que vale se a RLS falhar aberta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import type { FlowGraph, FlowNode } from "@/lib/followup/graph-schema";
import { avaliaMigracao, migraInscricoesParaVersaoAtiva } from "@/lib/followup/migrar-versao";
import { requireRole } from "@/lib/auth/require-role";

const auditSpy = vi.fn(async () => undefined);
vi.mock("@/lib/audit", () => ({ audit: auditSpy }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
let clienteDaSessao: unknown = null;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clienteDaSessao }));

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const POINTER = "00000000-0000-4000-8000-0000000000f1";
const AGORA = new Date("2026-11-13T12:00:00.000Z");
const DIA = 86_400_000;
const pos = { x: 0, y: 0 };

const espera = (id: string, dias: number): FlowNode =>
  ({ id, type: "wait", label: id, position: pos, config: { mode: "fixed", duration_ms: dias * DIA, anchor: "appointment_day" } }) as FlowNode;
const envio = (id: string, body: string): FlowNode =>
  ({ id, type: "action", label: id, position: pos, config: { mode: "text", body } }) as FlowNode;
const fim: FlowNode = { id: "fim", type: "end", label: "Fim", position: pos, config: { outcome: "converted" } } as FlowNode;
const gatilho: FlowNode = { id: "t", type: "trigger", label: "Início", position: pos, config: {} } as FlowNode;

const ANTIGA: FlowGraph = {
  nodes: [gatilho, espera("w7", 7), envio("m7", "Oi! Tudo bem?"), espera("w15", 15), fim],
  edges: [],
} as unknown as FlowGraph;
const ATIVA: FlowGraph = {
  nodes: [gatilho, espera("w7", 7), envio("m7", "Oi {{primeiro_nome}}! Tudo bem?"), espera("w15", 15), envio("m15", "Novo"), fim],
  edges: [],
} as unknown as FlowGraph;

describe("avaliaMigracao — a regra de seguro", () => {
  it("mesmo nó, mesmo tipo, mesmo relógio: seguro", () => {
    expect(avaliaMigracao(ANTIGA, ATIVA, "w15")).toEqual({ seguro: true });
    expect(avaliaMigracao(ANTIGA, ATIVA, "m7")).toEqual({ seguro: true }); // texto mudou, tipo não
  });
  it("nó ausente na ativa", () => {
    const semW15 = { ...ATIVA, nodes: ATIVA.nodes.filter((n) => n.id !== "w15") } as FlowGraph;
    expect(avaliaMigracao(ANTIGA, semW15, "w15")).toEqual({ seguro: false, motivo: "no_ausente_na_ativa" });
  });
  it("nó ausente na origem", () => {
    expect(avaliaMigracao(ANTIGA, ATIVA, "m15")).toEqual({ seguro: false, motivo: "no_ausente_na_origem" });
  });
  it("tipo diferente com o mesmo id", () => {
    const trocado = { ...ATIVA, nodes: ATIVA.nodes.map((n) => (n.id === "w15" ? envio("w15", "x") : n)) } as FlowGraph;
    expect(avaliaMigracao(ANTIGA, trocado, "w15")).toEqual({ seguro: false, motivo: "tipo_diferente" });
  });
  it("espera com outro prazo ou outra âncora: next_eval_at mudaria de sentido", () => {
    const outroPrazo = { ...ATIVA, nodes: ATIVA.nodes.map((n) => (n.id === "w15" ? espera("w15", 14) : n)) } as FlowGraph;
    expect(avaliaMigracao(ANTIGA, outroPrazo, "w15")).toEqual({ seguro: false, motivo: "espera_diferente" });
    const semAncora = {
      ...ATIVA,
      nodes: ATIVA.nodes.map((n) =>
        n.id === "w15" ? ({ ...n, config: { mode: "fixed", duration_ms: 15 * DIA } } as FlowNode) : n,
      ),
    } as FlowGraph;
    expect(avaliaMigracao(ANTIGA, semAncora, "w15")).toEqual({ seguro: false, motivo: "espera_diferente" });
  });
});

// ─── PostgREST em memória ────────────────────────────────────────────────────

type Linha = Record<string, unknown>;

function banco() {
  const tabelas: Record<string, Linha[]> = {
    followup_flow_pointers: [
      { id: POINTER, organization_id: ORG_A, active_version_id: "v3" },
    ],
    followup_flow_versions: [
      { id: "v1", organization_id: ORG_A, graph: ANTIGA },
      { id: "v2", organization_id: ORG_A, graph: { ...ANTIGA, nodes: ANTIGA.nodes.filter((n) => n.id !== "w7") } },
      { id: "v3", organization_id: ORG_A, graph: ATIVA },
      { id: "vb", organization_id: ORG_B, graph: ANTIGA },
    ],
    followup_enrollments: [],
    followup_enrollment_events: [],
  };
  const writes: string[] = [];
  function from(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    let patch: Linha | null = null;
    let limite = Infinity;
    const casadas = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), q),
      neq: (c: string, v: unknown) => (filtros.push((l) => l[c] !== v), q),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), q),
      gt: (c: string, v: string) => (filtros.push((l) => String(l[c]) > v), q),
      order: () => q,
      limit: (n: number) => ((limite = n), q),
      or: (expr: string) => {
        const corte = expr.split("claimed_until.lt.")[1]!;
        filtros.push((l) => l.claimed_until == null || String(l.claimed_until) < corte);
        return q;
      },
      update: (p: Linha) => ((patch = p), q),
      insert: async (l: Linha) => (writes.push(tabela), tabelas[tabela]!.push(l), { error: null }),
      maybeSingle: async () => {
        const l = casadas()[0];
        return { data: l ? structuredClone(l) : null, error: null };
      },
      then: (resolve: (r: { data: Linha[]; error: null }) => unknown) => {
        const linhas = casadas().slice(0, limite);
        if (patch) {
          writes.push(tabela);
          for (const l of linhas) Object.assign(l, patch);
          return Promise.resolve(resolve({ data: linhas.map((l) => ({ id: l.id })), error: null }));
        }
        return Promise.resolve(resolve({ data: linhas.map((l) => structuredClone(l)), error: null }));
      },
    };
    return q;
  }
  return { client: { from } as never, tabelas, writes };
}

let seq = 0;
const inscricao = (extra: Linha): Linha => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  organization_id: ORG_A,
  pointer_id: POINTER,
  version_id: "v1",
  current_node_id: "w15",
  status: "active",
  next_eval_at: "2026-11-20T03:00:00.000Z",
  updated_at: "2026-11-05T10:00:00.000Z",
  claimed_until: null,
  ...extra,
});

function semeia() {
  const b = banco();
  b.tabelas.followup_enrollments!.push(
    inscricao({}), // v1, w15: segura
    inscricao({ current_node_id: "m7", status: "waiting_reply" }), // v1: segura
    inscricao({ status: "paused_manual", next_eval_at: null }), // v1, pausada: viva, segura
    inscricao({ version_id: "v2", current_node_id: "w7" }), // v2 não tem w7: não segura
    inscricao({ status: "completed", next_eval_at: null }), // morta: fora
    inscricao({ version_id: "v3" }), // já na ativa: fora
    inscricao({ organization_id: ORG_B, version_id: "vb" }), // outra org: fora
    inscricao({ claimed_until: "2099-01-01T00:00:00.000Z" }), // motor ocupado: adiada
  );
  return b;
}

const deps = (client: never, orgId = ORG_A) => ({ supabase: client, orgId, userId: "u1", requestId: "r1", agora: AGORA });

describe("migraInscricoesParaVersaoAtiva", () => {
  it("dry-run conta por versão de origem e não escreve nada", async () => {
    const b = semeia();
    const antes = structuredClone(b.tabelas.followup_enrollments);
    const r = await migraInscricoesParaVersaoAtiva(deps(b.client), POINTER, { dryRun: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.por_versao).toEqual([
      { version_id: "v1", total: 4, seguras: 4, migradas: 0, adiadas: 0, nao_seguras: {} },
      { version_id: "v2", total: 1, seguras: 0, migradas: 0, adiadas: 0, nao_seguras: { no_ausente_na_origem: 1 } },
    ]);
    expect(b.writes).toEqual([]);
    expect(b.tabelas.followup_enrollments).toEqual(antes);
  });

  it("migra só as seguras, sem tocar status/next_eval_at/updated_at, com 1 evento cada; idempotente", async () => {
    const b = semeia();
    const antes = structuredClone(b.tabelas.followup_enrollments!);
    const r = await migraInscricoesParaVersaoAtiva(deps(b.client), POINTER, { dryRun: false });
    if (!r.ok) throw new Error("falhou");
    expect(r.totais).toEqual({ total: 5, seguras: 4, migradas: 3, adiadas: 1, nao_seguras: 1 });

    const depois = b.tabelas.followup_enrollments!;
    const migradas = depois.filter((l, i) => l.version_id !== antes[i]!.version_id);
    expect(migradas).toHaveLength(3);
    for (const l of migradas) {
      const i = depois.indexOf(l);
      expect(l).toEqual({ ...antes[i], version_id: "v3" });
    }
    // Outra org, ocupada, morta e insegura: intactas.
    expect(depois.filter((l) => l.organization_id === ORG_B)[0]!.version_id).toBe("vb");
    expect(depois.find((l) => l.claimed_until)!.version_id).toBe("v1");
    expect(depois.find((l) => l.status === "completed")!.version_id).toBe("v1");
    expect(depois.find((l) => l.current_node_id === "w7")!.version_id).toBe("v2");

    const eventos = b.tabelas.followup_enrollment_events!;
    expect(eventos).toHaveLength(3);
    expect(eventos[0]).toEqual({
      organization_id: ORG_A,
      enrollment_id: migradas[0]!.id,
      node_id: "w15",
      event_type: "version_migrated",
      payload: { from_version_id: "v1", to_version_id: "v3", current_node_id: "w15", actor_user_id: "u1" },
    });

    const r2 = await migraInscricoesParaVersaoAtiva(deps(b.client), POINTER, { dryRun: false });
    if (!r2.ok) throw new Error("falhou");
    expect(r2.totais.migradas).toBe(0);
    expect(b.tabelas.followup_enrollment_events).toHaveLength(3);
  });

  it("isolamento: o pointer de A não existe para B", async () => {
    const b = semeia();
    const r = await migraInscricoesParaVersaoAtiva(deps(b.client, ORG_B), POINTER, { dryRun: false });
    expect(r).toMatchObject({ ok: false, codigo: "nao_encontrado" });
    expect(b.writes).toEqual([]);
  });
});

// ─── A rota ──────────────────────────────────────────────────────────────────

const { POST } = await import("@/app/api/v1/ai/followup-flows/[id]/migrar-inscricoes/route");

const pedido = (corpo: unknown) =>
  new NextRequest(`http://localhost/api/v1/ai/followup-flows/${POINTER}/migrar-inscricoes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
const ctx = { params: Promise.resolve({ id: POINTER }) };
const admin = (orgId = ORG_A) =>
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: "u1", idioma: "pt-BR" }, org: { orgId } } as never);

beforeEach(() => {
  auditSpy.mockClear();
  vi.mocked(requireRole).mockReset();
});

describe("POST /api/v1/ai/followup-flows/:id/migrar-inscricoes", () => {
  it("exige admin — gerente leva 403 e o banco nem é lido", async () => {
    const b = semeia();
    clienteDaSessao = b.client;
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const res = await POST(pedido({ dry_run: false }), ctx);
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("admin", expect.anything());
    expect(b.writes).toEqual([]);
  });

  it("corpo sem dry_run booleano é 422", async () => {
    clienteDaSessao = semeia().client;
    admin();
    expect((await POST(pedido({}), ctx)).status).toBe(422);
    expect((await POST(pedido({ dry_run: "sim" }), ctx)).status).toBe(422);
  });

  it("dry-run devolve as contagens e não audita", async () => {
    const b = semeia();
    clienteDaSessao = b.client;
    admin();
    const res = await POST(pedido({ dry_run: true }), ctx);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.totais).toEqual({ total: 5, seguras: 4, migradas: 0, adiadas: 0, nao_seguras: 1 });
    expect(b.writes).toEqual([]);
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it("execução migra e audita com as contagens, na org da sessão", async () => {
    const b = semeia();
    clienteDaSessao = b.client;
    admin();
    const res = await POST(pedido({ dry_run: false }), ctx);
    expect(res.status).toBe(200);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "followup_flow.enrollments_migrated",
        organizationId: ORG_A,
        resourceId: POINTER,
        metadata: expect.objectContaining({ totais: expect.objectContaining({ migradas: 3 }) }),
      }),
    );
  });

  it("admin de outra org recebe 404 e nada muda", async () => {
    const b = semeia();
    clienteDaSessao = b.client;
    admin(ORG_B);
    const res = await POST(pedido({ dry_run: false }), ctx);
    expect(res.status).toBe(404);
    expect(b.writes).toEqual([]);
  });
});
