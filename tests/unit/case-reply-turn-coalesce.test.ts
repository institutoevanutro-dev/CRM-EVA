/**
 * Dois casos da MESMA conversa resolvidos em sequência viram UM turno do agente.
 *
 * Produção, 16/10/2026: o gestor resolveu dois casos da mesma conversa com
 * segundos de diferença; cada resolução enfileirou um `case_reply_turn`, a lane
 * do contato os rodou um atrás do outro, e o paciente recebeu dois pares de
 * mensagens quase iguais com 20s entre eles.
 *
 * O banco aqui é um pool de mentira que responde pelo texto da query — o que se
 * prova é a decisão do handler (quem entra no turno, quem é absorvido, com qual
 * filtro de organização). A resolução caso→conversa contra Postgres real está em
 * tests/invariants/case-reply-turn.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";

vi.mock("@/lib/agent-engine/agent/inbound-turn", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runAgentTurn: vi.fn() };
});

import { runAgentTurn, type InboundTurnDeps } from "@/lib/agent-engine/agent/inbound-turn";
import { createCaseReplyTurnHandler } from "@/lib/agent-engine/agent/case-reply-turn";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { LeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";

const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const CONTACT = "aaaaaaaa-0000-4000-8000-000000000002";
const SESSION = "aaaaaaaa-0000-4000-8000-000000000003";
const CONV = "aaaaaaaa-0000-4000-8000-000000000004";
const OUTRA_CONV = "aaaaaaaa-0000-4000-8000-000000000005";
const CASO_A = "aaaaaaaa-1000-4000-8000-00000000000a";
const CASO_B = "aaaaaaaa-1000-4000-8000-00000000000b";
const CASO_OUTRA = "aaaaaaaa-1000-4000-8000-00000000000c";
const JOB_A = "aaaaaaaa-2000-4000-8000-00000000000a";
const JOB_B = "aaaaaaaa-2000-4000-8000-00000000000b";
const JOB_OUTRA = "aaaaaaaa-2000-4000-8000-00000000000c";

const CASOS: Record<string, { status: string; conversation_id: string }> = {
  [CASO_A]: { status: "resolved", conversation_id: CONV },
  [CASO_B]: { status: "resolved", conversation_id: CONV },
  [CASO_OUTRA]: { status: "resolved", conversation_id: OUTRA_CONV },
};

interface Chamada {
  sql: string;
  params: unknown[];
}

function poolFalso(pendentes: Array<{ id: string; payload: unknown }>) {
  const chamadas: Chamada[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      chamadas.push({ sql, params });
      if (sql.includes("from agent_cases")) {
        const caso = CASOS[params[1] as string];
        return {
          rows: caso ? [{ ...caso, channel_session_id: SESSION }] : [],
          rowCount: caso ? 1 : 0,
        };
      }
      if (sql.includes("select id, payload from job_queue")) return { rows: pendentes, rowCount: pendentes.length };
      if (sql.includes("update job_queue")) return { rows: [], rowCount: (params[1] as string[]).length };
      throw new Error(`query inesperada: ${sql}`);
    },
  };
  return { pool: pool as unknown as pg.Pool, chamadas };
}

function job(id: string, caseId: string, body: string): JobRow {
  return {
    id,
    organization_id: ORG,
    contact_id: CONTACT,
    kind: "case_reply_turn",
    source_event_id: null,
    payload: { case_id: caseId, action: "resolved", body },
    status: "running",
    priority: 100,
    run_after: new Date(),
    attempts: 1,
    max_attempts: 5,
    last_error: null,
    locked_by: "w",
    locked_at: new Date(),
    created_at: new Date(),
  };
}

const deps = {
  log: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as InboundTurnDeps;

const contexto: LeadContext = {
  lead_id: CONTACT,
  contact: { name: "Paciente", phone: null, email: null, tags: [], is_blocked: false },
  conversation_id: CONV,
  last_human_decision: null,
  messages: [],
};

beforeEach(() => {
  vi.mocked(runAgentTurn).mockReset();
  vi.mocked(runAgentTurn).mockResolvedValue(undefined);
});

describe("case_reply_turn — casos pendentes da mesma conversa entram num turno só", () => {
  it("um turno, uma abertura com os dois casos, e o irmão absorvido com filtro de organização", async () => {
    const { pool, chamadas } = poolFalso([
      { id: JOB_B, payload: { case_id: CASO_B, action: "resolved", body: "exame liberado" } },
      { id: JOB_OUTRA, payload: { case_id: CASO_OUTRA, action: "resolved", body: "de outra conversa" } },
    ]);

    await createCaseReplyTurnHandler(deps)(job(JOB_A, CASO_A, "retorno marcado"), pool, { workerId: "w" });

    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    const abertura = vi.mocked(runAgentTurn).mock.calls[0]![4]!.buildOpening({
      previous: null,
      leadState: null,
      context: contexto,
      notesIndexBlock: "—",
    });
    expect(abertura).toContain("retorno marcado");
    expect(abertura).toContain("exame liberado");
    expect(abertura).not.toContain("de outra conversa");
    expect(abertura).toContain("numa única resposta");

    const busca = chamadas.find((c) => c.sql.includes("select id, payload from job_queue"))!;
    expect(busca.sql).toMatch(/organization_id = \$1/);
    expect(busca.params[0]).toBe(ORG);

    const absorcao = chamadas.filter((c) => c.sql.includes("update job_queue"));
    expect(absorcao).toHaveLength(1);
    expect(absorcao[0]!.sql).toMatch(/organization_id = \$1/);
    expect(absorcao[0]!.sql).toMatch(/status = 'pending'/);
    expect(absorcao[0]!.params[0]).toBe(ORG);
    expect(absorcao[0]!.params[1]).toEqual([JOB_B]);
  });

  it("turno que não termina (adiado pela janela, falha) não absorve ninguém — o irmão segue pendente", async () => {
    const { pool, chamadas } = poolFalso([
      { id: JOB_B, payload: { case_id: CASO_B, action: "resolved", body: "exame liberado" } },
    ]);
    vi.mocked(runAgentTurn).mockRejectedValue(new Error("adiado"));

    await expect(
      createCaseReplyTurnHandler(deps)(job(JOB_A, CASO_A, "retorno marcado"), pool, { workerId: "w" }),
    ).rejects.toThrow("adiado");
    expect(chamadas.some((c) => c.sql.includes("update job_queue"))).toBe(false);
  });

  it("sem irmão pendente, a abertura é a de sempre e nada é absorvido", async () => {
    const { pool, chamadas } = poolFalso([]);

    await createCaseReplyTurnHandler(deps)(job(JOB_A, CASO_A, "retorno marcado"), pool, { workerId: "w" });

    const abertura = vi.mocked(runAgentTurn).mock.calls[0]![4]!.buildOpening({
      previous: null,
      leadState: null,
      context: contexto,
      notesIndexBlock: "—",
    });
    expect(abertura).toContain("Resposta do responsável interno sobre um caso que você abriu.");
    expect(abertura).not.toContain("numa única resposta");
    expect(chamadas.some((c) => c.sql.includes("update job_queue"))).toBe(false);
  });
});
