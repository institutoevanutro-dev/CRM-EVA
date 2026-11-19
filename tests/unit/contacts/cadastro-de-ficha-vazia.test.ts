/**
 * CADASTRO DE FICHA VAZIA — `settings.crm.cadastro_de_ficha_vazia`.
 *
 * Medido em produção: a IA propôs nome, CPF, e-mail, nascimento e endereço, e
 * ninguém abriu a fila. Com a opção LIGADA, o campo VAZIO é gravado na hora;
 * desligada (o padrão), tudo segue como proposta. Os casos abaixo provam as
 * duas metades, a trava "ainda vazio" no UPDATE e que o CPF não sai em claro
 * nem na timeline nem na auditoria. Dados fictícios.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isValidCpf } from "@/lib/schemas/contacts";
import { cadastroDeFichaVaziaLigado, telefoneDeFichaVaziaLigado } from "@/lib/schemas/settings";

type Linha = Record<string, unknown>;

const ORG = "9a0b7e00-0000-4000-8000-0000000000a1";
const CONTATO = "b1a0b7e0-0000-4000-8000-0000000000a2";
const LEAD = "c2b0b7e0-0000-4000-8000-0000000000a3";
const PIPELINE = "d3b0b7e0-0000-4000-8000-0000000000a4";
const CPF = "52998224725"; // CPF de exemplo, público e fictício
const LIGADA = { crm: { cadastro_de_ficha_vazia: true } };

interface Estado {
  contato: Linha;
  settings?: unknown;
  linhasAtualizadas?: number;
  erroNoUpdate?: { code: string; message: string };
  inseridas: Linha[];
  atualizacoes: Array<{ patch: Linha; filtros: Record<string, unknown> }>;
  atividades: Linha[];
}

let estado: Estado;

/** Valor atual da coluna-trava no contato do dublê. */
function vazio(coluna: string): boolean {
  const c = estado.contato;
  if (coluna === "custom_fields->>endereco") return ((c.custom_fields as Linha | null)?.endereco ?? null) === null;
  return (c[coluna] ?? null) === null;
}

const db = {
  rpc: async (nome: string) => ({ data: nome === "encrypt_cpf" ? "\\xC1F4AD0" : "indice-hmac", error: null }),
  from(tabela: string) {
    if (tabela === "contacts") {
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: estado.contato, error: null }) }) }),
        }),
        update: (patch: Linha) => {
          const filtros: Record<string, unknown> = {};
          const cadeia = {
            eq: (k: string, v: unknown) => ((filtros[k] = v), cadeia),
            is: (k: string, v: unknown) => ((filtros[`${k} IS`] = v), cadeia),
            select: async () => {
              estado.atualizacoes.push({ patch, filtros });
              if (estado.erroNoUpdate) return { data: null, error: estado.erroNoUpdate };
              const coluna = Object.keys(filtros).find((k) => k.endsWith(" IS"))!.slice(0, -3);
              const n = vazio(coluna) ? (estado.linhasAtualizadas ?? 1) : 0;
              return { data: n > 0 ? [{ id: CONTATO }] : [], error: null };
            },
          };
          return cadeia;
        },
      };
    }
    if (tabela === "organizations") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { settings: estado.settings ?? null }, error: null }) }),
        }),
      };
    }
    if (tabela === "crm_leads") {
      return {
        select: () => ({
          eq: () => ({
            eq: async () => ({
              data: [
                {
                  id: LEAD,
                  organization_id: ORG,
                  pipeline_id: PIPELINE,
                  status: "open",
                  last_activity_at: null,
                  created_at: "2026-10-01T00:00:00.000Z",
                },
              ],
              error: null,
            }),
          }),
        }),
      };
    }
    if (tabela === "crm_pipelines") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { id: PIPELINE }, error: null }) }) }),
            }),
          }),
        }),
      };
    }
    if (tabela === "crm_lead_activities") {
      return { insert: (l: Linha) => (estado.atividades.push(l), { error: null }) };
    }
    return {
      insert: (l: Linha) => {
        estado.inseridas.push(l);
        return { select: () => ({ single: async () => ({ data: { id: "proposta-1" }, error: null }) }) };
      },
    };
  },
};

// O client de serviço (CPF) é o MESMO dublê: a cifra e o UPDATE do par passam por ele.
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db }));

const { proporDadoDoContato } = await import("@/lib/contacts/proposta-de-dado");

const FICHA_VAZIA: Linha = {
  id: CONTATO,
  is_anonymized: false,
  email: null,
  name: null,
  display_name: "Jô", // o pushName do WhatsApp mora aqui, não em `name`
  phone_number: "+5527999990000",
  birthdate: null,
  cpf_hash: null,
  custom_fields: { convenio: "Particular" },
  consent: { marketing: { granted: true, granted_at: "2026-01-01T00:00:00.000Z" } },
};

function preparar(contato: Linha, extra: Partial<Estado> = {}) {
  estado = { contato, inseridas: [], atualizacoes: [], atividades: [], ...extra };
}

const propor = (campo: "name" | "email" | "birthdate" | "cpf" | "endereco", valor: string, trecho?: string) =>
  proporDadoDoContato(db as unknown as SupabaseClient, {
    organizationId: ORG,
    contactId: CONTATO,
    campo,
    valor,
    trecho: trecho ?? null,
  });

beforeEach(() => preparar({ ...FICHA_VAZIA }));

describe("a régua da opção", () => {
  it("nasce desligada e só o booleano true liga — independente do telefone", () => {
    expect(cadastroDeFichaVaziaLigado(undefined)).toBe(false);
    expect(cadastroDeFichaVaziaLigado({ crm: { cadastro_de_ficha_vazia: "true" } })).toBe(false);
    expect(cadastroDeFichaVaziaLigado(LIGADA)).toBe(true);
    expect(telefoneDeFichaVaziaLigado(LIGADA)).toBe(false);
    expect(cadastroDeFichaVaziaLigado({ crm: { telefone_de_ficha_vazia: true } })).toBe(false);
  });
});

describe("opção DESLIGADA: tudo continua proposta, como antes", () => {
  it.each([
    ["name", "Joana Teste Silva"],
    ["email", "joana@exemplo.com.br"],
    ["birthdate", "1990-09-14"],
    ["cpf", CPF],
    ["endereco", "Rua das Flores, 100, Centro, Vitória - ES"],
  ] as const)("%s vira proposta e o cadastro não é tocado", async (campo, valor) => {
    preparar({ ...FICHA_VAZIA }, { settings: {} });
    const r = await propor(campo, valor);
    expect(r.criada, JSON.stringify(r)).toBe(true);
    expect(estado.atualizacoes).toHaveLength(0);
    expect(estado.inseridas).toHaveLength(1);
    expect(estado.atividades).toHaveLength(0);
  });
});

describe("opção LIGADA + campo VAZIO: grava na hora", () => {
  it("nome completo: grava em `name` com a trava `name IS null`", async () => {
    preparar({ ...FICHA_VAZIA }, { settings: LIGADA });
    const r = await propor("name", "  Joana   Teste Silva ");
    expect(r).toEqual({ criada: false, motivo: "aplicado_automaticamente", campo: "name", valor: "Joana Teste Silva" });
    expect(estado.inseridas).toHaveLength(0);
    const { patch, filtros } = estado.atualizacoes[0]!;
    expect(patch.name).toBe("Joana Teste Silva");
    expect(filtros).toMatchObject({ organization_id: ORG, id: CONTATO, is_anonymized: false, "name IS": null });
    // A base legal em merge — `marketing` sobrevive.
    expect(patch.consent).toMatchObject({ marketing: { granted: true }, transactional: { granted: true } });
    expect(estado.atividades[0]).toMatchObject({ type: "contact_field_auto_applied", contact_id: CONTATO, lead_id: LEAD });
  });

  it("e-mail e nascimento gravam na própria coluna", async () => {
    preparar({ ...FICHA_VAZIA }, { settings: LIGADA });
    expect(await propor("email", "Joana@Exemplo.com.br")).toMatchObject({ motivo: "aplicado_automaticamente", valor: "joana@exemplo.com.br" });
    expect(await propor("birthdate", "1990-09-14")).toMatchObject({ motivo: "aplicado_automaticamente" });
    expect(estado.atualizacoes.map((a) => a.filtros)).toEqual([
      expect.objectContaining({ "email IS": null }),
      expect.objectContaining({ "birthdate IS": null }),
    ]);
  });

  it("endereço: MESCLA em custom_fields, sem apagar as outras chaves", async () => {
    preparar({ ...FICHA_VAZIA }, { settings: LIGADA });
    const r = await propor("endereco", "Rua das Flores, 100, Centro, Vitória - ES");
    expect(r).toMatchObject({ motivo: "aplicado_automaticamente", campo: "endereco" });
    const { patch, filtros } = estado.atualizacoes[0]!;
    expect(patch.custom_fields).toEqual({ convenio: "Particular", endereco: "Rua das Flores, 100, Centro, Vitória - ES" });
    expect(filtros).toMatchObject({ "custom_fields->>endereco IS": null });
  });

  it("CPF: grava o PAR cifrado, e não sai em claro no desfecho nem na timeline", async () => {
    expect(isValidCpf(CPF)).toBe(true);
    preparar({ ...FICHA_VAZIA }, { settings: LIGADA });
    const r = await propor("cpf", "529.982.247-25", `meu cpf é 529.982.247-25 e nasci em 1990`);
    expect(r).toEqual({ criada: false, motivo: "aplicado_automaticamente", campo: "cpf", valor: "•••.•••.•••-25" });
    const { patch, filtros } = estado.atualizacoes[0]!;
    expect(patch).toMatchObject({ cpf_hash: "indice-hmac", cpf_encrypted: "\\xC1F4AD0" });
    expect(filtros).toMatchObject({ organization_id: ORG, "cpf_hash IS": null });
    const rastro = JSON.stringify(estado.atividades);
    expect(rastro).not.toMatch(/529\.?982\.?247-?25/);
    expect(rastro).toContain("•••.•••.•••-25");
    expect(estado.inseridas).toHaveLength(0);
  });
});

describe("opção LIGADA, mas nada é sobrescrito nem gravado sem forma", () => {
  it("campo JÁ preenchido segue como proposta, sem UPDATE", async () => {
    preparar({ ...FICHA_VAZIA, name: "Joana Antiga", email: "velho@exemplo.com.br", cpf_hash: "outro-indice" }, { settings: LIGADA });
    for (const [campo, valor] of [["name", "Joana Teste Silva"], ["email", "joana@exemplo.com.br"], ["cpf", CPF]] as const) {
      const r = await propor(campo, valor);
      expect(r.criada, `${campo}: ${JSON.stringify(r)}`).toBe(true);
    }
    expect(estado.atualizacoes).toHaveLength(0);
    expect(estado.inseridas).toHaveLength(3);
  });

  it("primeiro nome sozinho NÃO grava: ocuparia o campo e o warning continuaria", async () => {
    preparar({ ...FICHA_VAZIA }, { settings: LIGADA });
    const r = await propor("name", "Joana");
    expect(r.criada).toBe(true);
    expect(estado.atualizacoes).toHaveLength(0);
  });

  it("valor inválido é recusado antes de qualquer escrita", async () => {
    preparar({ ...FICHA_VAZIA }, { settings: LIGADA });
    expect(await propor("cpf", "111.111.111-11")).toEqual({ criada: false, motivo: "valor_invalido" });
    expect(await propor("birthdate", "2999-01-01")).toEqual({ criada: false, motivo: "valor_invalido" });
    expect(await propor("email", "joana-sem-arroba")).toEqual({ criada: false, motivo: "valor_invalido" });
    expect(estado.atualizacoes).toHaveLength(0);
    expect(estado.inseridas).toHaveLength(0);
  });

  it("contato anonimizado é recusado como hoje", async () => {
    preparar({ ...FICHA_VAZIA, is_anonymized: true }, { settings: LIGADA });
    expect(await propor("name", "Joana Teste Silva")).toEqual({ criada: false, motivo: "contato_anonimizado" });
    expect(estado.atualizacoes).toHaveLength(0);
  });

  it("corrida perdida (0 linhas) ou e-mail de outro contato (23505) viram proposta", async () => {
    preparar({ ...FICHA_VAZIA }, { settings: LIGADA, linhasAtualizadas: 0 });
    expect((await propor("name", "Joana Teste Silva")).criada).toBe(true);
    preparar({ ...FICHA_VAZIA }, { settings: LIGADA, erroNoUpdate: { code: "23505", message: "duplicate key" } });
    expect((await propor("email", "joana@exemplo.com.br")).criada).toBe(true);
    expect(estado.inseridas).toHaveLength(1);
  });
});
