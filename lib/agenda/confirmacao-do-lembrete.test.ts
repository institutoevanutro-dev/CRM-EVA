import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O PACIENTE CONFIRMA A PRESENÇA RESPONDENDO AO LEMBRETE — o leitor.
 *
 * Dois erros possíveis, e o caro é o falso positivo: um "sim" que respondia a
 * outra pergunta marca "Presença confirmada", a recepção não liga na véspera, e
 * o horário fica vazio. Por isso as frases de controle NEGATIVAS valem tanto
 * quanto as positivas, e o "sim" depois de outra mensagem da clínica não lê.
 */

const audit = vi.fn(async (_entrada: Record<string, unknown>) => {});
vi.mock("@/lib/audit", () => ({ audit: (e: Record<string, unknown>) => audit(e) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  ATIVIDADE_DA_PRESENCA_CONFIRMADA,
  CHAVE_DO_CARIMBO_DO_LEMBRETE,
  FRASE_PEDIDO_DE_CONFIRMACAO,
  ehConfirmacaoDePresenca,
  lerCarimboDoLembrete,
  lerConfirmacaoDoLembrete,
} from "./confirmacao-do-lembrete";

describe("a frase que o lembrete acrescenta", () => {
  it("é o texto combinado, num lugar só", () => {
    expect(FRASE_PEDIDO_DE_CONFIRMACAO).toBe("Para confirmar sua presença, responda SIM.");
  });

  it("pede a palavra que o leitor sabe ler", () => {
    expect(ehConfirmacaoDePresenca("SIM")).toBe(true);
  });
});

describe("ehConfirmacaoDePresenca — a mensagem inteira tem de ser a confirmação", () => {
  it.each([
    "SIM!",
    "Sim.",
    "sim",
    "  sim  ",
    "👍",
    "👍🏽",
    "✅",
    "\u2705\uFE0F",
    "confirmo",
    "Confirmo!",
    "1",
    "Confirmado",
    "confirmada.",
    "Sim, confirmo",
    "sim confirmo!",
    "Vou sim",
    "Estarei aí",
    "estarei ai!",
  ])("confirma: %s", (texto) => {
    expect(ehConfirmacaoDePresenca(texto)).toBe(true);
  });

  it.each([
    "sim, mas…",
    "sim, mas posso chegar 10 min atrasada?",
    "não",
    "nao vou",
    "remarcar",
    "1 hora",
    "sim?",
    "Sim??",
    "confirmo?",
    "",
    "   ",
    "simples",
    "sim, preciso remarcar",
    "cancelar",
  ])("NÃO confirma: %s", (texto) => {
    expect(ehConfirmacaoDePresenca(texto)).toBe(false);
  });
});

describe("lerCarimboDoLembrete — o elo da mensagem com o compromisso", () => {
  const ID = "6f1c2c1e-2b8a-4d6e-9a3b-1f2e3d4c5b6a";

  it("lê o carimbo que o lembrete grava", () => {
    expect(CHAVE_DO_CARIMBO_DO_LEMBRETE).toBe("agenda_lembrete");
    expect(lerCarimboDoLembrete({ agenda_lembrete: { appointment_id: ID, revision: 3 } })).toEqual({
      appointmentId: ID,
      revision: 3,
    });
  });

  it.each([
    null,
    undefined,
    "texto",
    [],
    {},
    { agenda_lembrete: null },
    { agenda_lembrete: { appointment_id: ID } },
    { agenda_lembrete: { appointment_id: "nao-e-uuid", revision: 1 } },
    { agenda_lembrete: { appointment_id: ID, revision: "3" } },
    { agenda_lembrete: { appointment_id: ID, revision: 1.5 } },
  ])("sem carimbo válido não há elo: %j", (metadata) => {
    expect(lerCarimboDoLembrete(metadata)).toBeNull();
  });
});

// ─── O leitor contra um banco de mentira ────────────────────────────────────

const ORG = "org-1";
const CONVERSA = "conversa-1";
const CONTATO = "contato-1";
const RESPOSTA = "msg-paciente";
const COMPROMISSO = "6f1c2c1e-2b8a-4d6e-9a3b-1f2e3d4c5b6a";
/** `created_at` da resposta: quando ela chegou a NÓS. */
const CHEGOU_EM = "2026-11-28T14:32:00.000Z";

type Filtro = [string, string, unknown];
interface Consulta {
  tabela: string;
  filtros: Filtro[];
  inserido?: Record<string, unknown>;
}

let consultas: Consulta[] = [];
let rpcs: Array<{ nome: string; args: Record<string, unknown> }> = [];
/** A mensagem do paciente, como a leitura por id a devolve. */
let mensagemDoPaciente: Record<string, unknown> | null = null;
/** A última mensagem da clínica antes do "sim". */
let ultimaDaClinica: Record<string, unknown> | null = null;
/** O compromisso do carimbo com o tipo embutido, como a leitura da chave o devolve. */
let compromissoDoCarimbo: Record<string, unknown> | null = null;
let resultadoDoRpc: { data: unknown; error: { message: string; code?: string } | null } = {
  data: "confirmado",
  error: null,
};
let leadsDoContato: Array<Record<string, unknown>> = [];
let erroDaAtividade: { message: string } | null = null;

const tem = (c: Consulta, op: string, coluna: string, valor?: unknown) =>
  c.filtros.some(([o, col, v]) => o === op && col === coluna && (valor === undefined || v === valor));

function responder(c: Consulta): { data: unknown; error: unknown } {
  if (c.tabela === "messages") {
    return tem(c, "eq", "direction", "outbound")
      ? { data: ultimaDaClinica, error: null }
      : { data: mensagemDoPaciente, error: null };
  }
  if (c.tabela === "calendar_appointments") return { data: compromissoDoCarimbo, error: null };
  if (c.tabela === "crm_leads") return { data: leadsDoContato, error: null };
  if (c.tabela === "crm_pipelines") return { data: { id: "funil-1" }, error: null };
  if (c.tabela === "crm_lead_activities") return { data: null, error: erroDaAtividade };
  return { data: null, error: null };
}

const admin = {
  from(tabela: string) {
    const c: Consulta = { tabela, filtros: [] };
    consultas.push(c);
    const q: Record<string, unknown> = {
      select: () => q,
      insert: (linha: Record<string, unknown>) => {
        c.inserido = linha;
        return q;
      },
      eq: (col: string, v: unknown) => (c.filtros.push(["eq", col, v]), q),
      lt: (col: string, v: unknown) => (c.filtros.push(["lt", col, v]), q),
      order: (col: string, o?: { ascending?: boolean }) => (c.filtros.push(["order", col, o?.ascending]), q),
      limit: () => q,
      maybeSingle: () => q,
      then: (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) =>
        Promise.resolve(responder(c)).then(ok, falha),
    };
    return q;
  },
  async rpc(nome: string, args: Record<string, unknown>) {
    rpcs.push({ nome, args });
    return nome === "fn_appointment_patient_confirm" ? resultadoDoRpc : { data: null, error: null };
  },
} as never;

function ler(body = "SIM") {
  return lerConfirmacaoDoLembrete({
    admin,
    organizationId: ORG,
    conversationId: CONVERSA,
    contactId: CONTATO,
    messageId: RESPOSTA,
    body,
    requestId: "req-1",
  });
}

const confirmacoes = () => rpcs.filter((r) => r.nome === "fn_appointment_patient_confirm");

beforeEach(() => {
  consultas = [];
  rpcs = [];
  mensagemDoPaciente = { created_at: CHEGOU_EM };
  ultimaDaClinica = {
    metadata: { agenda_lembrete: { appointment_id: COMPROMISSO, revision: 4 } },
    status: "delivered",
  };
  compromissoDoCarimbo = { tipo: { reminder_asks_confirmation: true } };
  resultadoDoRpc = { data: "confirmado", error: null };
  leadsDoContato = [
    {
      id: "lead-1",
      organization_id: ORG,
      pipeline_id: "funil-1",
      status: "open",
      last_activity_at: CHEGOU_EM,
      created_at: CHEGOU_EM,
    },
  ];
  erroDaAtividade = null;
  audit.mockClear();
});

describe("lerConfirmacaoDoLembrete", () => {
  it("resposta que não é confirmação não toca no banco", async () => {
    await expect(ler("sim, mas posso chegar 10 min atrasada?")).resolves.toBe("nao_e_confirmacao");
    expect(consultas).toHaveLength(0);
    expect(rpcs).toHaveLength(0);
  });

  it("SIM logo depois do lembrete confirma o compromisso do carimbo, na revisão do carimbo", async () => {
    await expect(ler("SIM!")).resolves.toBe("confirmado");

    expect(confirmacoes()).toEqual([
      {
        nome: "fn_appointment_patient_confirm",
        args: {
          p_appointment_id: COMPROMISSO,
          p_expected_revision: 4,
          p_source: "mensagem",
          p_message_id: RESPOSTA,
          p_user_id: null,
        },
      },
    ]);
  });

  it("'última da clínica' é a outbound mais recente ANTES da resposta do paciente", async () => {
    await ler();

    const ultima = consultas.find((c) => c.tabela === "messages" && tem(c, "eq", "direction", "outbound"));
    expect(ultima, "não procurou a última mensagem da clínica").toBeDefined();
    expect(tem(ultima!, "eq", "conversation_id", CONVERSA)).toBe(true);
    // Um relógio só, o nosso: o `sent_at` do inbound é o do aparelho.
    expect(tem(ultima!, "lt", "created_at", CHEGOU_EM), "não limitou ao que chegou antes do 'sim'").toBe(true);
    expect(tem(ultima!, "order", "created_at", false), "não pegou a MAIS RECENTE").toBe(true);
    expect(tem(ultima!, "order", "id", false), "sem desempate estável").toBe(true);
    expect(ultima!.filtros.some(([, col]) => col === "sent_at"), "voltou a misturar o relógio do aparelho").toBe(false);
  });

  it("SIM depois de OUTRA mensagem da clínica, posterior ao lembrete, NÃO confirma (Foco 1)", async () => {
    // A IA (ou a recepção) perguntou outra coisa depois do lembrete: o "sim"
    // responde àquela pergunta, não ao lembrete.
    ultimaDaClinica = { metadata: { ai_actor_name: "Cintia" } };

    await expect(ler()).resolves.toBe("sem_lembrete");
    expect(confirmacoes()).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it.each(["queued", "failed"])("lembrete carimbado que não saiu (%s) não confirma", async (status) => {
    ultimaDaClinica = { ...ultimaDaClinica, status };
    await expect(ler()).resolves.toBe("sem_lembrete");
    expect(confirmacoes()).toHaveLength(0);
  });

  it.each(["queued", "failed", "sent"])(
    "outra mensagem da clínica depois do lembrete conta em qualquer status (%s)",
    async (status) => {
      // A pergunta que falhou ou ainda não saiu também é o assunto da vez: na
      // dúvida, não se lê o "sim".
      ultimaDaClinica = { metadata: {}, status };
      await expect(ler()).resolves.toBe("sem_lembrete");
      expect(confirmacoes()).toHaveLength(0);
    },
  );

  it.each([
    ["desligada", { tipo: { reminder_asks_confirmation: false } }],
    ["nula", { tipo: { reminder_asks_confirmation: null } }],
    ["sem tipo (ou tipo de outra organização)", { tipo: null }],
    ["compromisso fora da organização", null],
  ])("chave do tipo %s: o SIM ao lembrete carimbado NÃO confirma", async (_rotulo, linha) => {
    // Decisão 2: desligada por padrão, nada muda em clínica nenhuma até alguém ligar.
    compromissoDoCarimbo = linha;
    await expect(ler()).resolves.toBe("chave_desligada");
    expect(confirmacoes()).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("a chave é lida do compromisso do carimbo, com a organização filtrada nos dois lados", async () => {
    await ler();
    const leitura = consultas.find((c) => c.tabela === "calendar_appointments");
    expect(leitura, "não leu a chave do tipo").toBeDefined();
    expect(tem(leitura!, "eq", "id", COMPROMISSO)).toBe(true);
    expect(tem(leitura!, "eq", "organization_id", ORG)).toBe(true);
    expect(tem(leitura!, "eq", "tipo.organization_id", ORG)).toBe(true);
  });

  it("conversa sem nenhuma mensagem da clínica não confirma nada", async () => {
    ultimaDaClinica = null;
    await expect(ler()).resolves.toBe("sem_lembrete");
    expect(confirmacoes()).toHaveLength(0);
  });

  it("mensagem do paciente que não está nesta conversa não confirma nada", async () => {
    mensagemDoPaciente = null;
    await expect(ler()).resolves.toBe("sem_lembrete");
    expect(confirmacoes()).toHaveLength(0);
  });

  it("toda consulta filtra a organização", async () => {
    await ler();
    expect(consultas.length).toBeGreaterThan(0);
    for (const c of consultas.filter((x) => !x.inserido)) {
      expect(tem(c, "eq", "organization_id", ORG), `${c.tabela} sem organization_id`).toBe(true);
    }
    const atividade = consultas.find((c) => c.tabela === "crm_lead_activities");
    expect(atividade?.inserido?.organization_id).toBe(ORG);
  });

  it("confirmado: grava a atividade na timeline do negócio, com o tipo compartilhado", async () => {
    await ler();

    const atividade = consultas.find((c) => c.tabela === "crm_lead_activities")?.inserido;
    expect(ATIVIDADE_DA_PRESENCA_CONFIRMADA).toBe("appointment_patient_confirmed");
    expect(atividade).toMatchObject({
      organization_id: ORG,
      lead_id: "lead-1",
      contact_id: CONTATO,
      type: ATIVIDADE_DA_PRESENCA_CONFIRMADA,
      source_module: "agenda",
      source_id: COMPROMISSO,
      actor_kind: "system",
    });
  });

  it("confirmado: audita agenda.paciente_confirmou, ator sistema, com compromisso e origem", async () => {
    await ler();

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agenda.paciente_confirmou",
        organizationId: ORG,
        actorUserId: null,
        resourceType: "calendar_appointment",
        resourceId: COMPROMISSO,
        requestId: "req-1",
        metadata: { appointment_id: COMPROMISSO, source: "mensagem" },
      }),
    );
  });

  it.each(["ja_confirmado", "nao_se_aplica"])("%s: sem atividade nem auditoria", async (resultado) => {
    // Segundo "sim", compromisso remarcado (revisão nova), passado ou cancelado:
    // quem decide é o RPC; aqui só não se conta uma confirmação que não houve.
    resultadoDoRpc = { data: resultado, error: null };

    await expect(ler()).resolves.toBe(resultado);
    expect(consultas.some((c) => c.tabela === "crm_lead_activities")).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  const avisos = () =>
    rpcs.filter((r) => r.nome === "emit_event" && r.args.p_event_type === "crm.activity_write_failed");

  it("contato sem negócio aberto: a confirmação vale, a auditoria sai, e o aviso aponta o contato", async () => {
    leadsDoContato = [];

    await expect(ler()).resolves.toBe("confirmado");
    expect(consultas.some((c) => c.tabela === "crm_lead_activities")).toBe(false);
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0]?.args.p_entity_id).toBe(CONTATO);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("atividade que não grava vira aviso no NEGÓCIO e não apaga a auditoria", async () => {
    erroDaAtividade = { message: "boom" };

    await expect(ler()).resolves.toBe("confirmado");
    expect(avisos()).toHaveLength(1);
    expect(avisos()[0]?.args.p_entity_id).toBe("lead-1");
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("erro do RPC sobe (quem chama registra no log) e não conta confirmação", async () => {
    resultadoDoRpc = { data: null, error: { message: "patient_confirm_message_not_evidence", code: "42501" } };

    await expect(ler()).rejects.toThrow(/patient_confirm_message_not_evidence/);
    expect(audit).not.toHaveBeenCalled();
  });
});
