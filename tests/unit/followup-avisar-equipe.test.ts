/**
 * A caixa "Avisar a equipe" (`notify_team`) do follow-up.
 *
 * O que se mede:
 *  1. o nó parseia, segue pela aresta `always` no mesmo tick e pede o aviso
 *     uma vez, com organização, contato e conversa da inscrição;
 *  2. replay do passo (evento já gravado) não abre o aviso de novo;
 *  3. nenhum envio ao cliente: nenhum job de turno é enfileirado;
 *  4. o adaptador de produção grava `followup_notify_team` filtrando a
 *     organização, aponta para a conversa (sem conversa, o contato) e não
 *     abre aviso para contato anonimizado;
 *  5. o grafo aceita o texto e recusa acima de 140; o publish recusa sem texto;
 *  6. o aviso pede gente: som na Central e push no celular com o texto da caixa;
 *  7. o histórico legível diz que avisou a equipe.
 */
import { describe, expect, it, vi } from "vitest";

import { createSupabaseAdminClient, runFollowupTick, type AdminClient, type AvisoParaEquipe } from "@/lib/followup/engine";
import { descreveEvento, resumoDoNo } from "@/lib/followup/eventos-legiveis";
import { flowGraphSchema, type FlowGraph } from "@/lib/followup/graph-schema";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { pushDoAvisoDaCentral } from "@/lib/notifications/push-dos-avisos";
import { somDoAviso } from "@/lib/notifications/sons-da-org";

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA_ORG = "99999999-9999-4999-8999-999999999999";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const TEXTO = "Paciente não respondeu ao pós-consulta do dia 15";

function enrollment(conversation_id: string | null = CONVERSA): EnrollmentRow {
  const agora = new Date().toISOString();
  return {
    id: "e1",
    organization_id: ORG,
    pointer_id: "p1",
    version_id: "v1",
    contact_id: CONTATO,
    conversation_id,
    current_node_id: "aviso",
    status: "active",
    next_eval_at: agora,
    claimed_until: null,
    attempts: 0,
    max_attempts: 3,
    last_error: null,
    steps_taken: 4,
    outcome: null,
    cancel_reason: null,
    started_at: agora,
    completed_at: null,
    updated_at: agora,
  };
}

const pos = { x: 0, y: 0 };
function grafo(texto = TEXTO): FlowGraph {
  return {
    nodes: [
      { id: "t1", type: "trigger", label: "Início", position: pos, config: {} },
      { id: "aviso", type: "notify_team", label: "Avisar dia 15", position: pos, config: { texto } },
      { id: "fim", type: "end", label: "Fim", position: pos, config: { outcome: "exhausted" } },
    ],
    edges: [
      { id: "a", source: "t1", target: "aviso", priority: 0, condition: { type: "always" } },
      { id: "b", source: "aviso", target: "fim", priority: 0, condition: { type: "always" } },
    ],
  };
}

function cenario(replay = false) {
  const avisos: AvisoParaEquipe[] = [];
  const eventos: Array<Record<string, unknown>> = [];
  const patches: Array<Record<string, unknown>> = [];
  const enqueueJob = vi.fn(async () => {});
  const fila = [enrollment()];
  const db: AdminClient = {
    claimDueEnrollments: async () => fila.splice(0, fila.length),
    loadFlowGraph: async () => flowGraphSchema.parse(grafo()),
    loadLeadFacts: async () => ({ lead_stage: null, tags: [], steps_taken: 0, last_outcome: null }),
    loadEnrollmentEvents: async () => [],
    insertEnrollmentEvent: async (e) => {
      eventos.push(e as unknown as Record<string, unknown>);
      return { inserted: !replay };
    },
    updateEnrollment: async (_id, _org, patch) => {
      patches.push(patch as Record<string, unknown>);
    },
    avisarEquipe: async (item) => {
      avisos.push(item);
    },
    loadLastInboundBody: async () => null,
    loadFlowPointerName: async () => null,
    insertDeadInboxItem: async () => {},
    persistirRespostaFollowup: async () => {},
  };
  return { deps: { db, clock: () => new Date("2026-11-10T12:00:00Z"), enqueueJob }, avisos, eventos, patches, enqueueJob };
}

describe("motor: a caixa avisa uma vez e segue", () => {
  it("abre o aviso com organização, contato e conversa e segue pela aresta always", async () => {
    const c = cenario();
    const r = await runFollowupTick(c.deps);
    expect(r).toMatchObject({ failed: 0, advanced: 1 });
    expect(c.avisos).toEqual([
      {
        organization_id: ORG,
        contact_id: CONTATO,
        conversation_id: CONVERSA,
        enrollment_id: "e1",
        node_id: "aviso",
        rotulo: "Avisar dia 15",
        texto: TEXTO,
      },
    ]);
    expect(c.patches[0]).toMatchObject({ current_node_id: "fim", status: "active", steps_taken: 5 });
    expect(c.eventos[0]).toMatchObject({
      node_id: "aviso",
      event_type: "node_advanced",
      idempotency_key: "aviso:4",
      payload: { next_node_id: "fim", aviso_equipe: true },
    });
  });

  it("não envia nada ao cliente: nenhum turno é enfileirado", async () => {
    const c = cenario();
    await runFollowupTick(c.deps);
    expect(c.enqueueJob).not.toHaveBeenCalled();
  });

  it("replay do passo (evento já gravado) não abre o aviso de novo", async () => {
    const c = cenario(true);
    await runFollowupTick(c.deps);
    expect(c.avisos).toEqual([]);
  });
});

// ─── Adaptador de produção ──────────────────────────────────────────────────

type Linha = Record<string, unknown>;
function cliente(tabelas: Record<string, Linha[]>, inserts: Array<{ tabela: string; linha: Linha }>) {
  return {
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {
        select: () => q,
        eq: (coluna: string, valor: unknown) => (filtros.push([coluna, valor]), q),
        maybeSingle: async () => ({
          data: (tabelas[tabela] ?? []).find((l) => filtros.every(([c, v]) => l[c] === v)) ?? null,
          error: null,
        }),
        insert: async (linha: Linha) => {
          inserts.push({ tabela, linha });
          return { error: null };
        },
      };
      return q;
    },
  };
}

const item = (conversation_id: string | null = CONVERSA): AvisoParaEquipe => ({
  organization_id: ORG,
  contact_id: CONTATO,
  conversation_id,
  enrollment_id: "e1",
  node_id: "aviso",
  rotulo: "Avisar dia 15",
  texto: `  ${TEXTO}  `,
});

describe("adaptador: grava o aviso na Central", () => {
  it("grava followup_notify_team da organização apontando para a conversa", async () => {
    const inserts: Array<{ tabela: string; linha: Linha }> = [];
    const tabelas = { contacts: [{ id: CONTATO, organization_id: ORG, is_anonymized: false }] };
    await createSupabaseAdminClient(cliente(tabelas, inserts) as never).avisarEquipe!(item());
    expect(inserts).toEqual([
      {
        tabela: "agent_inbox_items",
        linha: expect.objectContaining({
          organization_id: ORG,
          kind: "followup_notify_team",
          title: TEXTO,
          ref_kind: "conversation",
          ref_id: CONVERSA,
        }),
      },
    ]);
  });

  it("sem conversa na inscrição, aponta para o contato", async () => {
    const inserts: Array<{ tabela: string; linha: Linha }> = [];
    const tabelas = { contacts: [{ id: CONTATO, organization_id: ORG, is_anonymized: false }] };
    await createSupabaseAdminClient(cliente(tabelas, inserts) as never).avisarEquipe!(item(null));
    expect(inserts[0]?.linha).toMatchObject({ ref_kind: "contact", ref_id: CONTATO });
  });

  it("contato anonimizado, ou de outra organização, não vira aviso", async () => {
    const inserts: Array<{ tabela: string; linha: Linha }> = [];
    const anonimizado = { contacts: [{ id: CONTATO, organization_id: ORG, is_anonymized: true }] };
    await createSupabaseAdminClient(cliente(anonimizado, inserts) as never).avisarEquipe!(item());
    const deOutra = { contacts: [{ id: CONTATO, organization_id: OUTRA_ORG, is_anonymized: false }] };
    await createSupabaseAdminClient(cliente(deOutra, inserts) as never).avisarEquipe!(item());
    expect(inserts).toEqual([]);
  });
});

describe("grafo e publish: o texto é obrigatório e curto", () => {
  it("o grafo aceita o texto e recusa acima de 140 caracteres", () => {
    expect(flowGraphSchema.safeParse(grafo()).success).toBe(true);
    expect(flowGraphSchema.safeParse(grafo("x".repeat(140))).success).toBe(true);
    expect(flowGraphSchema.safeParse(grafo("x".repeat(141))).success).toBe(false);
  });

  it("o publish recusa a caixa sem texto (ou só com espaços) e aceita com texto", () => {
    const codigos = (g: FlowGraph) => {
      const r = validateFlowForPublish(g);
      return r.ok ? [] : r.errors.map((e) => e.code);
    };
    expect(codigos(grafo(""))).toEqual(["texto_do_aviso_ausente"]);
    expect(codigos(grafo("   "))).toEqual(["texto_do_aviso_ausente"]);
    expect(validateFlowForPublish(grafo())).toEqual({ ok: true });
  });
});

describe("o aviso pede gente", () => {
  it("toca o som de pessoa na Central", () => {
    expect(somDoAviso({ kind: "followup_notify_team", ref_kind: "conversation" })).toBe("pessoa");
  });

  it("o push leva o texto da caixa e abre a conversa", async () => {
    const tabelas = {
      agent_inbox_items: [
        { id: "i1", organization_id: ORG, kind: "followup_notify_team", ref_kind: "conversation", ref_id: CONVERSA, title: TEXTO, body: "x" },
      ],
      organizations: [{ id: ORG, locale: "pt-BR" }],
    };
    const push = await pushDoAvisoDaCentral(cliente(tabelas, []) as never, ORG, "i1");
    expect(push).toMatchObject({ title: TEXTO, tag: "aviso:i1", href: `/app/inbox/${CONVERSA}` });
    // A organização do id manda: o mesmo aviso lido por outra organização não existe.
    expect(await pushDoAvisoDaCentral(cliente(tabelas, []) as never, OUTRA_ORG, "i1")).toBeNull();
  });
});

describe("histórico legível", () => {
  it("o passo diz que avisou a equipe, e o nó resume o texto", () => {
    const no = resumoDoNo(grafo().nodes[1]!);
    expect(no.resumo).toContain(TEXTO);
    const ev = descreveEvento(
      { event_type: "node_advanced", node_id: "aviso", payload: { next_node_id: "fim", aviso_equipe: true }, created_at: "" } as never,
      { aviso: no },
      "pt-BR",
    );
    expect(ev.titulo).toBe("Avisou a equipe na Central");
  });
});
