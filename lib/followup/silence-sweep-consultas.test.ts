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

describe("loadActiveSilencePointers — lê a vigência", () => {
  it("pede active_since e a devolve no ponteiro", async () => {
    const consultas: Chamada[][] = [];
    const linha = {
      id: "p-1",
      organization_id: "org",
      active_version_id: "v-1",
      trigger_config: { kind: "silence", params: { threshold_minutes: 30 } },
      active_since: "2026-10-06T12:00:00+00:00",
    };
    const from = (tabela: string) => {
      const chamadas: Chamada[] = [{ metodo: "from", args: [tabela] }];
      consultas.push(chamadas);
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve({ data: [linha], error: null });
            return (...args: unknown[]) => {
              chamadas.push({ metodo: String(prop), args });
              return chain;
            };
          },
        },
      );
      return chain;
    };
    const pointers = await createSupabaseSilenceSweepDb({ from } as never).loadActiveSilencePointers();
    expect(consultas[0]!.find((c) => c.metodo === "select")?.args[0]).toMatch(/\bactive_since\b/);
    expect(pointers[0]!.active_since).toBe("2026-10-06T12:00:00+00:00");
  });
});

/** Registra cada consulta e responde com a próxima página roteirizada (vazia quando acabam). */
function supabaseRoteirizado(paginas: unknown[][]) {
  const consultas: Chamada[][] = [];
  const from = (tabela: string) => {
    const chamadas: Chamada[] = [{ metodo: "from", args: [tabela] }];
    const data = paginas[consultas.length] ?? [];
    consultas.push(chamadas);
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve({ data, error: null });
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

describe("loadUltimaInscricaoNoPonteiro — a consulta de produção", () => {
  const DESDE = "2026-10-06T11:00:00.000Z";

  it("pergunta por organização, ponteiro, contatos e started_at >= desde, em keyset por id", async () => {
    const { admin, consultas } = supabaseRoteirizado([[]]);
    await createSupabaseSilenceSweepDb(admin).loadUltimaInscricaoNoPonteiro("org", "p-1", ["c-1"], DESDE);
    const c = consultas[0]!;
    expect(c[0]).toEqual({ metodo: "from", args: ["followup_enrollments"] });
    expect(c).toContainEqual({ metodo: "eq", args: ["organization_id", "org"] });
    expect(c).toContainEqual({ metodo: "eq", args: ["pointer_id", "p-1"] });
    expect(c).toContainEqual({ metodo: "in", args: ["contact_id", ["c-1"]] });
    expect(c).toContainEqual({ metodo: "gte", args: ["started_at", DESDE] });
    expect(c).toContainEqual({ metodo: "order", args: ["id", { ascending: true }] });
    expect(c).toContainEqual({ metodo: "limit", args: [500] });
    // não filtra status: inscrição de QUALQUER status conta como do episódio
    expect(c.some((x) => x.args[0] === "status")).toBe(false);
  });

  it("reduz várias linhas do mesmo contato ao MAIOR started_at, e pagina até a página vazia", async () => {
    const { admin, consultas } = supabaseRoteirizado([
      [
        { id: "e-1", contact_id: "c-1", started_at: "2026-10-06T12:00:00+00:00" },
        { id: "e-2", contact_id: "c-1", started_at: "2026-10-06T13:00:00+00:00" },
      ],
      [{ id: "e-3", contact_id: "c-1", started_at: "2026-10-06T12:30:00+00:00" }],
    ]);
    const m = await createSupabaseSilenceSweepDb(admin).loadUltimaInscricaoNoPonteiro("org", "p-1", ["c-1"], DESDE);
    expect(m.get("c-1")).toBe("2026-10-06T13:00:00+00:00");
    expect(consultas).toHaveLength(3); // duas páginas + a vazia
    expect(consultas[1]!).toContainEqual({ metodo: "gt", args: ["id", "e-2"] });
  });

  it("lotes de 100 contatos; lista vazia não bate no banco", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `c-${i}`);
    const { admin, consultas } = supabaseRoteirizado([]);
    await createSupabaseSilenceSweepDb(admin).loadUltimaInscricaoNoPonteiro("org", "p-1", ids, DESDE);
    const lotes = consultas.map(
      (c) => (c.find((x) => x.metodo === "in" && x.args[0] === "contact_id")?.args[1] as string[]).length,
    );
    expect(lotes).toEqual([100, 50]);

    const vazio = supabaseRoteirizado([]);
    await createSupabaseSilenceSweepDb(vazio.admin).loadUltimaInscricaoNoPonteiro("org", "p-1", [], DESDE);
    expect(vazio.consultas).toHaveLength(0);
  });

  it("página que não avança lança", async () => {
    const pagina = [{ id: "e-1", contact_id: "c-1", started_at: "2026-10-06T12:00:00+00:00" }];
    const { admin } = supabaseRoteirizado([pagina, pagina]);
    await expect(
      createSupabaseSilenceSweepDb(admin).loadUltimaInscricaoNoPonteiro("org", "p-1", ["c-1"], DESDE),
    ).rejects.toThrow("silence_episode_page_did_not_advance");
  });
});
