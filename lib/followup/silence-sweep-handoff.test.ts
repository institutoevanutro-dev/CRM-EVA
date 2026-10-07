/**
 * O gatilho de silêncio não reinscreve, no mesmo silêncio, quem teve a
 * inscrição deste ponteiro encerrada por atendimento humano. Sem isto, a trava
 * de humano ativo (`bloqueios-obrigatorios.ts`) viraria um laço por tick:
 * inscreve → planeja → encerra no 1º envio → inscreve de novo.
 */
import { describe, expect, it } from "vitest";

import { createSupabaseSilenceSweepDb, encerradaPorHumanoNesteSilencio } from "./silence-sweep";

const ULTIMA_ENTRADA = "2026-09-01T10:00:00.000Z";

function supabaseFalso(tabelas: Record<string, unknown[]>) {
  const inserts: string[] = [];
  // A leitura de conversas pagina por keyset até a página vazia (0324): a
  // segunda leitura de cada tabela devolve vazio.
  const lidas = new Set<string>();
  const from = (tabela: string) => {
    const linhas = tabela === "conversations" && lidas.has(tabela) ? [] : (tabelas[tabela] ?? []);
    lidas.add(tabela);
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) => resolve({ data: linhas, error: null });
          }
          if (prop === "maybeSingle") return async () => ({ data: linhas[0] ?? null, error: null });
          if (prop === "insert") {
            return () => {
              inserts.push(tabela);
              return chain;
            };
          }
          return () => chain;
        },
      },
    );
    return chain;
  };
  return { admin: { from } as never, inserts };
}

const conversa = {
  id: "conv-1",
  service_revision: 1,
  current_demanda_id: null,
  demandas: null,
  status: "open",
  contact_id: "contato-1",
  last_inbound_at: ULTIMA_ENTRADA,
  messages: [
    {
      organization_id: "org",
      contact_id: "contato-1",
      conversation_id: "conv-1",
      service_revision: 1,
      demanda_id: null,
      demanda_revision: null,
      sent_at: ULTIMA_ENTRADA,
    },
  ],
  contacts: { tags: [], is_blocked: false, ai_authorized_at: null, phone_number: "+5585987654321" },
  sessao: {
    metadata: { ai_gate: "allowlist", ai_gate_mode: "pre_go_live", ai_test_phone_numbers: ["+5585987654321"] },
  },
};

const entrada = { organization_id: "org", pointer_id: "ptr-1", contact_id: "contato-1" };

describe("silêncio — inscrição encerrada por atendimento humano", () => {
  it("encerrada depois da última mensagem do contato → mesmo silêncio, não reinscreve", async () => {
    const { admin, inserts } = supabaseFalso({
      conversations: [conversa],
      followup_enrollments: [{ started_at: "2026-09-01T11:00:00.000Z" }],
      messages: [{ sent_at: ULTIMA_ENTRADA }],
    });
    const db = createSupabaseSilenceSweepDb(admin);
    await db.loadSilentContacts("org", "2026-09-02T10:00:00.000Z", []);

    const r = await db.insertEnrollment({
      ...entrada,
      version_id: "ver-1",
      current_node_id: "trigger-1",
      next_eval_at: "2026-09-02T10:00:00.000Z",
      agent_id: null,
    });

    expect(r).toEqual({ inserted: false });
    expect(inserts).toEqual([]);
  });

  it("o contato falou depois do encerramento → silêncio novo, pode inscrever", async () => {
    const { admin } = supabaseFalso({
      followup_enrollments: [{ started_at: "2026-09-01T09:00:00.000Z" }],
      messages: [{ sent_at: ULTIMA_ENTRADA }],
    });
    await expect(encerradaPorHumanoNesteSilencio(admin, entrada)).resolves.toBe(false);
  });

  it("nenhuma inscrição encerrada por humano → pode inscrever", async () => {
    const { admin } = supabaseFalso({ followup_enrollments: [], messages: [{ sent_at: ULTIMA_ENTRADA }] });
    await expect(encerradaPorHumanoNesteSilencio(admin, entrada)).resolves.toBe(false);
  });
});
