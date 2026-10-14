/**
 * A IA NÃO ESCREVE NO CRM POR CIMA DE QUEM ASSUMIU A CONVERSA.
 *
 * O PR #212 do fork barra a MENSAGEM da IA quando uma pessoa assume no meio do
 * turno (`pessoaAssumiuAConversa`, por bolha). O que ele não cobria é o resto do
 * turno: as ferramentas que ESCREVEM (marcar horário, mover o negócio, etiqueta)
 * continuavam rodando. A recepção respondia pelo celular, a mensagem da IA era
 * descartada e a consulta ficava marcada assim mesmo, sem ninguém avisar o
 * paciente.
 *
 * É a parte que faltava do upstream melgarafael/DeskcommCRM#2541 ("interrompa
 * respostas antigas da IA quando alguém assume"): lá o turno em andamento perde
 * a autoridade para QUALQUER efeito; aqui a mesma régua do #212 passa a valer
 * antes de cada ferramenta de escrita, sem migration.
 */
import { describe, expect, it, vi } from "vitest";

import { guardServiceTools, withServiceJob } from "@/lib/atendimento/fronteira-server";
import type { JobRow, Queryable } from "@/lib/agent-engine/queue/queue";
import type { ToolSet } from "@/lib/agent-engine/edge/llm/run-model-call";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const FRONTEIRA = {
  organization_id: ORG,
  contact_id: CONTATO,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

/** O estado que a ingestão, a tela e o handoff gravam; o dublê só o devolve. */
function banco() {
  const estado = { force_human: false, bot_silenced_until: null as string | null, assignee_kind: null as string | null };
  // O que o gatilho da 0361 grava ao Assumir/Transferir: o turno perde o comando.
  const turno = { vigente: true };
  const db = {
    query: async (sql: string) => {
      if (sql.includes("fn_autonomous_turn_revoked")) return { rows: [{ current: turno.vigente }] };
      if (sql.includes("left join demandas")) {
        return { rows: [{ ...FRONTEIRA, status: "open", demanda_fechada_em: null }] };
      }
      if (sql.includes("cs.metadata")) {
        return {
          rows: [{ channel_metadata: { ai_gate_mode: "open" }, ai_authorized_at: null, phone_number: "5527999990000", provider: "waha", ...estado }],
        };
      }
      return { rows: [] };
    },
  } as unknown as Queryable;
  return { db, estado, turno };
}

const job = (kind: string) =>
  ({
    id: "job-1",
    organization_id: ORG,
    contact_id: CONTATO,
    kind,
    locked_by: "worker",
    claim_acquired_at: "2026-10-14T12:00:00.123456Z",
    payload: { service_boundary: FRONTEIRA },
  }) as unknown as JobRow;

type Executa = (args: unknown) => Promise<unknown>;
const rodar = (tools: ToolSet | undefined, nome: string) =>
  (tools as unknown as Record<string, { execute: Executa }>)[nome]!.execute({});

function ferramentas(aoPassarAVez?: () => void) {
  const marcar = vi.fn(async () => ({ ok: true }));
  const mover = vi.fn(async () => ({ ok: true }));
  const enviar = vi.fn(async () => ({ ok: true }));
  const passar = vi.fn(async () => {
    aoPassarAVez?.();
    return { ok: true };
  });
  const tools = {
    crm_book_appointment: { execute: marcar },
    crm_move_lead_stage: { execute: mover },
    send_message: { execute: enviar },
    request_human_handoff: { execute: passar },
  } as unknown as ToolSet;
  return { tools, marcar, mover, enviar, passar };
}

describe("ferramenta de escrita da IA depois que uma pessoa assume no meio do turno", () => {
  it("a recepção respondeu pelo celular enquanto a IA pensava: a consulta NÃO é marcada", async () => {
    const { db, estado } = banco();
    const f = ferramentas();
    const resposta = await withServiceJob(db, job("inbound_turn"), async () => {
      const tools = guardServiceTools(f.tools);
      estado.bot_silenced_until = new Date(Date.now() + 5 * 60_000).toISOString();
      return rodar(tools, "crm_book_appointment");
    });
    expect(f.marcar).not.toHaveBeenCalled();
    expect(resposta).toMatchObject({ ok: false, error: { code: "pessoa_no_comando" } });
  });

  it("alguém clicou em Assumir (conversa com dono humano): o negócio NÃO é movido", async () => {
    const { db, estado } = banco();
    const f = ferramentas();
    await withServiceJob(db, job("inbound_turn"), async () => {
      const tools = guardServiceTools(f.tools);
      estado.assignee_kind = "user";
      return rodar(tools, "crm_move_lead_stage");
    });
    expect(f.mover).not.toHaveBeenCalled();
  });

  it("controle: sem pessoa na conversa, a ferramenta roda", async () => {
    const { db } = banco();
    const f = ferramentas();
    await withServiceJob(db, job("inbound_turn"), async () => rodar(guardServiceTools(f.tools), "crm_book_appointment"));
    expect(f.marcar).toHaveBeenCalledTimes(1);
  });

  it("controle: silêncio já vencido não segura nada", async () => {
    const { db, estado } = banco();
    estado.bot_silenced_until = new Date(Date.now() - 60_000).toISOString();
    const f = ferramentas();
    await withServiceJob(db, job("inbound_turn"), async () => rodar(guardServiceTools(f.tools), "crm_book_appointment"));
    expect(f.marcar).toHaveBeenCalledTimes(1);
  });

  it("a mensagem não é barrada aqui: quem confere é o envio, bolha a bolha (#212), com o recado dele", async () => {
    const { db, estado } = banco();
    const f = ferramentas();
    await withServiceJob(db, job("inbound_turn"), async () => {
      const tools = guardServiceTools(f.tools);
      estado.force_human = true;
      return rodar(tools, "send_message");
    });
    expect(f.enviar).toHaveBeenCalledTimes(1);
  });

  it("a PRÓPRIA IA passou a vez neste turno: o que ela ainda grava depois (mover o card) continua valendo", async () => {
    const { db, estado } = banco();
    const f = ferramentas(() => {
      estado.force_human = true;
    });
    await withServiceJob(db, job("inbound_turn"), async () => {
      const tools = guardServiceTools(f.tools);
      await rodar(tools, "request_human_handoff");
      return rodar(tools, "crm_move_lead_stage");
    });
    expect(f.mover).toHaveBeenCalledTimes(1);
  });

  it("alguém clica em Assumir ENQUANTO uma ferramenta roda: a escrita seguinte do turno NÃO passa (a janela do #231)", async () => {
    const { db, estado, turno } = banco();
    const f = ferramentas();
    // A etiqueta roda; durante ela, a recepção clica em Assumir.
    const etiquetar = vi.fn(async () => {
      estado.assignee_kind = "user";
      estado.bot_silenced_until = "infinity";
      turno.vigente = false;
      return { ok: true };
    });
    const tools = { ...f.tools, crm_manage_tags: { execute: etiquetar } } as unknown as ToolSet;
    const resposta = await withServiceJob(db, job("inbound_turn"), async () => {
      const guardadas = guardServiceTools(tools);
      await rodar(guardadas, "crm_manage_tags");
      return rodar(guardadas, "crm_book_appointment");
    });
    expect(etiquetar).toHaveBeenCalledTimes(1); // o que já foi feito não é desfeito
    expect(f.marcar).not.toHaveBeenCalled();
    expect(resposta).toMatchObject({ ok: false, error: { code: "pessoa_no_comando" } });
  });

  it("passar a vez e mover no MESMO passo (o modelo pede as duas juntas): as duas rodam", async () => {
    const { db, estado } = banco();
    const f = ferramentas(() => {
      estado.force_human = true;
    });
    await withServiceJob(db, job("inbound_turn"), async () => {
      const tools = guardServiceTools(f.tools);
      return Promise.all([rodar(tools, "request_human_handoff"), rodar(tools, "crm_move_lead_stage")]);
    });
    expect(f.passar).toHaveBeenCalledTimes(1);
    expect(f.mover).toHaveBeenCalledTimes(1);
  });

  it.each(["operator_turn", "approved_reply"])(
    "%s é ordem de uma pessoa: a conversa ter dono humano não barra a ferramenta",
    async (kind) => {
      const { db, estado } = banco();
      estado.assignee_kind = "user";
      const f = ferramentas();
      const tools = { crm_move_lead_stage: { execute: f.mover } } as unknown as ToolSet;
      // `approved_reply` tem guarda própria de lease, fora do que este teste mede.
      vi.spyOn(db, "query");
      await withServiceJob(db, job(kind), async () =>
        (guardServiceTools(tools) as unknown as Record<string, { execute: Executa }>).crm_move_lead_stage!
          .execute({})
          .catch((e: unknown) => e),
      );
      const leuAElegibilidade = vi.mocked(db.query).mock.calls.some(([sql]) => String(sql).includes("cs.metadata"));
      expect(leuAElegibilidade).toBe(false);
    },
  );
});
