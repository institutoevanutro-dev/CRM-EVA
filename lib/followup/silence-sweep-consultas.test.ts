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
