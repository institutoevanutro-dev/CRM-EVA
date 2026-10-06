import { describe, expect, it } from "vitest";

import { createSupabaseSilenceSweepDb } from "./silence-sweep";

/**
 * As CONSULTAS DE PRODUÇÃO da varredura de silêncio (não o espelho em SQL do
 * invariante, que o `test:db` usa porque não sobe PostgREST — ver
 * `tests/unit/sweep-nao-cobra-conversa-encerrada.test.ts`, cabeçalho). O que
 * mora no filtro do adaptador só é vigiado aqui.
 *
 * O dublê de `conversations` honra a parte da consulta que decide QUAIS linhas
 * voltam — `order("id")`, `gt("id", x)` e `limit(n)` no nível da tabela — e,
 * sem `limit`, corta em 1000 como o `max_rows` do PostgREST. O resto da cadeia
 * só é registrado.
 */

type Chamada = { metodo: string; args: unknown[] };

function supabaseDeConversas(linhas: Array<{ id: string } & Record<string, unknown>>, opts?: { maxRows?: number }) {
  const consultas: Chamada[][] = [];
  const maxRows = opts?.maxRows ?? 1000;
  const from = (tabela: string) => {
    const chamadas: Chamada[] = [{ metodo: "from", args: [tabela] }];
    consultas.push(chamadas);
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) => {
              const gt = chamadas.find((c) => c.metodo === "gt" && c.args[0] === "id")?.args[1] as string | undefined;
              const limite = chamadas.find((c) => c.metodo === "limit" && c.args[1] === undefined)?.args[0] as
                | number
                | undefined;
              const ordenado = chamadas.some((c) => c.metodo === "order" && c.args[0] === "id");
              let data = linhas.filter((l) => gt === undefined || l.id > gt);
              if (ordenado) data = [...data].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
              data = data.slice(0, Math.min(limite ?? Infinity, maxRows));
              return resolve({ data, error: null });
            };
          }
          return (...args: unknown[]) => {
            chamadas.push({ metodo: String(prop), args });
            return chain;
          };
        },
      },
    );
    return chain;
  };
  return { admin: { from } as never, consultas };
}

function conversa(contactId: string, opts?: { anonimizado?: boolean; id?: string }) {
  const id = opts?.id ?? `conversation-${contactId}`;
  return {
    id,
    service_revision: 1,
    current_demanda_id: null,
    demandas: null,
    status: "open",
    contact_id: contactId,
    last_inbound_at: "2026-09-01T10:00:00.000Z",
    messages: [
      {
        organization_id: "org",
        contact_id: contactId,
        conversation_id: id,
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
        sent_at: "2026-09-01T10:00:00.000Z",
        created_at: "2026-09-01T10:00:01.000Z",
      },
    ],
    contacts: {
      tags: [],
      is_blocked: false,
      is_anonymized: opts?.anonimizado ?? false,
      ai_authorized_at: null,
      phone_number: "+5585999990000",
    },
    sessao: { metadata: { ai_gate: "open" } },
  };
}

const CORTE = "2026-09-02T10:00:00.000Z";

describe("loadSilentContacts — anonimizado fica fora", () => {
  it("contato anonimizado calado não volta; o vivo volta", async () => {
    const { admin } = supabaseDeConversas([conversa("anon", { anonimizado: true }), conversa("vivo")]);
    const contatos = await createSupabaseSilenceSweepDb(admin).loadSilentContacts("org", CORTE, []);
    expect(contatos.map((c) => c.contact_id)).toEqual(["vivo"]);
  });

  it("a consulta pede is_anonymized no embed de contacts", async () => {
    const { admin, consultas } = supabaseDeConversas([]);
    await createSupabaseSilenceSweepDb(admin).loadSilentContacts("org", CORTE, []);
    const select = consultas[0]!.find((c) => c.metodo === "select")?.args[0] as string;
    expect(select).toMatch(/contacts:contact_id\([^)]*is_anonymized/);
  });
});

const muitas = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const k = String(i).padStart(5, "0");
    return conversa(`c-${k}`, { id: `conv-${k}` });
  });

describe("loadSilentContacts — paginação determinística das conversas", () => {
  it("1200 conversas caladas de 1200 contatos: voltam as 1200 (não o recorte de 1000 do max_rows)", async () => {
    const { admin } = supabaseDeConversas(muitas(1200));
    const contatos = await createSupabaseSilenceSweepDb(admin).loadSilentContacts("org", CORTE, []);
    expect(new Set(contatos.map((c) => c.contact_id)).size).toBe(1200);
  });

  it("pede order(id asc) e limit(500) no nível das conversas, e keyset por gt(id)", async () => {
    const { admin, consultas } = supabaseDeConversas(muitas(600));
    await createSupabaseSilenceSweepDb(admin).loadSilentContacts("org", CORTE, []);
    const primeira = consultas[0]!;
    expect(primeira).toContainEqual({ metodo: "order", args: ["id", { ascending: true }] });
    expect(primeira).toContainEqual({ metodo: "limit", args: [500] });
    expect(consultas[1]!).toContainEqual({ metodo: "gt", args: ["id", "conv-00499"] });
  });

  it("para na página VAZIA, não na curta: com max_rows abaixo de 500 a leitura continua completa", async () => {
    // O dono da instalação pode baixar o max_rows do PostgREST no painel do
    // Supabase. Uma página curta, então, não prova que a leitura acabou
    // (mesma lição de lib/agenda/protecao-followup.ts).
    const { admin, consultas } = supabaseDeConversas(muitas(450), { maxRows: 200 });
    const contatos = await createSupabaseSilenceSweepDb(admin).loadSilentContacts("org", CORTE, []);
    expect(contatos).toHaveLength(450);
    expect(consultas).toHaveLength(4); // 200 + 200 + 50 + vazia
  });

  it("página que não avança lança, em vez de laço infinito", async () => {
    const pagina = muitas(500);
    const admin = {
      from: () => {
        const chain: Record<string, unknown> = new Proxy(
          {},
          {
            get(_t, prop) {
              if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve({ data: pagina, error: null });
              return () => chain;
            },
          },
        );
        return chain;
      },
    } as never;
    await expect(createSupabaseSilenceSweepDb(admin).loadSilentContacts("org", CORTE, [])).rejects.toThrow(
      "silence_page_did_not_advance",
    );
  });
});
