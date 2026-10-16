/**
 * O INBOX NÃO MOSTRA NEM CONTA O CONTATO OCULTO (migration 0372).
 *
 * O predicado é um só (`lib/inbox/contato-oculto.ts`) e mora nas consultas do
 * servidor, não na tela: a lista, as contagens das abas (com os não lidos e a
 * Fila) e a posição na fila pedem `contato_oculto = false`; a aba "Ocultos"
 * pede o inverso, e só para gerente e administrador.
 *
 * O banco falso APLICA os filtros sobre as linhas (`eq`, `in`, `not in`, `gt`,
 * `is`) — um dublê que os ignorasse deixaria o teste verde sem o predicado.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fail } from "@/lib/api/wrappers";

const estado = vi.hoisted(() => ({
  role: "manager" as "agent" | "manager",
  linhas: [] as Array<Record<string, unknown>>,
}));

function bancoFalso() {
  const from = (tabela: string) => {
    let resultado: Array<Record<string, unknown>> =
      tabela === "conversations" ? estado.linhas.map((l) => ({ ...l })) : [];
    let cabeca = false;
    const cadeia: Record<string, unknown> = new Proxy(
      {},
      {
        get(_alvo, prop) {
          if (prop === "then") {
            return (ok: (v: unknown) => unknown) =>
              ok(cabeca ? { count: resultado.length, error: null } : { data: resultado, error: null });
          }
          return (...args: unknown[]) => {
            const [coluna, valor] = args as [string, unknown];
            if (prop === "select") cabeca = (args[1] as { head?: boolean } | undefined)?.head === true;
            else if (prop === "eq") resultado = resultado.filter((r) => r[coluna] === valor);
            else if (prop === "in") resultado = resultado.filter((r) => (valor as unknown[]).includes(r[coluna]));
            else if (prop === "is") resultado = resultado.filter((r) => (r[coluna] ?? null) === valor);
            else if (prop === "gt") resultado = resultado.filter((r) => Number(r[coluna] ?? 0) > Number(valor));
            else if (prop === "not") {
              const lista = String(args[2]).replace(/^\(|\)$/g, "").split(",");
              resultado = resultado.filter((r) => !lista.includes(String(r[coluna])));
            }
            return cadeia;
          };
        },
      },
    );
    return cadeia;
  };
  return {
    from,
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => bancoFalso() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "user-1", idioma: "pt-BR" }),
  resolveActiveOrg: async () => ({ orgId: "org-1", role: estado.role }),
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async (min: string) =>
    min === "manager" && estado.role !== "manager"
      ? { ok: false, response: fail("forbidden_role", "papel", 403) }
      : { ok: true, user: { id: "user-1" }, org: { orgId: "org-1", role: estado.role } },
  ),
}));
vi.mock("@/lib/users/com-nome-do-atendente", () => ({ comNomeDoAtendente: async (c: unknown) => c }));

const { GET: contar } = await import("@/app/api/v1/conversations/counts/route");
const { GET: listar } = await import("@/app/api/v1/conversations/route");
const { getQueuePosition } = await import("@/lib/routing/queue");
const { tabToFilter } = await import("@/components/inbox/InboxLayout");
const { visibleInboxTabs } = await import("@/components/inbox/InboxFilters");

const conversa = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  organization_id: "org-1",
  contact_id: `contato-${id}`,
  status: "open",
  comando_da_conversa: "aguardando",
  assigned_to_user_id: null,
  unread_count_for_assignee: 1,
  awaiting_since: "2026-10-16T09:00:00.000Z",
  last_message_at: "2026-10-16T09:00:00.000Z",
  contato_oculto: false,
  ...extra,
});

beforeEach(() => {
  estado.role = "manager";
  estado.linhas = [
    conversa("paciente"),
    conversa("amigo", { contato_oculto: true }),
    conversa("outra-org", { organization_id: "org-2" }),
  ];
});

const pedir = (rota: (r: NextRequest) => Promise<Response>, qs = "") =>
  rota(new NextRequest(`http://localhost/api/v1/conversations${qs}`));

describe("contagens das abas", () => {
  it("nenhuma aba conta a conversa do contato oculto; não lidas também não", async () => {
    for (const qs of ["/counts", "/counts?unread=true"]) {
      const { data } = await (await pedir(contar, qs)).json();
      expect({ fila: data.fila, all: data.all }, qs).toEqual({ fila: 1, all: 1 });
    }
  });

  it("o gerente vê o número da aba Ocultos; o atendente nem recebe o campo", async () => {
    expect((await (await pedir(contar, "/counts")).json()).data.ocultos).toBe(1);
    estado.role = "agent";
    expect((await (await pedir(contar, "/counts")).json()).data).not.toHaveProperty("ocultos");
  });
});

describe("lista do Inbox", () => {
  it("sem a aba Ocultos, a lista nunca traz a conversa do contato oculto", async () => {
    const corpo = await (await pedir(listar)).json();
    expect(corpo.data.map((c: { id: string }) => c.id)).toEqual(["paciente"]);
  });

  it("a aba Ocultos traz só elas, e só para gerente", async () => {
    const corpo = await (await pedir(listar, "?ocultos=true")).json();
    expect(corpo.data.map((c: { id: string }) => c.id)).toEqual(["amigo"]);
    estado.role = "agent";
    expect((await pedir(listar, "?ocultos=true")).status).toBe(403);
  });

  it("a ficha do contato lista os canais dele mesmo oculto", async () => {
    const corpo = await (await pedir(listar, "?contact_id=11111111-1111-4111-8111-111111111111")).json();
    expect(corpo.data).toEqual([]);
    estado.linhas.push(conversa("da-ficha", { contact_id: "11111111-1111-4111-8111-111111111111", contato_oculto: true }));
    const comOculto = await (await pedir(listar, "?contact_id=11111111-1111-4111-8111-111111111111")).json();
    expect(comOculto.data.map((c: { id: string }) => c.id)).toEqual(["da-ficha"]);
  });
});

describe("Fila e abas na tela", () => {
  it("a posição na fila que o cliente ouve não conta o contato oculto", async () => {
    const posicao = await getQueuePosition(bancoFalso() as never, "org-1", "2026-10-16T10:00:00.000Z", new Date());
    expect(posicao).toBe(1);
  });

  it("a aba Ocultos pede `ocultos`, e só aparece para gerente e administrador", () => {
    expect(tabToFilter("ocultos")).toEqual({ ocultos: true });
    expect(visibleInboxTabs("manager", "all")).toContain("ocultos");
    expect(visibleInboxTabs("admin", "all")).toContain("ocultos");
    expect(visibleInboxTabs("agent", "all")).not.toContain("ocultos");
    expect(visibleInboxTabs("viewer", "all")).not.toContain("ocultos");
  });
});
