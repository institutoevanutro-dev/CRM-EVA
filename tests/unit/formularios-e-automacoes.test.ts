import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { mensagemDoErroDaAutomacao } from "@/app/app/webhooks/_components/labels";
import { runAutomationForEvent } from "@/lib/automation/engine";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { createAutomationRuleSchema } from "@/lib/schemas/webhooks";
import { ehEnvioDeTeste, HEADER_LEAD_DE_TESTE, PREFIXO_REQUEST_DE_TESTE } from "@/lib/webhooks/lead-de-teste";
import { paginaDeObrigado } from "@/lib/webhooks/pagina-de-obrigado";

/**
 * Tela "Formulários e automações" (ex-Webhooks), lote 9 da auditoria de 17/11:
 *  - "Enviar lead de teste" é teste de verdade: o motor de regras pula o
 *    `lead.created` do teste (decisão do dono, 18/11/2026);
 *  - formulário de site sem página de agradecimento vê uma página, não JSON;
 *  - erro ao salvar automação diz o campo, em português.
 */

const linha = (requestId: string): EventRow => ({
  id: "ev-1",
  organization_id: "org-1",
  event_type: "lead.created",
  entity_kind: "crm_lead",
  entity_id: "lead-1",
  payload: {},
  metadata: { request_id: requestId },
  consumed_by: [],
  attempts: 0,
});

/** Se o motor tocar no banco, o teste explode: o pulo tem de vir antes. */
const bancoProibido = new Proxy({}, {
  get() {
    throw new Error("o motor não deveria consultar o banco num lead de teste");
  },
}) as SupabaseClient;

describe("lead de teste", () => {
  it("⭐ o motor de regras pula o lead.created do teste sem tocar no banco", async () => {
    const r = await runAutomationForEvent(bancoProibido, linha(`${PREFIXO_REQUEST_DE_TESTE}abc`));
    expect(r).toMatchObject({ status: "skipped", detail: "lead_de_teste" });
  });

  it("CONTROLE: um lead.created comum chega a consultar as regras", async () => {
    await expect(runAutomationForEvent(bancoProibido, linha("abc"))).rejects.toThrow(/banco/);
  });

  it("o cabeçalho só vale com o valor 1", () => {
    expect(ehEnvioDeTeste(new Headers({ [HEADER_LEAD_DE_TESTE]: "1" }))).toBe(true);
    expect(ehEnvioDeTeste(new Headers({ [HEADER_LEAD_DE_TESTE]: "0" }))).toBe(false);
    expect(ehEnvioDeTeste(new Headers())).toBe(false);
  });
});

describe("página de agradecimento padrão", () => {
  it("⭐ responde HTML legível, não JSON", async () => {
    const res = paginaDeObrigado("req-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const corpo = await res.text();
    expect(corpo).toContain("Recebemos seus dados");
    expect(corpo).not.toContain("lead_id");
  });
});

describe("erro ao salvar automação", () => {
  const primeiroErro = (payload: unknown) => {
    const r = createAutomationRuleSchema.safeParse(payload);
    if (r.success) throw new Error("devia falhar");
    return mensagemDoErroDaAutomacao(r.error.issues[0]);
  };

  it("⭐ nome vazio diz o campo, em português", () => {
    expect(primeiroErro({ name: "", trigger_event: "lead.created", actions: [] })).toBe(
      "Dê um nome à automação.",
    );
  });

  it("⭐ sem ação pede uma ação", () => {
    expect(primeiroErro({ name: "Boas-vindas", trigger_event: "lead.created", actions: [] })).toBe(
      "Adicione pelo menos uma ação.",
    );
  });

  it("⭐ id inválido na ação diz o que escolher", () => {
    expect(
      primeiroErro({
        name: "Boas-vindas",
        trigger_event: "lead.created",
        actions: [{ type: "send_whatsapp_message", config: { channel_session_id: "", template: "Oi" } }],
      }),
    ).toBe("Escolha o número de WhatsApp na ação.");
  });

  it("erro custom do schema passa como está", () => {
    expect(
      primeiroErro({
        name: "Aviso",
        trigger_event: "lead.created",
        actions: [
          { type: "send_email", config: { destinatario: "fixo", assunto: "Novo", corpo: "Chegou" } },
        ],
      }),
    ).toBe("Informe o endereço de e-mail que recebe os envios desta regra.");
  });
});
