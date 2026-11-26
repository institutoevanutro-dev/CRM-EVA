import { beforeEach, describe, expect, it, vi } from "vitest";

import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import {
  leadParaEspelharNaAgenda,
  moverLeadParaEtapaDeAgendamento,
  SLUG_ETAPA_POR_TRANSICAO,
} from "@/lib/leads/appointment-stage-move";

vi.mock("@/lib/leads/activity-emitter", async (orig) => ({
  ...(await orig<typeof import("@/lib/leads/activity-emitter")>()),
  emitLeadActivity: vi.fn(async () => ({ ok: true })),
}));

const ORG = "org-1";
const LEAD = {
  id: "lead-1",
  pipeline_id: "pipe-1",
  stage_id: "s1",
  contact_id: "contato-1",
  status: "open",
};
const ETAPA_AGENDADO = { id: "s-agendado", name: "Agendado", position: 2000, is_won: false };
const ETAPA_ORIGEM = { name: "Agendamento solicitado", position: 1000 };

interface Resposta {
  data: unknown;
  error: { message: string } | null;
}
interface Cenario {
  lead: Resposta;
  etapaDestino: Resposta;
  update: Resposta;
  rpcError?: { message: string } | null;
  etapaPorSlug?: (slug: string) => Resposta;
  /** A etapa ATUAL do card (a leitura sem slug). Padrão: `ETAPA_ORIGEM`. */
  origem?: Resposta;
}

function cenario(over: Partial<Cenario> = {}): Cenario {
  return {
    lead: { data: LEAD, error: null },
    etapaDestino: { data: ETAPA_AGENDADO, error: null },
    update: { data: [{ id: LEAD.id }], error: null },
    ...over,
  };
}

interface ChamadaRpc {
  fn: string;
  args: Record<string, unknown>;
}

/** Mesmo fake de query builder de `handoff-stage-move.test.ts`. */
function fakeAdmin(c: Cenario, rpcs: ChamadaRpc[] = []) {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      return Promise.resolve({ data: null, error: c.rpcError ?? null });
    },
    from(tabela: string) {
      const b = {
        _update: false,
        _select: false,
        _eqKeys: [] as string[],
        _slugVal: undefined as string | undefined,
        select: () => {
          b._select = true;
          return b;
        },
        update: () => {
          b._update = true;
          return b;
        },
        eq: (key: string, val?: unknown) => {
          b._eqKeys.push(key);
          if (key === "slug" && typeof val === "string") b._slugVal = val;
          return b;
        },
        maybeSingle: () => {
          if (tabela === "crm_leads") return Promise.resolve(c.lead);
          if (b._eqKeys.includes("slug")) {
            if (c.etapaPorSlug && b._slugVal) return Promise.resolve(c.etapaPorSlug(b._slugVal));
            return Promise.resolve(c.etapaDestino);
          }
          return Promise.resolve(c.origem ?? { data: ETAPA_ORIGEM, error: null });
        },
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          const r = b._update ? c.update : c.lead;
          return Promise.resolve(r).then(onF, onR);
        },
      };
      return b;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const mover = (c: Cenario, transicao: "pending" | "confirmed" | "completed" = "confirmed") =>
  moverLeadParaEtapaDeAgendamento(fakeAdmin(c), {
    organizationId: ORG,
    leadId: LEAD.id,
    transicao,
  });

async function moverObservando(c: Cenario, transicao: "pending" | "confirmed" | "completed" = "confirmed") {
  const rpcs: ChamadaRpc[] = [];
  const r = await moverLeadParaEtapaDeAgendamento(fakeAdmin(c, rpcs), {
    organizationId: ORG,
    leadId: LEAD.id,
    transicao,
  });
  return { r, eventos: rpcs.filter((x) => x.fn === "emit_event") };
}

describe("moverLeadParaEtapaDeAgendamento", () => {
  beforeEach(() => vi.mocked(emitLeadActivity).mockClear());

  it("caminho feliz: confirmado move para 'agendado' e emite atividade + evento", async () => {
    const { r, eventos } = await moverObservando(cenario(), "confirmed");
    expect(r).toEqual({ moveu: true, motivo: "movido" });
    expect(vi.mocked(emitLeadActivity)).toHaveBeenCalledTimes(1);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.args).toMatchObject({
      p_event_type: "lead.stage_changed",
      p_payload: expect.objectContaining({ to_stage_id: ETAPA_AGENDADO.id }),
    });
  });

  it("pending move para 'agendamento-solicitado'", async () => {
    const etapa = { id: "s-solicitado", name: "Agendamento solicitado" };
    const r = await mover(cenario({ etapaDestino: { data: etapa, error: null } }), "pending");
    expect(r).toEqual({ moveu: true, motivo: "movido" });
  });

  it("transição sem mapa (ex.: cancelled) é no-op sem tocar o banco", async () => {
    // @ts-expect-error -- transição fora do vocabulário mapeado, de propósito
    const r = await mover(cenario(), "cancelled");
    expect(r).toEqual({ moveu: false, motivo: "transicao_nao_mapeada" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("pipeline sem a etapa mapeada: no-op, sem mover nem gravar atividade", async () => {
    const r = await mover(cenario({ etapaDestino: { data: null, error: null } }));
    expect(r).toEqual({ moveu: false, motivo: "sem_etapa_mapeada" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("lead já está na etapa alvo: não move de novo", async () => {
    const r = await mover(
      cenario({ lead: { data: { ...LEAD, stage_id: ETAPA_AGENDADO.id }, error: null } }),
    );
    expect(r).toEqual({ moveu: false, motivo: "ja_esta_la" });
  });

  it("lead fechado (won/lost) não é movido — deal encerrado não volta ao funil", async () => {
    const r = await mover(cenario({ lead: { data: { ...LEAD, status: "lost" }, error: null } }));
    expect(r).toEqual({ moveu: false, motivo: "lead_fechado" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("lead não encontrado (org errada ou deletado): não move, não é erro de sistema", async () => {
    const r = await mover(cenario({ lead: { data: null, error: null } }));
    expect(r).toEqual({ moveu: false, motivo: "lead_nao_encontrado" });
  });

  it("UPDATE sem linha afetada = humano moveu o card no meio da operação (trava otimista)", async () => {
    const r = await mover(cenario({ update: { data: [], error: null } }));
    expect(r).toEqual({ moveu: false, motivo: "conflito_humano" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("erro no SELECT do lead é indisponibilidade, não 'lead_nao_encontrado'", async () => {
    const r = await mover(cenario({ lead: { data: null, error: { message: "fetch failed" } } }));
    expect(r).toEqual({ moveu: false, motivo: "indisponivel" });
  });

  it("erro no UPDATE é falha_de_escrita", async () => {
    const r = await mover(cenario({ update: { data: null, error: { message: "constraint violation" } } }));
    expect(r).toEqual({ moveu: false, motivo: "falha_de_escrita" });
  });

  it("mapa de slugs é o contrato estável que a tela de Pipelines documenta", () => {
    expect(SLUG_ETAPA_POR_TRANSICAO).toEqual({
      pending: "agendamento-solicitado",
      confirmed: "agendado",
      completed: "compareceu",
    });
  });

  it("encontra etapa legada com sublinhado ('agendamento_solicitado') se não houver etapa com hífen", async () => {
    const c = cenario({
      etapaPorSlug: (slug: string) => {
        if (slug === "agendamento_solicitado") {
          return { data: { id: "s-legada", name: "Agendamento Solicitado" }, error: null };
        }
        return { data: null, error: null };
      },
    });
    const r = await mover(c, "pending");
    expect(r).toEqual({ moveu: true, motivo: "movido" });
  });

  it("erro de banco na busca pelo slug legado é indisponibilidade, não 'sem_etapa_mapeada'", async () => {
    const c = cenario({
      etapaPorSlug: (slug: string) =>
        slug === "agendamento_solicitado"
          ? { data: null, error: { message: "fetch failed" } }
          : { data: null, error: null },
    });
    const r = await mover(c, "pending");
    expect(r).toEqual({ moveu: false, motivo: "indisponivel" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });
  it("compareceu leva o card aberto para a etapa 'compareceu'", async () => {
    const etapa = { id: "s-compareceu", name: "Compareceu", position: 7000, is_won: true };
    const c = cenario({ etapaPorSlug: (slug) => (slug === "compareceu" ? { data: etapa, error: null } : { data: null, error: null }) });
    const { r, eventos } = await moverObservando(c, "completed");
    expect(r).toEqual({ moveu: true, motivo: "movido" });
    expect(eventos[0]?.args).toMatchObject({ p_payload: expect.objectContaining({ to_stage_id: "s-compareceu" }) });
  });

  it("só para frente: confirmar não devolve um card que já passou da etapa 'agendado'", async () => {
    const c = cenario({ origem: { data: { name: "Comprovante em conferência", position: 5500 }, error: null } });
    const r = await mover(c, "confirmed");
    expect(r).toEqual({ moveu: false, motivo: "etapa_anterior" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("etapa na MESMA posição também não move (empate não é avanço)", async () => {
    const c = cenario({ origem: { data: { name: "Outra", position: 2000 }, error: null } });
    expect(await mover(c, "confirmed")).toEqual({ moveu: false, motivo: "etapa_anterior" });
  });

  it("card ganho no sinal segue para 'compareceu' quando ela também é etapa de ganho", async () => {
    const etapa = { id: "s-compareceu", name: "Compareceu", position: 7000, is_won: true };
    const c = cenario({
      lead: { data: { ...LEAD, status: "won", stage_id: "s-sinal" }, error: null },
      origem: { data: { name: "Sinal pago", position: 6000 }, error: null },
      etapaPorSlug: () => ({ data: etapa, error: null }),
    });
    expect(await mover(c, "completed")).toEqual({ moveu: true, motivo: "movido" });
  });

  it("card ganho NÃO é reaberto: destino aberto devolve lead_fechado sem escrever", async () => {
    const c = cenario({ lead: { data: { ...LEAD, status: "won" }, error: null } });
    expect(await mover(c, "confirmed")).toEqual({ moveu: false, motivo: "lead_fechado" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("card perdido não se mexe nem quando o paciente comparece", async () => {
    const c = cenario({ lead: { data: { ...LEAD, status: "lost" }, error: null } });
    expect(await mover(c, "completed")).toEqual({ moveu: false, motivo: "lead_fechado" });
  });

  it("erro ao ler a etapa de origem é indisponibilidade: sem ela não se sabe a direção", async () => {
    const c = cenario({ origem: { data: null, error: { message: "fetch failed" } } });
    expect(await mover(c, "confirmed")).toEqual({ moveu: false, motivo: "indisponivel" });
    expect(vi.mocked(emitLeadActivity)).not.toHaveBeenCalled();
  });

  it("o evento leva o status DEPOIS do movimento (aberto que entra em etapa de ganho sai ganho)", async () => {
    const etapa = { id: "s-compareceu", name: "Compareceu", position: 7000, is_won: true };
    const c = cenario({
      etapaPorSlug: () => ({ data: etapa, error: null }),
      update: { data: [{ id: LEAD.id, status: "won" }], error: null },
    });
    const { eventos } = await moverObservando(c, "completed");
    expect(eventos[0]?.args).toMatchObject({ p_payload: expect.objectContaining({ status: "won" }) });
  });
});

/** Fake mínimo para a escolha do card: `in`/`eq` acumulam filtros e o `await` devolve a lista. */
function fakeEscolha(etapas: Resposta, leads: Resposta) {
  return {
    from(tabela: string) {
      const b = {
        select: () => b,
        eq: () => b,
        in: () => b,
        then(onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) {
          return Promise.resolve(tabela === "crm_stages" ? etapas : leads).then(onF, onR);
        },
      };
      return b;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const escolher = (etapas: Resposta, leads: Resposta, transicao: "confirmed" | "completed", leadAtivo: string | null) =>
  leadParaEspelharNaAgenda(fakeEscolha(etapas, leads), { organizationId: ORG, contactId: "contato-1", transicao, leadAtivo });

describe("leadParaEspelharNaAgenda", () => {
  const FUNIL = { data: [{ pipeline_id: "pipe-atendimento" }], error: null };

  it("nenhum funil tem a etapa: devolve o card da timeline, como antes", async () => {
    expect(await escolher({ data: [], error: null }, { data: [], error: null }, "confirmed", "lead-1")).toBe("lead-1");
  });

  it("o card da timeline está num funil com a etapa: é ele", async () => {
    const leads = { data: [{ id: "lead-1", status: "open", last_activity_at: null, closed_at: null, created_at: "2026-11-01T00:00:00Z" }], error: null };
    expect(await escolher(FUNIL, leads, "confirmed", "lead-1")).toBe("lead-1");
  });

  it("card de protocolo na timeline, card de atendimento ganho: o comparecimento vai ao do atendimento", async () => {
    const leads = { data: [{ id: "lead-sinal", status: "won", last_activity_at: null, closed_at: "2026-11-20T00:00:00Z", created_at: "2026-11-01T00:00:00Z" }], error: null };
    expect(await escolher(FUNIL, leads, "completed", "lead-protocolo")).toBe("lead-sinal");
  });

  it("aberto vence ganho, e o aberto mais recente vence o antigo", async () => {
    const leads = {
      data: [
        { id: "ganho", status: "won", last_activity_at: null, closed_at: "2026-11-24T00:00:00Z", created_at: "2026-10-01T00:00:00Z" },
        { id: "aberto-velho", status: "open", last_activity_at: "2026-11-01T00:00:00Z", closed_at: null, created_at: "2026-10-01T00:00:00Z" },
        { id: "aberto-novo", status: "open", last_activity_at: "2026-11-22T00:00:00Z", closed_at: null, created_at: "2026-10-02T00:00:00Z" },
      ],
      error: null,
    };
    expect(await escolher(FUNIL, leads, "completed", null)).toBe("aberto-novo");
  });

  it("falha de leitura nunca troca o card: devolve o da timeline", async () => {
    expect(await escolher({ data: null, error: { message: "fetch failed" } }, { data: [], error: null }, "completed", "lead-1")).toBe("lead-1");
    expect(await escolher(FUNIL, { data: null, error: { message: "fetch failed" } }, "completed", "lead-1")).toBe("lead-1");
  });
});
