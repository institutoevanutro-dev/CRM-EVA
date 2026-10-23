/**
 * #3084 — CPF ou e-mail repetido deixou de ser 500.
 *
 * O telefone já virava 409 `contact_exists` (fatia S1 da #852). O CPF e o
 * e-mail têm a MESMA trava única na tabela (`uniq_contacts_org_cpf` sobre
 * `(organization_id, cpf_hash)`, `uniq_contacts_org_email` sobre
 * `(organization_id, email_normalized)`), mas o 23505 dos dois caía no
 * `internal_error` e a tela mostrava "erro interno" para um simples duplicado.
 *
 * O conserto distingue os índices pelo NOME que o driver do Postgres escreve no
 * 23505 e devolve o `contact_id` de quem já tem o dado — sempre relido com o
 * filtro por `organization_id` (o id nunca vem do corpo da requisição). O
 * telefone continua decidindo pela RELEITURA, sem olhar o texto do erro, como
 * já era.
 *
 * O cliente falso abaixo simula os três índices únicos da tabela: mesmo dado
 * (CPF pelo hash, e-mail por `lower(trim(...))`, telefone pela forma canônica)
 * na MESMA organização estoura; em outra organização, passa.
 *
 * Porte do original (DeskcommCRM, PR #3197). Neste CRM o `cpf_hash` é o índice
 * HMAC da RPC `cpf_indice` e `authenticated` não lê a coluna (0289): a releitura
 * do CPF vai pelo client de SERVIÇO, que aqui é dublado sobre a MESMA tabela
 * falsa do client de sessão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { requireRole } from "@/lib/auth/require-role";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { createClient } from "@/lib/supabase/server";

const auditSpy = vi.fn(async () => undefined);

vi.mock("@/lib/audit", () => ({
  audit: auditSpy,
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

// Só as fronteiras da rota do PATCH são dubladas (sessão, cookie, guarda de
// acompanhamento). O handler e o `fail()` que monta o corpo são os de verdade.
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));

const ORG = "d0849a00-0000-4000-8000-000000000001";
const OUTRA_ORG = "d0849a00-0000-4000-8000-000000000002";
const EXISTENTE = "d0849a00-0000-4000-8000-0000000000c1";
const NOVO = "d0849a00-0000-4000-8000-0000000000c2";
const USUARIO = "d0849a00-0000-4000-8000-0000000000a1";

const CPF = "529.982.247-25";
/** O que o `cpf_indice` falso devolve para os 11 dígitos (o HMAC de verdade mora no banco). */
const indiceFalso = (digitos: string) => `hmac-${digitos}`;
const CPF_HASH = indiceFalso("52998224725");
const EMAIL = "ana@example.com";

const INDICE_CPF = "uniq_contacts_org_cpf";
const INDICE_EMAIL = "uniq_contacts_org_email";

interface LinhaContato {
  id: string;
  organization_id: string;
  phone_number?: string | null;
  cpf_hash?: string | null;
  email?: string | null;
  is_merged_into?: string | null;
}

interface OpcoesFake {
  /** O que já está gravado na tabela antes da chamada. */
  contatos?: LinhaContato[];
  /** Erro cru do INSERT, no lugar do simulador dos índices. */
  falhaDoInsert?: { code: string; message: string } | null;
  /** Erro cru do UPDATE do PATCH, no lugar do simulador dos índices. */
  falhaDoUpdate?: { code: string; message: string } | null;
}

type Filtro = [string, unknown];

interface Cadeia {
  select: (colunas?: string, opcoes?: unknown) => Cadeia;
  insert: (linha: Record<string, unknown>) => Cadeia;
  update: (linha: Record<string, unknown>) => Cadeia;
  eq: (coluna: string, valor: unknown) => Cadeia;
  in: (coluna: string, valores: unknown) => Cadeia;
  is: (coluna: string, valor: unknown) => Cadeia;
  order: (coluna: string, opcoes?: unknown) => Cadeia;
  limit: (n: number) => Cadeia;
  single: () => Promise<{ data: unknown; error: unknown }>;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  then: (resolve: (v: unknown) => unknown) => unknown;
}

const buscas: Array<{ filtros: Filtro[] }> = [];
const inserts: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];

/** Cadeia de qualquer tabela que não seja `contacts`: responde vazio. */
function cadeiaQualquer(tabela: string): Cadeia {
  const cadeia: Cadeia = {
    select: () => cadeia,
    insert: () => cadeia,
    update: () => cadeia,
    eq: () => cadeia,
    in: () => cadeia,
    is: () => cadeia,
    order: () => cadeia,
    limit: () => cadeia,
    single: async () => ({ data: null, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve) => resolve({ data: [], error: null, tabela }),
  };
  return cadeia;
}

/** Normalização do e-mail igual à coluna GENERATED (`lower(trim(email))`). */
function emailNormalizado(email: string | null | undefined): string | null {
  return typeof email === "string" ? email.trim().toLowerCase() : null;
}

function linhaCasaCom(linha: LinhaContato, filtros: Filtro[], variantes: string[] | null): boolean {
  for (const [coluna, valor] of filtros) {
    if (coluna === "organization_id" && linha.organization_id !== valor) return false;
    if (coluna === "id" && linha.id !== valor) return false;
    if (coluna === "cpf_hash" && linha.cpf_hash !== valor) return false;
    if (coluna === "email_normalized" && emailNormalizado(linha.email) !== valor) return false;
    if (coluna === "is_merged_into" && valor === null && linha.is_merged_into) return false;
  }
  if (variantes !== null && !variantes.includes(linha.phone_number ?? "")) return false;
  return true;
}

/**
 * `daSessao`: o client de SESSÃO não lê `cpf_hash` (grant por coluna, 0289), e
 * filtrar por ela morre em 42501. O dublê repete a recusa, para que a releitura
 * do CPF só funcione pelo client de serviço, como no banco de verdade.
 */
function cadeiaDeContatos(opts: OpcoesFake = {}, daSessao = false): Cadeia {
  const gravados: LinhaContato[] = [...(opts.contatos ?? [])];
  const filtros: Filtro[] = [];
  let variantes: string[] | null = null;
  let limite: number | null = null;
  let operacao: "select" | "insert" | "update" = "select";
  let linhaDoInsert: Record<string, unknown> | null = null;
  let linhaDoUpdate: Record<string, unknown> | null = null;

  /** Simula os índices únicos parciais da tabela. */
  const erroDeIndex = (linha: Record<string, unknown>, doUpdate: boolean): { code: string; message: string } | null => {
    const forcar = doUpdate ? opts.falhaDoUpdate : opts.falhaDoInsert;
    if (forcar) return forcar;
    // A organização do UPDATE vem do filtro `.eq("organization_id", …)` do
    // próprio UPDATE (o patch não carrega a coluna); no INSERT vem da linha.
    const orgDoFiltro = filtros.find(([coluna]) => coluna === "organization_id")?.[1];
    const orgAlvo = (orgDoFiltro ?? linha.organization_id) as string | undefined;
    const naOrg = gravados.filter(
      (c) => c.organization_id === orgAlvo && !c.is_merged_into,
    );
    const cpf = typeof linha.cpf_hash === "string" ? linha.cpf_hash : null;
    if (cpf && naOrg.some((c) => c.cpf_hash === cpf)) {
      return { code: "23505", message: `duplicate key value violates unique constraint "${INDICE_CPF}"` };
    }
    const email = emailNormalizado(typeof linha.email === "string" ? linha.email : null);
    if (email && naOrg.some((c) => emailNormalizado(c.email) === email)) {
      return { code: "23505", message: `duplicate key value violates unique constraint "${INDICE_EMAIL}"` };
    }
    const telefone = typeof linha.phone_number === "string" ? linha.phone_number : null;
    if (telefone && naOrg.some((c) => (c.phone_number ?? "") === telefone)) {
      return {
        code: "23505",
        message: 'duplicate key value violates unique constraint "uniq_contacts_org_phone"',
      };
    }
    return null;
  };

  const filtradas = (): LinhaContato[] =>
    gravados.filter((c) => linhaCasaCom(c, filtros, variantes));

  const cadeia: Cadeia = {
    select: () => cadeia,
    insert: (linha) => {
      operacao = "insert";
      linhaDoInsert = linha;
      inserts.push(linha);
      return cadeia;
    },
    update: (linha) => {
      operacao = "update";
      linhaDoUpdate = linha;
      updates.push(linha);
      return cadeia;
    },
    eq: (coluna, valor) => {
      filtros.push([coluna, valor]);
      return cadeia;
    },
    in: (coluna, valores) => {
      filtros.push([coluna, valores]);
      variantes = Array.isArray(valores) ? (valores as string[]) : null;
      return cadeia;
    },
    is: (coluna, valor) => {
      filtros.push([coluna, valor]);
      return cadeia;
    },
    order: () => cadeia,
    limit: (n) => {
      limite = n;
      return cadeia;
    },
    maybeSingle: async () => {
      if (operacao === "update") {
        const error = erroDeIndex(linhaDoUpdate ?? {}, true);
        if (error) return { data: null, error };
        return { data: { ...(linhaDoUpdate ?? {}), id: EXISTENTE }, error: null };
      }
      // Pré-select do PATCH (e afins): devolve o contato filtrado, ou nulo.
      const encontrados = filtradas();
      return { data: encontrados[0] ?? null, error: null };
    },
    single: async () => {
      if (operacao !== "insert" || !linhaDoInsert) return { data: null, error: null };
      const error = erroDeIndex(linhaDoInsert, false);
      if (error) return { data: null, error };
      return {
        data: {
          ...linhaDoInsert,
          id: NOVO,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        error: null,
      };
    },
    then: (resolve) => {
      buscas.push({ filtros: [...filtros] });
      if (daSessao && filtros.some(([coluna]) => coluna === "cpf_hash")) {
        return resolve({
          data: null,
          error: { code: "42501", message: "permission denied for table contacts" },
        });
      }
      const achados = filtradas().map((c) => ({
        id: c.id,
        phone_number: c.phone_number ?? null,
        cpf_hash: c.cpf_hash ?? null,
        email: c.email ?? null,
      }));
      return resolve({ data: limite === null ? achados : achados.slice(0, limite), error: null });
    },
  };
  return cadeia;
}

/** As opções do caso em curso: o client de serviço lê a MESMA tabela falsa. */
let opcoesDoCaso: OpcoesFake = {};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) =>
      tabela === "contacts" ? cadeiaDeContatos(opcoesDoCaso) : cadeiaQualquer(tabela),
    // `parDoCpf` pede a cifra e o índice ao banco; os dois voltam como TEXTO.
    rpc: async (nome: string, args: Record<string, unknown>) => {
      if (nome === "encrypt_cpf") return { data: "\\x010203", error: null };
      if (nome === "cpf_indice") return { data: indiceFalso(String(args.p_plaintext)), error: null };
      return { data: null, error: null };
    },
  }),
}));

function clienteFalso(opts: OpcoesFake = {}): unknown {
  opcoesDoCaso = opts;
  return {
    from: (tabela: string) =>
      tabela === "contacts" ? cadeiaDeContatos(opts, true) : cadeiaQualquer(tabela),
    // A cifra e o índice do CPF saem pelo client de SERVIÇO (dublado acima); a
    // sessão só manda o `emit_event`, que precisa não falhar.
    rpc: () => ({
      then: (r: (v: unknown) => unknown) => r({ data: null, error: null }),
    }),
  };
}

function ctxFalso(organizationId = ORG): HandlerCtx {
  return {
    organization_id: organizationId,
    actor: { type: "user", id: USUARIO },
    requestId: "req-3084",
  };
}

async function erroDe(promessa: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promessa;
  } catch (e) {
    return e as unknown as Record<string, unknown>;
  }
  throw new Error("esperava que o handler falhasse, e ele resolveu");
}

async function criar(cliente: unknown, entrada: Record<string, unknown>): Promise<unknown> {
  const { createContactHandler } = await import("@/app/api/v1/contacts/_handler");
  return createContactHandler(cliente as never, ctxFalso(), entrada as never);
}

async function editar(cliente: unknown, entrada: Record<string, unknown>): Promise<unknown> {
  const { patchContactHandler } = await import("@/app/api/v1/contacts/_handler");
  return patchContactHandler(cliente as never, ctxFalso(), EXISTENTE, entrada as never);
}

beforeEach(() => {
  auditSpy.mockClear();
  buscas.length = 0;
  inserts.length = 0;
  updates.length = 0;
});

describe("#3084 — POST com CPF repetido vira 409 contact_exists", () => {
  it("CPF que já é de um contato vivo da organização: 409 com details.contact_id", async () => {
    const erro = await erroDe(
      criar(
        clienteFalso({ contatos: [{ id: EXISTENTE, organization_id: ORG, cpf_hash: CPF_HASH }] }),
        { name: "Ana", cpf: CPF },
      ),
    );

    expect(erro).toMatchObject({
      status: 409,
      code: "contact_exists",
      details: { contact_id: EXISTENTE },
      message: "Já existe um contato com este CPF.",
    });

    // O insert levou o índice do CPF; a releitura (pelo client de serviço)
    // repetiu o filtro por organização e por `is_merged_into` (o id NUNCA vem
    // do corpo da requisição).
    expect(inserts[0]?.cpf_hash).toBe(CPF_HASH);
    const releitura = buscas.at(-1)!;
    expect(releitura.filtros).toEqual([
      ["organization_id", ORG],
      ["cpf_hash", CPF_HASH],
      ["is_merged_into", null],
    ]);
  });

  it("CONTROLE — o mesmo CPF em OUTRA organização não vira 409 daqui", async () => {
    // O índice não dispara em outra organização; forçamos o 23505 de CPF para
    // provar que é o FILTRO da releitura que impede o 409 indevido.
    const erro = await erroDe(
      criar(
        clienteFalso({
          contatos: [{ id: EXISTENTE, organization_id: OUTRA_ORG, cpf_hash: CPF_HASH }],
          falhaDoInsert: {
            code: "23505",
            message: `duplicate key value violates unique constraint "${INDICE_CPF}"`,
          },
        }),
        { name: "Ana", cpf: CPF },
      ),
    );

    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
    expect(erro.details).toBeUndefined();
    expect(buscas.at(-1)!.filtros).toContainEqual(["organization_id", ORG]);
  });

  it("CONTROLE — 23505 de outra origem continua 500", async () => {
    const erro = await erroDe(
      criar(
        clienteFalso({
          contatos: [{ id: EXISTENTE, organization_id: ORG, cpf_hash: CPF_HASH }],
          falhaDoInsert: {
            code: "23505",
            message: 'duplicate key value violates unique constraint "contacts_pkey"',
          },
        }),
        { name: "Ana", cpf: CPF },
      ),
    );

    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
  });

  it("CPF livre: cria normalmente", async () => {
    const out = (await criar(clienteFalso({ contatos: [] }), { name: "Ana", cpf: CPF })) as {
      action: string;
      contact: { id: string };
    };
    expect(out.action).toBe("created");
    expect(out.contact.id).toBe(NOVO);
  });
});

describe("#3084 — PATCH com e-mail repetido vira 409 contact_exists", () => {
  const linhaExistente: LinhaContato = {
    id: EXISTENTE,
    organization_id: ORG,
    email: "antigo@example.com",
  };

  it("e-mail que já é de outro contato: 409 com details.contact_id", async () => {
    const erro = await erroDe(
      editar(
        clienteFalso({
          contatos: [
            linhaExistente,
            { id: NOVO, organization_id: ORG, email: EMAIL },
          ],
        }),
        { email: EMAIL },
      ),
    );

    expect(erro).toMatchObject({
      status: 409,
      code: "contact_exists",
      details: { contact_id: NOVO },
      message: "Já existe um contato com este e-mail.",
    });

    // O PATCH grava por `email`; a releitura usa a coluna GENERATED
    // `email_normalized`, que é a que o índice vigia.
    expect(updates[0]?.email).toBe(EMAIL);
    expect(updates[0]?.email_normalized).toBeUndefined();
    expect(buscas.at(-1)!.filtros).toEqual([
      ["organization_id", ORG],
      ["email_normalized", EMAIL],
      ["is_merged_into", null],
    ]);
  });

  it("CONTROLE — o mesmo e-mail em OUTRA organização não vira 409 daqui", async () => {
    const erro = await erroDe(
      editar(
        clienteFalso({
          contatos: [
            linhaExistente,
            { id: NOVO, organization_id: OUTRA_ORG, email: EMAIL },
          ],
          falhaDoUpdate: {
            code: "23505",
            message: `duplicate key value violates unique constraint "${INDICE_EMAIL}"`,
          },
        }),
        { email: EMAIL },
      ),
    );

    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
    expect(buscas.at(-1)!.filtros).toContainEqual(["organization_id", ORG]);
  });

  it("CONTROLE — 23505 de outra origem no UPDATE continua 500", async () => {
    const erro = await erroDe(
      editar(
        clienteFalso({
          contatos: [linhaExistente, { id: NOVO, organization_id: ORG, email: EMAIL }],
          falhaDoUpdate: {
            code: "23505",
            message: 'duplicate key value violates unique constraint "contacts_pkey"',
          },
        }),
        { email: EMAIL },
      ),
    );

    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
  });

  it("e-mail livre: atualiza normalmente", async () => {
    const out = (await editar(clienteFalso({ contatos: [linhaExistente] }), {
      email: "novo@example.com",
    })) as { id: string };
    expect(out.id).toBe(EXISTENTE);
    expect(updates[0]?.email).toBe("novo@example.com");
  });
});

describe("#3084 — o telefone segue pelo caminho de sempre", () => {
  // O arquivo `contato-duplicado-409.test.ts` já trava o caso do telefone (a
  // fatia S1 da #852). Aqui só se prova que o conserto do CPF/e-mail não
  // desviou esse caminho: ele continua decidindo pela RELEITURA, não pelo nome
  // do índice — um 23505 que nem é de telefone ainda vira 409 porque o estado
  // (contato vivo com o mesmo número) implica a trava.
  it("23505 sem nome de telefone, mas com contato vivo de mesmo número: 409", async () => {
    const telefone = "+5532984793302";
    const erro = await erroDe(
      criar(
        clienteFalso({
          contatos: [
            { id: EXISTENTE, organization_id: ORG, phone_number: canonicalPhoneBR(telefone) },
          ],
          falhaDoInsert: {
            code: "23505",
            message: 'duplicate key value violates unique constraint "contacts_pkey"',
          },
        }),
        { name: "Ana", phone_number: telefone },
      ),
    );

    expect(erro).toMatchObject({
      status: 409,
      code: "contact_exists",
      details: { contact_id: EXISTENTE },
    });
  });
});

describe("#3084 — PATCH pela tela reenvia o telefone do próprio contato", () => {
  // O EditContactDialog manda o telefone junto com o e-mail. Se a releitura por
  // telefone viesse primeiro, ela acharia o PRÓPRIO contato e o 409 diria
  // "telefone" apontando para quem está sendo editado.
  it("e-mail de outro + telefone próprio: 409 de e-mail com o id do OUTRO", async () => {
    const telefone = canonicalPhoneBR("+5532984793302");
    const erro = await erroDe(
      editar(
        clienteFalso({
          contatos: [
            { id: EXISTENTE, organization_id: ORG, email: "antigo@example.com", phone_number: telefone },
            { id: NOVO, organization_id: ORG, email: EMAIL },
          ],
        }),
        { email: EMAIL, phone_number: "+5532984793302" },
      ),
    );
    expect(erro).toMatchObject({
      status: 409,
      code: "contact_exists",
      details: { contact_id: NOVO },
      message: "Já existe um contato com este e-mail.",
    });
  });

  it("telefone próprio + 23505 de índice desconhecido: 500, não 409 apontando para si", async () => {
    const telefone = canonicalPhoneBR("+5532984793302");
    const erro = await erroDe(
      editar(
        clienteFalso({
          contatos: [{ id: EXISTENTE, organization_id: ORG, phone_number: telefone }],
          falhaDoUpdate: {
            code: "23505",
            message: 'duplicate key value violates unique constraint "uq_contacts_grupo"',
          },
        }),
        { phone_number: "+5532984793302" },
      ),
    );
    expect(erro).toMatchObject({ status: 500, code: "internal_error" });
  });
});

/**
 * Os casos acima chamam o handler direto e não enxergam a metade do conserto que
 * mora na ROTA: neste CRM o `catch` do PATCH não repassava `err.details` ao
 * `fail()`, e o `contact_id` do 409 sumia no caminho. Este caso atravessa o
 * PATCH de verdade e lê o corpo que a tela lê.
 */
describe("PATCH /api/v1/contacts/[id] — o 409 chega inteiro ao corpo da resposta", () => {
  beforeEach(() => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: {
        id: USUARIO,
        email: "agente@example.com",
        full_name: null,
        avatar_url: null,
        is_platform_admin: false,
        idioma: "pt-BR" as const,
        organizations: [{ organization_id: ORG, organization_name: "Org", role: "agent" }],
      },
      org: { orgId: ORG, name: "Org", role: "agent" },
    } as never);
  });

  it("e-mail de outro contato: status 409, contact_exists e details.contact_id", async () => {
    vi.mocked(createClient).mockResolvedValue(
      clienteFalso({
        contatos: [
          { id: EXISTENTE, organization_id: ORG, email: "antigo@example.com" },
          { id: NOVO, organization_id: ORG, email: EMAIL },
        ],
      }) as never,
    );
    const { PATCH } = await import("@/app/api/v1/contacts/[id]/route");

    const res = await PATCH(
      new NextRequest(`http://localhost/api/v1/contacts/${EXISTENTE}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: EMAIL }),
      }),
      { params: Promise.resolve({ id: EXISTENTE }) },
    );

    expect(res.status).toBe(409);
    const corpo = (await res.json()) as {
      error: { code: string; message: string; details?: Record<string, unknown> };
    };
    expect(corpo.error.code).toBe("contact_exists");
    expect(corpo.error.details).toEqual({ contact_id: NOVO });
    // É esta frase que o toast mostra: `contact_exists` não tem entrada própria
    // em `components/feedback/ApiErrorToast.tsx`, então passa o texto da rota.
    expect(corpo.error.message).toBe("Já existe um contato com este e-mail.");
  });
});
