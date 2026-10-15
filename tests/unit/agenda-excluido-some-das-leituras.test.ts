/**
 * O AGENDAMENTO EXCLUÍDO (migration 0364) SOME DE TODA LEITURA QUE MOSTRA OU
 * OCUPA — provado no EFEITO, sobre um dublê que aplica os filtros de verdade.
 *
 * `listaAgendamentos` é a fonte da grade, das abas "Próximos / Aguardando
 * confirmação / Passados / Cancelados" (o GET da Agenda), da visão do contato e
 * do negócio e da ferramenta de listagem da IA. `coletaOQueOcupa` é a fonte dos
 * horários livres (tela, IA e a escrita). Se o excluído vazar em qualquer uma,
 * ele volta a aparecer, ou a segurar horário.
 *
 * Três linhas: um compromisso vivo, um cancelado de verdade (que continua na aba
 * "Cancelados") e um excluído (que é sempre `cancelled`, pela constraint
 * `calendar_appointments_exclusao_coerente`).
 *
 *     npx vitest run tests/unit/agenda-excluido-some-das-leituras.test.ts
 */
import { readFileSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { coletaOQueOcupa, listaAgendamentos } from "@/lib/agenda/consulta";

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const DONO = "bbbbbbbb-0000-4000-8000-00000000000b";
const CONTATO = "dddddddd-0000-4000-8000-00000000000d";

type Linha = Record<string, unknown>;
const base = (id: string, inicio: string, extra: Linha): Linha => ({
  id,
  organization_id: ORG,
  owner_user_id: DONO,
  contact_id: CONTATO,
  title: id,
  starts_at: inicio,
  ends_at: new Date(Date.parse(inicio) + 30 * 60_000).toISOString(),
  time_zone: "America/Sao_Paulo",
  revision: 1,
  excluded_at: null,
  contacts: { name: "Paciente Fictício", display_name: null },
  ...extra,
});

const LINHAS: Linha[] = [
  base("vivo", "2099-03-02T13:00:00.000Z", { status: "confirmed" }),
  base("cancelado", "2099-03-02T14:00:00.000Z", { status: "cancelled" }),
  base("excluido", "2099-03-02T15:00:00.000Z", { status: "cancelled", excluded_at: "2026-10-15T12:00:00Z" }),
];

/** Dublê que FILTRA: cada método da cadeia vira predicado sobre `LINHAS`. */
function banco(): SupabaseClient {
  return {
    from: () => {
      const preds: Array<(l: Linha) => boolean> = [];
      const cadeia: Record<string, unknown> = {};
      const add = (p: (l: Linha) => boolean) => (preds.push(p), cadeia);
      Object.assign(cadeia, {
        select: () => cadeia,
        eq: (c: string, v: unknown) => add((l) => l[c] === v),
        neq: (c: string, v: unknown) => add((l) => l[c] !== v),
        is: (c: string, v: unknown) => add((l) => (l[c] ?? null) === v),
        in: (c: string, v: unknown[]) => add((l) => v.includes(l[c])),
        gte: (c: string, v: string) => add((l) => String(l[c]) >= v),
        gt: (c: string, v: string) => add((l) => String(l[c]) > v),
        lt: (c: string, v: string) => add((l) => String(l[c]) < v),
        order: () => cadeia,
        limit: () => cadeia,
        then: (r: (v: unknown) => unknown) => r({ data: LINHAS.filter((l) => preds.every((p) => p(l))), error: null }),
      });
      return cadeia;
    },
    rpc: async () => ({ data: [], error: null }),
  } as unknown as SupabaseClient;
}

const ids = async (params: Parameters<typeof listaAgendamentos>[2]) => {
  const r = await listaAgendamentos(banco(), ORG, params);
  if (!r.ok) throw new Error(r.motivoParaOperador);
  return r.agendamentos.map((a) => a.id);
};

const PARAMS = { contactId: null, leadId: null, ownerUserId: null, dia: null, de: null, ate: null, situacao: null, limite: 200 };

describe("o agendamento excluído some das leituras", () => {
  it("a grade e as listas (recorte de/ate do GET da Agenda) não o mostram; o cancelado de verdade fica", async () => {
    expect(await ids({ ...PARAMS, de: "2099-03-02T00:00:00.000Z", ate: "2099-03-03T00:00:00.000Z" })).toEqual([
      "vivo",
      "cancelado",
    ]);
  });

  it('a aba "Cancelados" (situacao=cancelled) mostra só o cancelado de verdade', async () => {
    expect(
      await ids({ ...PARAMS, situacao: "cancelled", de: "2099-03-02T00:00:00.000Z", ate: "2099-03-03T00:00:00.000Z" }),
    ).toEqual(["cancelado"]);
  });

  it("a visão do contato e a ferramenta de listagem da IA (por contato) não o mostram", async () => {
    expect(await ids({ ...PARAMS, contactId: CONTATO })).toEqual(["vivo", "cancelado"]);
  });

  it("os horários livres: o excluído não segura o horário dele", async () => {
    const r = await coletaOQueOcupa(banco(), ORG, {
      donoId: DONO,
      de: new Date("2099-03-02T00:00:00.000Z"),
      ate: new Date("2099-03-03T00:00:00.000Z"),
    });
    if (!r.ok) throw new Error(r.erro);
    expect(r.ocupados.map((o) => o.inicio.toISOString())).toEqual(["2099-03-02T13:00:00.000Z"]);
  });

  it("a semente da grade (servidor), o funil e os números de Início também filtram", () => {
    for (const arquivo of ["app/app/agenda/page.tsx", "app/api/v1/metrics/funil/route.ts", "lib/inicio/gestao.ts"]) {
      const fonte = readFileSync(arquivo, "utf8");
      const inicio = fonte.indexOf('.from("calendar_appointments")');
      const consulta = fonte.slice(inicio, fonte.indexOf(")", fonte.indexOf(".lt(", inicio)));
      expect(consulta, arquivo).toContain('.is("excluded_at", null)');
    }
  });
});
