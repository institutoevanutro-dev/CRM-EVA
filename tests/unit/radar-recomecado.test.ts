import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { ativoDesdeORecomeco, lerInicioDoRadar } from "@/lib/leads/inicio-do-radar";
import { carregaRadarDeRisco } from "@/lib/leads/radar-de-risco";

/**
 * RECOMEÇAR O RADAR (migration 0370). A clínica que acabou de adotar o CRM via
 * 241 "críticos" e 50 demandas sem próximo passo das semanas anteriores. Com
 * `settings.radar.desde`, o radar ignora o que não teve atividade desde então,
 * sem apagar nada, e o que ganhar atividade nova volta.
 *
 * O banco falso APLICA os filtros que o radar usa, inclusive o `or` e o `gte`
 * sobre o contato embutido com `!inner`, e HONRA o `limit`: é o que deixa provar
 * que o corte mora na consulta (antes do teto de 500), e não em JS depois dele.
 */

vi.mock("@/lib/agenda/protecao-followup", () => ({
  protecaoAgendaSupabase: async () => new Map(),
}));

const ORG = "org-1";
const AGORA = new Date("2026-10-16T12:00:00.000Z");
const DESDE = "2026-10-10T12:00:00.000Z";
const ANTES = "2026-09-20T12:00:00.000Z"; // antes do recomeço, e frio
const DEPOIS = "2026-10-12T12:00:00.000Z"; // depois do recomeço, e frio (4 dias)

type Linha = Record<string, unknown>;

function bancoFalso(tabelas: Record<string, Linha[]>): SupabaseClient {
  const from = (tabela: string) => {
    let linhas = [...(tabelas[tabela] ?? [])];
    let colunas = "";
    const contatoDe = (l: Linha) =>
      (tabelas.contacts ?? []).find((c) => c.id === l.contact_id) ?? null;
    const chain = {
      select: (c: string) => {
        colunas = c;
        // O embed do contato, como o PostgREST faria: `!inner` descarta quem não tem.
        if (/contacts!inner\(/.test(c)) linhas = linhas.filter((l) => contatoDe(l) !== null);
        if (/contacts(!inner)?\(/.test(c)) linhas = linhas.map((l) => ({ ...l, contacts: contatoDe(l) }));
        // `settings->radar` com apelido.
        if (/radar:settings->radar/.test(c)) linhas = linhas.map((l) => ({ ...l, radar: (l.settings as Linha)?.radar }));
        return chain;
      },
      eq: (col: string, val: unknown) => ((linhas = linhas.filter((l) => l[col] === val)), chain),
      is: (col: string, val: unknown) => ((linhas = linhas.filter((l) => (l[col] ?? null) === val)), chain),
      in: (col: string, vals: unknown[]) => ((linhas = linhas.filter((l) => vals.includes(l[col]))), chain),
      not: (col: string, _op: string, lista: string) => {
        const vals = lista.replace(/^\(|\)$/g, "").split(",");
        linhas = linhas.filter((l) => !vals.includes(String(l[col])));
        return chain;
      },
      gt: (col: string, val: string) => ((linhas = linhas.filter((l) => String(l[col] ?? "") > val)), chain),
      gte: (col: string, val: string) => {
        const valor = (l: Linha) =>
          col.startsWith("contacts.") ? (l.contacts as Linha | null)?.[col.slice(9)] : l[col];
        linhas = linhas.filter((l) => {
          const v = valor(l);
          return typeof v === "string" && Date.parse(v) >= Date.parse(val);
        });
        return chain;
      },
      or: (expr: string) => {
        const termos = expr.split(",").map((t) => {
          const [col, op, ...resto] = t.split(".");
          if (op !== "gte") throw new Error(`operador não suportado no dublê: ${op}`);
          return { col: col!, val: resto.join(".") };
        });
        linhas = linhas.filter((l) =>
          termos.some(({ col, val }) => typeof l[col] === "string" && Date.parse(l[col] as string) >= Date.parse(val)),
        );
        return chain;
      },
      order: () => chain,
      limit: (n: number) => ((linhas = linhas.slice(0, n)), chain),
      maybeSingle: async () => ({ data: linhas[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: linhas, error: null, colunas }).then(res),
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

const lead = (id: string, ultima: string, contato: string | null = null): Linha => ({
  id, organization_id: ORG, status: "open", title: id, pipeline_id: "funil", contact_id: contato,
  owner_user_id: null, owner_kind: null, owner_agent_id: null, stage_id: null,
  last_activity_at: ultima, created_at: ANTES,
});
const demanda = (id: string, aberta: string, contato: string): Linha => ({
  id, organization_id: ORG, lead_id: null, contact_id: contato, aberta_em: aberta, updated_at: aberta,
  origem: "inbound", fechada_em: null, proximo_passo: null,
});
const contato = (id: string, ultima: string): Linha => ({
  id, organization_id: ORG, name: `Paciente ${id}`, display_name: null, last_activity_at: ultima,
});

function banco(desde: string | null, extra: Partial<Record<string, Linha[]>> = {}) {
  return bancoFalso({
    organizations: [{ id: ORG, settings: desde ? { radar: { desde }, llm: { provider: "x" } } : {} }],
    crm_pipelines: [{ id: "funil", organization_id: ORG, is_archived: false }],
    contacts: [contato("c-velho", ANTES), contato("c-voltou", DEPOIS), ...(extra.contacts ?? [])],
    crm_leads: [
      lead("lead-velho", ANTES, "c-velho"),
      lead("lead-novo", DEPOIS),
      // Negócio parado desde antes, mas o paciente escreveu depois do recomeço.
      lead("lead-paciente-voltou", ANTES, "c-voltou"),
      ...(extra.crm_leads ?? []),
    ],
    demandas: [
      demanda("demanda-velha", ANTES, "c-velho"),
      demanda("demanda-nova", DEPOIS, "c-velho"),
      demanda("demanda-paciente-voltou", ANTES, "c-voltou"),
    ],
    conversations: [],
    cron_jobs: [],
  });
}

describe("o instante do recomeço (regra pura)", () => {
  it("lê só um instante válido; forma estranha vale ausência", () => {
    expect(lerInicioDoRadar({ desde: DESDE })).toBe(DESDE);
    expect(lerInicioDoRadar({ desde: "ontem" })).toBeNull();
    expect(lerInicioDoRadar({ desde: 123 })).toBeNull();
    expect(lerInicioDoRadar(null)).toBeNull();
    expect(lerInicioDoRadar("2026-10-10")).toBeNull();
  });

  it("antes do recomeço sai, depois fica, e atividade nova traz de volta", () => {
    expect(ativoDesdeORecomeco(DESDE, [ANTES])).toBe(false);
    expect(ativoDesdeORecomeco(DESDE, [DEPOIS])).toBe(true);
    expect(ativoDesdeORecomeco(DESDE, [DESDE])).toBe(true);
    // O negócio é velho, mas a conversa do contato teve atividade depois.
    expect(ativoDesdeORecomeco(DESDE, [ANTES, null, DEPOIS])).toBe(true);
    expect(ativoDesdeORecomeco(DESDE, [null, undefined])).toBe(false);
    // Sem recomeço, tudo conta.
    expect(ativoDesdeORecomeco(null, [ANTES])).toBe(true);
  });
});

describe("radar de risco recomeçado", () => {
  it("sem recomeço, o radar é o de sempre", async () => {
    const radar = await carregaRadarDeRisco(banco(null), { organizationId: ORG, now: AGORA });
    expect(radar.recomecado_em).toBeNull();
    expect(radar.items.map((l) => l.id).sort()).toEqual(["lead-novo", "lead-paciente-voltou", "lead-velho"]);
    expect(radar.sem_proximo_passo.map((d) => d.id).sort()).toEqual([
      "demanda-nova",
      "demanda-paciente-voltou",
      "demanda-velha",
    ]);
  });

  it("recomeçado: sai o que só teve atividade antes, fica o novo e volta quem teve atividade nova", async () => {
    const radar = await carregaRadarDeRisco(banco(DESDE), { organizationId: ORG, now: AGORA });
    expect(radar.recomecado_em).toBe(DESDE);
    expect(radar.items.map((l) => l.id).sort()).toEqual(["lead-novo", "lead-paciente-voltou"]);
    expect(radar.counts.critico + radar.counts.em_risco + radar.counts.em_voo).toBe(2);
    expect(radar.total).toBe(2);
    expect(radar.sem_proximo_passo.map((d) => d.id).sort()).toEqual(["demanda-nova", "demanda-paciente-voltou"]);
    expect(radar.total_sem_proximo_passo).toBe(2);
  });

  it("o negócio que voltou continua medido pelo próprio relógio (não fica 'em dia' de mentira)", async () => {
    const radar = await carregaRadarDeRisco(banco(DESDE), { organizationId: ORG, now: AGORA });
    const voltou = radar.items.find((l) => l.id === "lead-paciente-voltou");
    expect(voltou?.last_activity_at).toBe(ANTES);
    expect(voltou?.hours_since_activity).toBe(Math.round((AGORA.getTime() - Date.parse(ANTES)) / 3_600_000));
  });

  it("o corte mora na CONSULTA: 500 negócios de antes do recomeço não tomam a vaga do novo", async () => {
    const velhos = Array.from({ length: 500 }, (_, i) => lead(`velho-${i}`, ANTES));
    const radar = await carregaRadarDeRisco(banco(DESDE, { crm_leads: velhos }), {
      organizationId: ORG,
      now: AGORA,
    });
    expect(radar.items.map((l) => l.id)).toContain("lead-novo");
    expect(radar.items.some((l) => l.id.startsWith("velho-"))).toBe(false);
  });
});
