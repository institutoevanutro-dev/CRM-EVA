/**
 * POST /api/v1/contacts/merge — as duas regras do fork em volta de
 * `fn_mesclar_contatos` (porte do #3640):
 *
 *  - a ficha ligada ao prontuário nunca é a absorvida (409, sem chamar a RPC);
 *  - a junção nunca solta uma trava da IA: quem fica herda `ai_opt_out`
 *    (com `force_human`) ou `force_human`, depois da RPC e só apertando.
 *
 * A fusão em si (repontar, lápide, bloqueio herdado) é do banco e tem
 * invariante próprio; aqui o dublê do Supabase registra leituras, a RPC e o
 * update, e cada caso diz a sabotagem que o deixa vermelho.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const FICA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SAI = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Ficha {
  id: string;
  force_human: boolean;
  ai_opt_out: boolean;
}

const livre = (id: string): Ficha => ({ id, force_human: false, ai_opt_out: false });

const RESULTADO = {
  contato_id: FICA,
  contatos_mesclados: [SAI],
  repontado: { "messages.contact_id": 2 },
  nao_repontado: {},
  atividades_emitidas: 0,
  bloqueio_herdado: false,
};

interface Opcoes {
  fichas: Ficha[];
  /** `contact_id`s ligados ao prontuário. */
  vinculadas?: string[];
  erroDasTravas?: boolean;
  erroDosVinculos?: boolean;
  erroDaRpc?: string;
  erroDoUpdate?: boolean;
}

function fakeSupabase(o: Opcoes) {
  const leituras: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
  const updates: Array<{ tabela: string; valores: unknown; filtros: Array<[string, unknown]> }> = [];
  const rpc = vi.fn(async () =>
    o.erroDaRpc ? { data: null, error: { message: o.erroDaRpc } } : { data: RESULTADO, error: null },
  );
  const client = {
    rpc,
    from(tabela: string) {
      const filtros: Array<[string, unknown]> = [];
      let valores: unknown;
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.update = (v: unknown) => {
        valores = v;
        return b;
      };
      b.eq = (coluna: string, valor: unknown) => {
        filtros.push([coluna, valor]);
        return b;
      };
      b.in = (coluna: string, lista: unknown) => {
        filtros.push([coluna, lista]);
        return b;
      };
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        let r: unknown;
        if (valores !== undefined) {
          updates.push({ tabela, valores, filtros });
          r = { data: null, error: o.erroDoUpdate ? { message: "permission denied" } : null };
        } else {
          leituras.push({ tabela, filtros });
          const lista = (filtros.find(([c]) => c === "id" || c === "contact_id")?.[1] ?? []) as string[];
          if (tabela === "contacts") {
            r = o.erroDasTravas
              ? { data: null, error: { message: "timeout" } }
              : { data: o.fichas.filter((f) => lista.includes(f.id)), error: null };
          } else {
            r = o.erroDosVinculos
              ? { data: null, error: { message: "timeout" } }
              : {
                  data: (o.vinculadas ?? []).filter((id) => lista.includes(id)).map((id) => ({ contact_id: id })),
                  error: null,
                };
          }
        }
        return Promise.resolve(r).then(res, rej);
      };
      return b;
    },
  };
  vi.mocked(createClient).mockResolvedValue(client as never);
  return { rpc, leituras, updates };
}

async function juntar(extra: Record<string, unknown> = {}): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new NextRequest("http://localhost/api/v1/contacts/merge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ primary_contact_id: FICA, secondary_contact_ids: [SAI], ...extra }),
    }),
  );
}

const metadataDoAudit = () =>
  (vi.mocked(audit).mock.calls.find(([e]) => e.action === "contact.merged")?.[0].metadata ?? {}) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER } as never,
    org: { orgId: ORG, name: "Org", role: "manager" } as never,
  });
});

describe("POST /contacts/merge: a trava da IA passa para quem fica", () => {
  it("(1) absorvida com ai_opt_out e quem fica livre: UM update dos dois campos, pela org e pelo id de quem fica", async () => {
    // Sabotagem: tirar a herança deixa `updates` vazio e o audit sem ai_lock_inherited.
    const { updates, leituras } = fakeSupabase({
      fichas: [livre(FICA), { id: SAI, force_human: true, ai_opt_out: true }],
    });

    const res = await juntar();
    const json = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(updates).toEqual([
      {
        tabela: "contacts",
        valores: { ai_opt_out: true, force_human: true },
        filtros: [
          ["organization_id", ORG],
          ["id", FICA],
        ],
      },
    ]);
    expect(metadataDoAudit()).toMatchObject({ ai_lock_inherited: "ai_opt_out" });
    expect(metadataDoAudit()).not.toHaveProperty("ai_lock_inherit_failed");
    expect(json.data).toMatchObject({ ia_herdada: "ai_opt_out" });
    expect(json.data).not.toHaveProperty("ia_nao_herdada");
    // Toda leitura de conferência sai pela organização da sessão.
    expect(leituras.every((l) => l.filtros.some(([c, v]) => c === "organization_id" && v === ORG))).toBe(true);
  });

  it("(2) absorvida só com force_human: o update leva só force_human", async () => {
    const { updates } = fakeSupabase({
      fichas: [livre(FICA), { id: SAI, force_human: true, ai_opt_out: false }],
    });

    const res = await juntar();

    expect(res.status).toBe(200);
    expect(updates.map((u) => u.valores)).toEqual([{ force_human: true }]);
    expect(metadataDoAudit()).toMatchObject({ ai_lock_inherited: "force_human" });
  });

  it("(3) quem fica já tem a trava: nenhum update", async () => {
    const { updates } = fakeSupabase({
      fichas: [
        { id: FICA, force_human: true, ai_opt_out: true },
        { id: SAI, force_human: true, ai_opt_out: true },
      ],
    });

    const res = await juntar();
    const json = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(updates).toEqual([]);
    expect(metadataDoAudit()).not.toHaveProperty("ai_lock_inherited");
    expect(json.data).not.toHaveProperty("ia_herdada");
  });

  it("(7) a RPC falha: nada é atualizado", async () => {
    const { updates } = fakeSupabase({
      fichas: [livre(FICA), { id: SAI, force_human: true, ai_opt_out: true }],
      erroDaRpc: "contato_secundario_indisponivel",
    });

    const res = await juntar();

    expect(res.status).toBe(404);
    expect(updates).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("(8) o update falha: a fusão já aconteceu → 200 com ia_nao_herdada, trilha e log", async () => {
    // Sabotagem: devolver 500 aqui esconderia uma fusão consumada; não logar
    // tiraria o único rastro operacional da trava que não passou.
    fakeSupabase({
      fichas: [livre(FICA), { id: SAI, force_human: true, ai_opt_out: false }],
      erroDoUpdate: true,
    });

    const res = await juntar();
    const json = (await res.json()) as { data: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ ia_nao_herdada: true });
    expect(json.data).not.toHaveProperty("ia_herdada");
    expect(metadataDoAudit()).toMatchObject({ ai_lock_inherit_failed: true });
    expect(metadataDoAudit()).not.toHaveProperty("ai_lock_inherited");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("POST /contacts/merge: a ficha ligada ao prontuário fica", () => {
  it("(4) a absorvida está ligada ao prontuário: 409 state_conflict e a RPC não é chamada", async () => {
    // Sabotagem: tirar a guarda deixa a RPC rodar e o vínculo do prontuário sumir com a lápide.
    const { rpc } = fakeSupabase({ fichas: [livre(FICA), livre(SAI)], vinculadas: [SAI] });

    const res = await juntar();
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("state_conflict");
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("(5) só quem fica está ligado e NÃO confirmou: 409 prontuario_confirmar_juncao, sem RPC", async () => {
    // Sabotagem: conferir o vínculo só das absorvidas (como antes) deixa a RPC
    // rodar e os exames da outra ficha caírem no prontuário do paciente.
    const { rpc, leituras } = fakeSupabase({ fichas: [livre(FICA), livre(SAI)], vinculadas: [FICA] });

    const res = await juntar();
    const json = (await res.json()) as { error: { code: string; message: string } };

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("prontuario_confirmar_juncao");
    expect(json.error.message).toContain("Junte só se forem a mesma pessoa.");
    expect(rpc).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    // A conferência pergunta pelas duas pontas, pela organização da sessão.
    const doProntuario = leituras.find((l) => l.tabela === "prontuario_contact_links")!;
    expect(doProntuario.filtros).toEqual([
      ["organization_id", ORG],
      ["contact_id", [FICA, SAI]],
    ]);
  });

  it("(5b) só quem fica está ligado e confirmou: a RPC roda e a auditoria registra a confirmação", async () => {
    // Sabotagem: tirar `prontuario_merge_confirmed` do audit apaga o rastro de quem confirmou.
    const { rpc } = fakeSupabase({ fichas: [livre(FICA), livre(SAI)], vinculadas: [FICA] });

    const res = await juntar({ confirmar_ficha_do_prontuario: true });

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(metadataDoAudit()).toMatchObject({ prontuario_merge_confirmed: true });
  });

  it("(5c) nenhuma ligada: junta sem pedir confirmação e sem marcar a auditoria", async () => {
    const { rpc } = fakeSupabase({ fichas: [livre(FICA), livre(SAI)] });

    const res = await juntar();

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(metadataDoAudit()).not.toHaveProperty("prontuario_merge_confirmed");
  });

  it("(5d) a absorvida ligada continua 409 state_conflict MESMO com a confirmação", async () => {
    const { rpc } = fakeSupabase({ fichas: [livre(FICA), livre(SAI)], vinculadas: [FICA, SAI] });

    const res = await juntar({ confirmar_ficha_do_prontuario: true });
    const json = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("state_conflict");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("(5e) a confirmação só aceita true", async () => {
    const { rpc } = fakeSupabase({ fichas: [livre(FICA), livre(SAI)], vinculadas: [FICA] });

    const res = await juntar({ confirmar_ficha_do_prontuario: "sim" });

    expect(res.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("(6) erro ao ler as travas ou o vínculo: 500 e nada é fundido", async () => {
    // Sabotagem: tratar o erro como "sem vínculo" deixaria absorver a ficha do prontuário.
    const semTravas = fakeSupabase({ fichas: [livre(FICA), livre(SAI)], erroDasTravas: true });
    expect((await juntar()).status).toBe(500);
    expect(semTravas.rpc).not.toHaveBeenCalled();

    const semVinculos = fakeSupabase({ fichas: [livre(FICA), livre(SAI)], erroDosVinculos: true });
    expect((await juntar()).status).toBe(500);
    expect(semVinculos.rpc).not.toHaveBeenCalled();
  });
});
