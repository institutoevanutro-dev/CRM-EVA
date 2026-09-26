/**
 * Task 8 — Filtro "Só Instagram" / "Só WhatsApp" no Inbox.
 *
 * O `Select` de número passa a codificar dois filtros no mesmo valor:
 * `channel_session_id` (um número específico) ou `canal` (todos os números de
 * um tipo). Os dois são mutuamente exclusivos — escolher um limpa o outro.
 */
import { describe, expect, it } from "vitest";

import { listConversationsHandler } from "@/app/api/v1/conversations/_handler";

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

function fakeSupabase() {
  const chamadas: Chamada[] = [];
  const client = {
    from: (tabela: string) => {
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (ok: (v: unknown) => unknown) => ok({ data: [], error: null });
            }
            return (...args: unknown[]) => {
              chamadas.push({ tabela, metodo: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
  };
  return { client: client as never, chamadas };
}

const ctx = {
  organization_id: "org-1",
  requestId: "req-1",
  actor: { type: "user" as const, id: "user-1" },
} as never;

async function listar(query: Record<string, unknown>) {
  const { client, chamadas } = fakeSupabase();
  await listConversationsHandler(client, ctx, { limit: 50, ...query } as never);
  return chamadas;
}

const emConversas = (c: Chamada[], metodo: string) =>
  c.filter((x) => x.tabela === "conversations" && x.metodo === metodo);

describe("o filtro de canal vira predicado de consulta", () => {
  it("⭐ com `canal: instagram`, a consulta filtra channel = instagram", async () => {
    const c = await listar({ canal: "instagram" });
    const eqs = emConversas(c, "eq").map((x) => x.args.join(":"));
    expect(eqs).toContain("channel:instagram");
  });

  it("com `canal: whatsapp`, a consulta filtra channel = whatsapp", async () => {
    const c = await listar({ canal: "whatsapp" });
    const eqs = emConversas(c, "eq").map((x) => x.args.join(":"));
    expect(eqs).toContain("channel:whatsapp");
  });

  it("CONTROLE: sem `canal`, nenhum predicado de channel é emitido", async () => {
    const c = await listar({});
    const eqs = emConversas(c, "eq").map((x) => x.args.join(":"));
    expect(eqs).not.toContain("channel:instagram");
    expect(eqs).not.toContain("channel:whatsapp");
  });
});
