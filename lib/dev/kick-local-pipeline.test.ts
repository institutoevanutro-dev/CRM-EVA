import { beforeEach, describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { LiveEnrollmentRef, ReactivityAdminClient } from "@/lib/followup/reactivity";

vi.mock("@/lib/event-log/drain", () => ({
  drainEventLog: vi.fn(async () => ({ drained: 0 })),
}));
vi.mock("@/lib/event-log/register-handlers", () => ({
  ensureHandlersRegistered: vi.fn(),
}));

// Estado em memória da inscrição que a reatividade REAL lê e grava. O texto
// (aplicarTextoNosFollowups) é espiado: o que interessa é o que ele encontra
// quando roda — a ordem medida pelo efeito, não pela posição no código-fonte.
const estado = vi.hoisted(() => ({
  inscricoes: [] as LiveEnrollmentRef[],
  vistoPeloTexto: [] as LiveEnrollmentRef[][],
}));

vi.mock("@/lib/followup/reactivity", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/followup/reactivity")>();
  return {
    ...real,
    createSupabaseReactivityClient: (): ReactivityAdminClient => ({
      async loadConversationContactId() {
        return null;
      },
      async loadContactBlocked() {
        return false;
      },
      async loadLiveEnrollmentsForContact() {
        return estado.inscricoes.filter((e) => e.status === "active" || e.status === "waiting_reply");
      },
      async insertEnrollmentEvent() {
        return { inserted: true };
      },
      async updateEnrollment(id, _org, patch) {
        estado.inscricoes = estado.inscricoes.map((e) =>
          e.id === id ? ({ ...e, ...patch } as LiveEnrollmentRef) : e,
        );
      },
      async agoraNoBanco() {
        return new Date().toISOString();
      },
    }),
  };
});
vi.mock("@/lib/followup/aplicar-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/followup/aplicar-inbound")>()),
  aplicarTextoNosFollowups: vi.fn(async () => {
    estado.vistoPeloTexto.push(estado.inscricoes.map((e) => ({ ...e })));
  }),
}));
vi.mock("@/lib/followup/enviar-texto-fixo", () => ({
  enviarTextoFixoPendente: vi.fn(async () => 0),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  idsDoContatoEGemeos: vi.fn(async (_a: unknown, _o: string, c: string) => [c]),
}));

import { acelerarPipelineDeEventos, kickLocalPipeline } from "@/lib/dev/kick-local-pipeline";
import { inboundEhDestaPergunta } from "@/lib/followup/aplicar-inbound";

describe("kickLocalPipeline", () => {
  it("não propaga erro do tick do contato (contrato: nunca 5xx no webhook)", async () => {
    const admin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => {
              throw new Error("boom do mock");
            },
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(
      kickLocalPipeline(admin, {
        organizationId: "org",
        contactId: "contact",
      }),
    ).resolves.toBeUndefined();
  });

});

/** Admin cujas consultas de tick devolvem vazio — o efeito medido é o da reatividade. */
function adminVazio(): SupabaseClient {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "lte", "limit"]) q[m] = () => q;
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return { from: () => q } as unknown as SupabaseClient;
}

function inscricao(over: Partial<LiveEnrollmentRef>): LiveEnrollmentRef {
  return {
    id: "enr-1",
    status: "waiting_reply",
    current_node_id: "match_reply-1",
    steps_taken: 3,
    pointer_id: "ptr-1",
    handoff_policy: "pause",
    trigger_config: { kind: "manual" },
    ...over,
  };
}

describe("acelerarPipelineDeEventos — a resposta do contato no webhook", () => {
  beforeEach(() => {
    estado.inscricoes = [];
    estado.vistoPeloTexto = [];
  });

  it("com cancel_on_reply, o texto já encontra a inscrição cancelada (a resposta cancela antes de o passo andar)", async () => {
    estado.inscricoes = [inscricao({ trigger_config: { kind: "manual", cancel_on_reply: true } })];

    await acelerarPipelineDeEventos(adminVazio(), {
      organizationId: "org-1",
      contactId: "contact-1",
      messageId: "msg-1",
    });

    expect(estado.vistoPeloTexto).toHaveLength(1);
    expect(estado.vistoPeloTexto[0]![0]!.status).toBe("cancelled");
  });

  it("sem cancel_on_reply, o acordar não esconde a resposta da pergunta (o '1' ainda casa no mesmo request)", async () => {
    // A pergunta estacionou há 1 min; o "1" chegou há 5 s. O acordar sintético
    // do kick roda ANTES do texto e não tem sent_at — se ele regravasse
    // updated_at, o texto descartaria o "1" como anterior à pergunta (36827ea36).
    const park = new Date(Date.now() - 60_000).toISOString();
    const respostaEm = new Date(Date.now() - 5_000).toISOString();
    estado.inscricoes = [inscricao({ updated_at: park })];

    await acelerarPipelineDeEventos(adminVazio(), {
      organizationId: "org-1",
      contactId: "contact-1",
      messageId: "msg-1",
    });

    const visto = estado.vistoPeloTexto[0]![0]!;
    expect(visto.status).toBe("waiting_reply");
    expect(inboundEhDestaPergunta(respostaEm, visto.updated_at!)).toBe(true);
  });
});
