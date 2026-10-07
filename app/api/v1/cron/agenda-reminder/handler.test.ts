/**
 * O CAMINHO DO CRON ATÉ O TEXTO QUE SAI — com o handler de verdade.
 *
 * `route.test.ts` prende o que a rota PEDE ao banco lendo a fonte, e
 * `texto-do-lembrete.test.ts` prende a função pura. Nenhum dos dois via se a
 * rota PASSA o molde e a unidade para a função: na revisão, trocar `molde` e
 * `unidade` por `null` na chamada deixou a suíte inteira verde, e o paciente
 * voltaria a receber a frase padrão sem ninguém perceber.
 *
 * Aqui o banco é um dublê que só devolve linhas — a decisão é toda da rota — e
 * o que se confere é o `body` que chega a `sendMessageHandler`.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: vi.fn(async () => ({})) }));
vi.mock("@/lib/automation/start-conversation", () => ({ ensureConversation: vi.fn(async () => "conversa-1") }));
vi.mock("@/lib/automation/janela-do-canal", () => ({ adiarAteAJanelaAbrir: vi.fn(async () => false) }));
vi.mock("@/lib/automation/throttle", () => ({ espacarEnvio: vi.fn(async () => undefined) }));
vi.mock("@/lib/users/nome-do-atendente", () => ({ nomesDosAtendentes: vi.fn(async () => new Map()) }));

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { audit } from "@/lib/audit";
import { providersDeEnvioAutomatico } from "@/lib/channels";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { GET } from "./route";

const AGORA = new Date("2026-10-12T15:00:00Z"); // 11:00 em Manaus, 12:00 em São Paulo
const ORG = "11111111-1111-4111-8111-111111111111";

type Linha = Record<string, unknown>;

/**
 * Um construtor de consulta que aceita qualquer encadeamento e responde pela
 * tabela. `update` marca a consulta como o carimbo.
 */
function dubleDoAdmin(opts: { linha: Linha; carimbaLinha?: boolean; modeloLegado?: string | null }) {
  const carimbos: Array<Record<string, unknown>> = [];
  const responder = (tabela: string, update: Record<string, unknown> | undefined) => {
    switch (tabela) {
      case "calendar_appointments":
        if (update) {
          carimbos.push(update);
          return { data: opts.carimbaLinha === false ? [] : [{ id: opts.linha.id }], error: null };
        }
        return { data: [opts.linha], error: null };
      case "contacts":
        return {
          data: { id: "contato-1", name: "Maria Silva", display_name: null, phone_number: "+5592999990000", is_blocked: false },
          error: null,
        };
      case "channel_sessions":
        return { data: [{ id: "zap-1", provider: providersDeEnvioAutomatico()[0] }], error: null };
      case "conversations":
        return { data: [], error: null };
      case "organizations":
        return { data: { locale: "pt-BR" }, error: null };
      case "message_templates":
        return { data: opts.modeloLegado ? { body: opts.modeloLegado } : null, error: null };
      default:
        throw new Error(`tabela inesperada: ${tabela}`);
    }
  };
  const admin = {
    from(tabela: string) {
      let update: Record<string, unknown> | undefined;
      const fim = () => Promise.resolve(responder(tabela, update));
      const q: Record<string, unknown> = new Proxy(
        {},
        {
          get(_alvo, prop) {
            if (prop === "then") return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => fim().then(ok, ko);
            if (prop === "maybeSingle") return fim;
            return (...args: unknown[]) => {
              if (prop === "update") update = args[0] as Record<string, unknown>;
              return q;
            };
          },
        },
      );
      return q;
    },
  };
  return { admin, carimbos };
}

function linhaDoCompromisso(tipo: Record<string, unknown>): Linha {
  return {
    id: "compromisso-1",
    organization_id: ORG,
    contact_id: "contato-1",
    title: "Consulta — Dr. André",
    starts_at: "2026-10-12T15:30:00.000Z", // 11:30 em Manaus
    time_zone: "America/Manaus",
    owner_user_id: null,
    created_at: "2026-10-10T10:00:00.000Z",
    starts_at_marked_at: null,
    location_details: null,
    reminder_sent_offsets_minutes: null,
    reminder_sent_at: null,
    calendar_units: { name: "Centro" },
    calendar_event_types: {
      name: "Consulta",
      reminder_enabled: true,
      reminder_minutes_before: 60,
      reminder_extra_offsets_minutes: null,
      reminder_template_name: null,
      reminder_body: null,
      location_details: null,
      ...tipo,
    },
  };
}

function rodar(opts: Parameters<typeof dubleDoAdmin>[0]) {
  const duble = dubleDoAdmin(opts);
  vi.mocked(createAdminClient).mockReturnValue(duble.admin as never);
  const req = new NextRequest("http://localhost/api/v1/cron/agenda-reminder", {
    headers: { authorization: "Bearer segredo" },
  });
  return { resposta: GET(req), carimbos: duble.carimbos };
}

function corpoEnviado(): string | undefined {
  const chamada = vi.mocked(sendMessageHandler).mock.calls[0];
  return (chamada?.[2] as { body?: string } | undefined)?.body;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AGORA);
});
afterEach(() => vi.useRealTimers());

describe("o cron manda o texto do TIPO, com a unidade e o fuso DO COMPROMISSO", () => {
  it("reminder_body preenchido: sai o molde, com a unidade embutida e a hora de Manaus", async () => {
    const { resposta, carimbos } = rodar({
      linha: linhaDoCompromisso({ reminder_body: "Oi {{primeiro_nome}}, {{quando}} às {{hora}} na {{unidade}}" }),
    });
    const corpo = (await (await resposta).json()) as { data: { enviados: number } };

    expect(corpo.data.enviados).toBe(1);
    expect(corpoEnviado()).toBe("Oi Maria, hoje às 11:30 na Centro");
    expect(carimbos[0]?.reminder_sent_offsets_minutes).toEqual([60]);
  });

  it("sem reminder_body e com o modelo legado: o modelo sai CRU, como sempre saiu", async () => {
    const { resposta } = rodar({
      linha: linhaDoCompromisso({ reminder_template_name: "lembrete" }),
      modeloLegado: "Modelo {{nome}} cru",
    });
    await resposta;

    expect(corpoEnviado()).toBe("Modelo {{nome}} cru");
  });

  it("controle: sem molde e sem modelo, a frase padrão — no fuso do compromisso", async () => {
    const { resposta } = rodar({ linha: linhaDoCompromisso({}) });
    await resposta;

    expect(corpoEnviado()).toContain("Passando pra lembrar");
    expect(corpoEnviado()).toContain("11:30");
  });
});

describe("a linha mudou entre a leitura e o carimbo (mudou_na_rodada)", () => {
  it("não envia, não audita — e deixa rastro no log", async () => {
    // O UPDATE condicional que não casa nenhuma linha. Se isso passar a
    // acontecer sempre (um filtro que o PostgREST lê diferente do dublê), os
    // lembretes param todos; sem envio não há audit, então o log é o único
    // rastro.
    const { resposta } = rodar({ linha: linhaDoCompromisso({}), carimbaLinha: false });
    const corpo = (await (await resposta).json()) as { data: { enviados: number; motivos: Record<string, number> } };

    expect(corpo.data.enviados).toBe(0);
    expect(corpo.data.motivos).toEqual({ mudou_na_rodada: 1 });
    expect(sendMessageHandler).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("mudou_na_rodada"),
      expect.objectContaining({ appointmentId: "compromisso-1" }),
    );
  });
});
