/**
 * QUEM SERÁ ATENDIDO — a busca de contato da marcação.
 *
 * O defeito medido (2026-09-18, instalação real): a rota filtrava só
 * `name.ilike`, e TODO contato da base tinha vindo do WhatsApp — nome em
 * `display_name`, `name` nulo. A resposta era `contacts: []` para qualquer
 * termo, inclusive `a`, e nenhum agendamento podia ser vinculado a paciente.
 *
 * O dublê APLICA os filtros de verdade (eq, is, or/ilike) sobre as linhas, em
 * vez de devolver uma lista fixa: sem isso, apagar o `display_name` do OR — ou o
 * `.eq("organization_id", …)` — deixaria estes casos verdes, medindo o dublê em
 * vez do handler.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { GET } from "./route";

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA_ORG = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";

type Linha = Record<string, unknown> & { id: string; organization_id: string };

function contato(over: Partial<Linha> & { id: string }): Linha {
  return {
    organization_id: ORG,
    name: null,
    display_name: null,
    email: null,
    phone_number: null,
    is_anonymized: false,
    is_merged_into: null,
    ...over,
  };
}

/** `ilike` do Postgres: `%` é curinga, `\%`/`\_` são literais, sem caixa. */
function ilike(valor: unknown, padrao: string): boolean {
  if (typeof valor !== "string") return false;
  const literal = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = "";
  let escapando = false;
  for (const ch of padrao) {
    if (escapando) {
      re += literal(ch);
      escapando = false;
    } else if (ch === "\\") escapando = true;
    else if (ch === "%") re += ".*";
    else if (ch === "_") re += ".";
    else re += literal(ch);
  }
  return new RegExp(`^${re}$`, "is").test(valor);
}

/** Uma condição do DSL do `.or()`: `coluna.op.valor`. */
function casaCondicao(linha: Linha, cond: string): boolean {
  const [coluna = "", op = "", ...resto] = cond.split(".");
  const valor = resto.join(".");
  if (op === "ilike") return ilike(linha[coluna], valor);
  if (op === "eq") return String(linha[coluna]) === valor;
  throw new Error(`operador não suportado no dublê: ${op}`);
}

function makeDb(linhas: Linha[]) {
  const orsRecebidos: string[] = [];
  const builder = () => {
    const filtros: Array<(l: Linha) => boolean> = [];
    const q = {
      select: () => q,
      eq: (col: string, v: unknown) => (filtros.push((l) => l[col] === v), q),
      is: (col: string, v: unknown) => (filtros.push((l) => (l[col] ?? null) === v), q),
      // A rota antiga filtrava com `.ilike("name", …)`. O dublê o implementa
      // para que a prova inversa (rodar estes casos contra a versão antiga)
      // falhe pelo MOTIVO certo — a coluna faltando — e não por TypeError.
      ilike: (col: string, padrao: string) => (filtros.push((l) => ilike(l[col], padrao)), q),
      or: (expr: string) => {
        orsRecebidos.push(expr);
        const conds = expr.split(",");
        filtros.push((l) => conds.some((c) => casaCondicao(l, c)));
        return q;
      },
      order: () => q,
      limit: () => q,
      then: (resolve: (r: { data: Linha[]; error: null }) => unknown) =>
        resolve({ data: linhas.filter((l) => filtros.every((f) => f(l))), error: null }),
    };
    return q;
  };
  return { db: { from: () => builder() }, orsRecebidos };
}

async function buscar(q: string) {
  const res = await GET(new Request(`http://localhost/api/v1/agenda/vinculos?q=${encodeURIComponent(q)}`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { contacts: Array<{ id: string }> } };
  return body.data.contacts.map((c) => c.id);
}

const BASE: Linha[] = [
  // Como a ingestão do WhatsApp grava: só display_name e telefone.
  contato({ id: "c-whats", display_name: "André Teste Silva", phone_number: "+5527999990001" }),
  contato({ id: "c-manual", name: "Maria Souza", phone_number: "+5527991112222" }),
  contato({ id: "c-outra-org", organization_id: OUTRA_ORG, display_name: "André da Outra Clínica" }),
  // Tem `name` de propósito: assim até a busca antiga (só `name`) o alcançaria,
  // e o caso "Maria" abaixo só fica verde se a rota CORTA o mesclado.
  contato({ id: "c-mesclado", name: "Maria Souza (cadastro antigo)", is_merged_into: "c-manual" }),
  contato({ id: "c-anonimo", display_name: "André Anônimo", is_anonymized: true }),
];

let orsRecebidos: string[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({ ok: true, user: { id: USER }, org: { orgId: ORG } } as never);
  const fake = makeDb(BASE);
  orsRecebidos = fake.orsRecebidos;
  vi.mocked(createClient).mockResolvedValue(fake.db as never);
});

describe("GET /api/v1/agenda/vinculos", () => {
  it("acha contato que só tem o nome do WhatsApp (display_name)", async () => {
    expect(await buscar("André")).toEqual(["c-whats"]);
  });

  it("acha pelo telefone digitado sem o 55", async () => {
    expect(await buscar("27999990001")).toEqual(["c-whats"]);
  });

  it("continua achando quem tem name preenchido à mão — e não o cadastro mesclado", async () => {
    expect(await buscar("Maria")).toEqual(["c-manual"]);
  });

  it("não atravessa organização nem oferece anonimizado", async () => {
    const ids = await buscar("André");
    expect(ids).not.toContain("c-outra-org");
    expect(ids).not.toContain("c-anonimo");
  });

  it("devolve display_name e telefone para a tela nomear a pessoa", async () => {
    const res = await GET(new Request("http://localhost/api/v1/agenda/vinculos?q=Andr%C3%A9"));
    const body = (await res.json()) as { data: { contacts: Array<Record<string, unknown>> } };
    expect(body.data.contacts[0]).toMatchObject({
      id: "c-whats",
      display_name: "André Teste Silva",
      phone_number: "+5527999990001",
    });
  });

  it("termo vazio não manda filtro OR (não é busca)", async () => {
    await buscar("   ");
    expect(orsRecebidos).toEqual([]);
  });

  it("preserva a negativa de autorização", async () => {
    vi.mocked(requireRole).mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) } as never);
    const res = await GET(new Request("http://localhost/api/v1/agenda/vinculos?q=a"));
    expect(res.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });
});
