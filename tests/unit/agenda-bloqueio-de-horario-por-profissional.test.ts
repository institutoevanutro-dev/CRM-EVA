import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { horariosLivresDaOrg, type ResultadoDaConsulta } from "@/lib/agenda/consulta";

/**
 * BLOQUEAR UM HORÁRIO DE UMA PESSOA — e só dela, e só naquele horário.
 *
 * A tela "Dias fora da rotina" passou a gravar faixa (14:00 a 16:00) e dono
 * (`user_id`) escolhido por quem gerencia. A pergunta que este arquivo responde
 * é se o motor de horários livres já fazia o resto:
 *
 *   1. a faixa tira SÓ os horários que ela cobre, não o dia inteiro;
 *   2. tira só da agenda do DONO do bloqueio, não da colega ao lado.
 *
 * Os dois passam pela mesma `horariosLivresDaOrg` que responde a tela de marcar
 * (`GET /api/v1/agenda/horarios-livres`), a escrita do agendamento
 * (`exigeHorarioLivre`) e as ferramentas de agenda da IA
 * (`lib/mcp/tools/agendamento.ts`). Uma régua, três consumidores.
 *
 * O que NÃO mede: Postgres e RLS (o dublê filtra em memória, como o de
 * `agenda-excecao-de-data-no-fuso-da-regra.test.ts`); quem mede o banco é o e2e
 * `tests/e2e/agenda-bloquear-horario-do-profissional.spec.ts`.
 */

const TZ = "America/Sao_Paulo";
const ORG = "org-1";
const DRA = "dra-ana";
const DR = "dr-bruno";
const TIPO_ID = "11111111-1111-4111-8111-111111111111";
const DIA = "2026-10-20"; // terça

/** 09:00 a 18:00 todos os dias, para os dois. */
const JANELA = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: "09:00", end: "18:00" }));

/** O dia inteiro em São Paulo (-03): 03:00Z do dia até 03:00Z do seguinte. */
const DE = new Date(`${DIA}T03:00:00.000Z`);
const ATE = new Date("2026-10-21T02:59:00.000Z");
const AGORA = new Date("2026-10-19T12:00:00.000Z");

type Linha = Record<string, unknown>;

/** Dublê que FILTRA de verdade: um `.eq("user_id")` ignorado faria o caso 2 passar à toa. */
function clienteFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  function daTabela(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    const linhas = () => (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    const compara = (c: string, v: unknown, ok: (a: string, b: string) => boolean) => {
      filtros.push((l) => ok(String(l[c]), String(v)));
      return api;
    };
    const api = {
      select: () => api,
      eq: (c: string, v: unknown) => {
        filtros.push((l) => l[c] === v);
        return api;
      },
      gte: (c: string, v: unknown) => compara(c, v, (a, b) => a >= b),
      lte: (c: string, v: unknown) => compara(c, v, (a, b) => a <= b),
      lt: (c: string, v: unknown) => compara(c, v, (a, b) => a < b),
      gt: (c: string, v: unknown) => compara(c, v, (a, b) => a > b),
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: linhas(), error: null }).then(resolve),
    };
    return api;
  }
  return {
    from: (tabela: string) => daTabela(tabela),
    rpc: async (fn: string) => {
      if (fn === "fn_google_coverage") return { data: false, error: null };
      if (fn === "fn_agenda_ocupacao_google_do_dono" || fn === "fn_agenda_conexoes_google_do_dono") {
        return { data: [], error: null };
      }
      throw new Error(`[duble] rpc não prevista: ${fn}`);
    },
  } as unknown as SupabaseClient;
}

function tabelas(bloqueios: Linha[]): Record<string, Linha[]> {
  return {
    calendar_event_types: [
      {
        id: TIPO_ID,
        organization_id: ORG,
        name: "Consulta",
        is_active: true,
        duration_minutes: 60,
        buffer_before_minutes: 0,
        buffer_after_minutes: 0,
        minimum_notice_minutes: 0,
        slot_interval_minutes: 60,
        booking_window_days: 365,
        default_owner_user_id: DRA,
      },
    ],
    attendant_availability: [DRA, DR].map((user_id) => ({
      organization_id: ORG,
      user_id,
      schedule: { timezone: TZ, windows: JANELA },
    })),
    calendar_availability_exceptions: bloqueios,
    calendar_appointments: [],
    calendar_connections: [],
    calendar_selected_external_events: [],
  };
}

/** 14:00 a 16:00 na agenda da Dra. Ana, que é o que a tela grava. */
const BLOQUEIO_DA_DRA = {
  organization_id: ORG,
  user_id: DRA,
  exception_date: DIA,
  is_unavailable: true,
  start_minute: 14 * 60,
  end_minute: 16 * 60,
};

async function horasLivres(dono: string, bloqueios: Linha[]): Promise<string[]> {
  const r: ResultadoDaConsulta = await horariosLivresDaOrg(clienteFalso(tabelas(bloqueios)), ORG, {
    eventTypeId: TIPO_ID,
    ownerUserId: dono,
    de: DE,
    ate: ATE,
    agora: AGORA,
  });
  if (!r.ok) throw new Error(`a coleta recusou: ${r.codigo} — ${r.motivoParaOperador}`);
  // Hora local de São Paulo (-03), sem depender do fuso da máquina.
  return r.slots.map((s) => {
    const h = (s.inicio.getUTCHours() + 24 - 3) % 24;
    return `${String(h).padStart(2, "0")}:${String(s.inicio.getUTCMinutes()).padStart(2, "0")}`;
  });
}

const DIA_CHEIO = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];

describe("bloqueio de horário de um profissional", () => {
  it("controle: sem bloqueio, os dois têm o dia cheio", async () => {
    expect(await horasLivres(DRA, [])).toEqual(DIA_CHEIO);
    expect(await horasLivres(DR, [])).toEqual(DIA_CHEIO);
  });

  it("14:00 a 16:00 tira SÓ 14:00 e 15:00 da Dra. Ana, e o resto do dia fica", async () => {
    expect(await horasLivres(DRA, [BLOQUEIO_DA_DRA])).toEqual(
      DIA_CHEIO.filter((h) => h !== "14:00" && h !== "15:00"),
    );
  });

  it("o bloqueio da Dra. Ana não mexe na agenda do Dr. Bruno", async () => {
    expect(await horasLivres(DR, [BLOQUEIO_DA_DRA])).toEqual(DIA_CHEIO);
  });
});
