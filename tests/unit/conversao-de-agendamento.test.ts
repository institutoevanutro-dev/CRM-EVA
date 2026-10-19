/**
 * O aviso de agendamento para Meta e Google — as regras que quebram calado.
 *
 * Nenhuma chamada sai para a rede: `fetch` é substituído em todo caso, e o
 * banco é um fake em memória que guarda o livro-razão e os avisos da Central.
 *
 * Vetores de hash: as ENTRADAS seguem os exemplos de normalização das páginas
 * das plataformas (Meta: "customer information parameters"; Google Ads API:
 * "normalize and hash user-provided data"). Os HASHES foram calculados à parte
 * com `printf '%s' <valor> | shasum -a 256`, não com o código sob teste.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  conversaoDeAgendamentoHandler,
  esperaDaTentativa,
  lerOrigem,
  MAX_TENTATIVAS,
} from "@/lib/conversoes/agendamento.handler";
import { lerPreferencias, settingsComPreferencias } from "@/lib/conversoes/preferencias";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { lerResultadoDoUpload, montarCorpoGoogle } from "@/lib/plataformas-de-anuncio/google/conversions";
import {
  emailHashGoogle,
  emailHashMeta,
  idDoEvento,
  telefoneE164,
  telefoneHashGoogle,
  telefoneHashMeta,
} from "@/lib/plataformas-de-anuncio/identificadores";
import { montarCorpoMeta } from "@/lib/plataformas-de-anuncio/meta/conversions";
import type {
  ConversaoDeAgendamento,
  CredencialGoogle,
  CredencialMeta,
} from "@/lib/plataformas-de-anuncio/types";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const AGENDAMENTO = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";

// ─── vetores ────────────────────────────────────────────────────────────────

describe("normalização e hash, por plataforma", () => {
  it("telefone vira E.164 com `+`, sem símbolos nem zero à esquerda", () => {
    expect(telefoneE164("+1 (650) 555-1234")).toBe("+16505551234");
    expect(telefoneE164("+55 (11) 98888-7777")).toBe("+5511988887777");
    expect(telefoneE164("123")).toBeNull();
  });

  it("Meta: telefone só dígitos com país, SHA-256", () => {
    expect(telefoneHashMeta("+1 (650) 555-1234")).toBe(
      "6069d14bf122fdfd931dc7beb58e5dfbba395b1faf05bdcd42d12358d63d8599",
    );
    expect(telefoneHashMeta("+5511988887777")).toBe(
      "fde042094c292fe26c1752aa7760e8090d8dbc01a0f464054c0da6b72d18e8ad",
    );
  });

  it("Google: telefone E.164 COM `+`, SHA-256 — diferente da Meta", () => {
    expect(telefoneHashGoogle("+1 650-555-1234")).toBe(
      "a2996076d3ad4af5dc818b908b3d8e354f26ededf7df0e0aa6ac354143805ee0",
    );
    expect(telefoneHashGoogle("+5511988887777")).toBe(
      "0385b8568246d41d6bff25864c095f6cebb52c7e273ee7f88e5ff1b2c426e169",
    );
  });

  it("e-mail: Meta só apara e baixa; Google também tira os pontos do gmail", () => {
    expect(emailHashMeta("  Joe@EG.com ")).toBe("8830eedd6c6b5ea97d181563a349476ca1bb25ace1f94b5c5e48d9cad727941b");
    expect(emailHashMeta("Jane.Doe@gmail.com")).toBe(
      "831f6494ad6be4fcb3a724c3d5fef22d3ceffa3c62ef3a7984e45a0ea177f982",
    );
    expect(emailHashGoogle("Jane.Doe@gmail.com")).toBe(
      "d6117306485ed0e50afab3ac871e98f81699151f30281527d63ff5f233656c69",
    );
    expect(emailHashGoogle("sem-arroba")).toBeNull();
  });

  it("o id do evento é determinístico, curto e não contém o id do agendamento", () => {
    expect(idDoEvento("org", "appt", "Schedule")).toBe("12107b2835471e2b8242968892f01a20");
    expect(idDoEvento(ORG, AGENDAMENTO, "Schedule")).not.toContain(AGENDAMENTO.slice(0, 8));
  });
});

// ─── o corpo enviado ────────────────────────────────────────────────────────

const conversaoBase: ConversaoDeAgendamento = {
  organizationId: ORG,
  agendamentoId: AGENDAMENTO,
  evento: "Schedule",
  eventoId: idDoEvento(ORG, AGENDAMENTO, "Schedule"),
  ocorridoEm: new Date("2026-10-19T12:00:00Z"),
  telefone: "+5511988887777",
  email: "paciente@example.com",
  cliqueMeta: null,
  cliqueGoogle: null,
};
const meta: CredencialMeta = { plataforma: "meta_ads", datasetId: "1234567", accessToken: "t", testEventCode: null };
const google: CredencialGoogle = {
  plataforma: "google_ads",
  customerId: "1234567890",
  loginCustomerId: null,
  conversionActionId: "987",
  clientId: "cliente.apps.googleusercontent.com",
  clientSecret: "s",
  refreshToken: "r",
  developerToken: "d",
};

/** Todas as chaves de um objeto JSON, em qualquer profundidade. */
function chaves(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(chaves);
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...chaves(x)]);
  return [];
}

const PROIBIDAS = /value|currency|custom_data|stage|etapa|procedure|procedimento|appointment|event_type|tipo|professional|profissional|owner|note|observa|title|name|nome|description|content|conversionValue|currencyCode/i;

describe("o corpo enviado é uma lista fechada", () => {
  it("Meta: só evento, hora, id, origem e identificadores hasheados", () => {
    const corpo = montarCorpoMeta(meta, conversaoBase)!;
    const texto = JSON.stringify(corpo);
    expect(texto).not.toContain("5511988887777");
    expect(texto).not.toContain("paciente@example.com");
    expect(texto).not.toContain(AGENDAMENTO);
    const evento = (corpo.data as Record<string, unknown>[])[0]!;
    expect(Object.keys(evento).sort()).toEqual(["action_source", "event_id", "event_name", "event_time", "user_data"]);
    expect(evento.event_name).toBe("Schedule");
    expect(evento.action_source).toBe("chat");
    expect(evento.event_time).toBe(Math.floor(Date.parse("2026-10-19T12:00:00Z") / 1000));
    expect(Object.keys(evento.user_data as object).sort()).toEqual(["em", "ph"]);
    expect(chaves(corpo).filter((k) => PROIBIDAS.test(k) && k !== "event_name")).toEqual([]);
  });

  it("Meta com clique: `business_messaging` + WhatsApp + `ctwa_clid`", () => {
    const evento = (montarCorpoMeta(meta, { ...conversaoBase, cliqueMeta: "CLIQUE" })!.data as Record<string, unknown>[])[0]!;
    expect(evento.action_source).toBe("business_messaging");
    expect(evento.messaging_channel).toBe("whatsapp");
    expect((evento.user_data as Record<string, unknown>).ctwa_clid).toBe("CLIQUE");
  });

  it("Google: ação, hora, orderId e identificadores hasheados — sem valor", () => {
    const corpo = montarCorpoGoogle(google, conversaoBase)!;
    const texto = JSON.stringify(corpo);
    expect(texto).not.toContain("5511988887777");
    expect(texto).not.toContain("paciente@example.com");
    const c = (corpo.conversions as Record<string, unknown>[])[0]!;
    expect(Object.keys(c).sort()).toEqual(["conversionAction", "conversionDateTime", "orderId", "userIdentifiers"]);
    expect(c.conversionDateTime).toBe("2026-10-19 12:00:00+00:00");
    expect(c.userIdentifiers).toEqual([
      { hashedPhoneNumber: "0385b8568246d41d6bff25864c095f6cebb52c7e273ee7f88e5ff1b2c426e169" },
      { hashedEmail: emailHashGoogle("paciente@example.com") },
    ]);
    expect(corpo.partialFailure).toBe(true);
    expect(chaves(corpo).filter((k) => PROIBIDAS.test(k) && k !== "conversionAction")).toEqual([]);
  });

  it("Google: falha parcial vira código enumerado, nunca a mensagem", () => {
    const r = lerResultadoDoUpload({
      partialFailureError: { code: 3, message: "telefone +5511 inválido", details: [{ errors: [{ errorCode: { conversionUploadError: "INVALID_CONVERSION_ACTION" } }] }] },
    });
    expect(r).toEqual({ tipo: "permanente", codigo: "google_INVALID_CONVERSION_ACTION" });
    expect(lerResultadoDoUpload({ results: [{ conversionAction: "customers/1/conversionActions/2" }] })).toEqual({ tipo: "ok" });
  });
});

// ─── o handler ──────────────────────────────────────────────────────────────

interface Banco {
  compromisso: Record<string, unknown> | null;
  contato: Record<string, unknown> | null;
  settings: Record<string, unknown>;
  conexoes: Record<string, Record<string, unknown>>;
  livro: Record<string, unknown>[];
  avisos: Record<string, unknown>[];
}
let banco: Banco;

function fakeAdmin() {
  let seq = 0;
  return {
    rpc: async () => ({ data: "segredo-decifrado", error: null }),
    from(tabela: string) {
      let op: "select" | "insert" | "update" = "select";
      let valores: Record<string, unknown> = {};
      const filtros: Array<[string, unknown]> = [];
      let ids: unknown[] | null = null;
      const casa = (l: Record<string, unknown>) =>
        filtros.every(([k, v]) => l[k] === v) && (!ids || ids.includes(l.id));
      const resolver = async (unico: boolean) => {
        if (tabela === "calendar_appointments") return { data: banco.compromisso, error: null };
        if (tabela === "contacts") return { data: banco.contato, error: null };
        if (tabela === "organizations") return { data: { settings: banco.settings }, error: null };
        if (tabela === "ad_platform_connections") {
          const p = filtros.find(([k]) => k === "platform")?.[1] as string;
          return { data: banco.conexoes[p] ?? null, error: null };
        }
        if (tabela === "agent_inbox_items") {
          if (banco.avisos.some((a) => a.organization_id === valores.organization_id))
            return { data: null, error: { code: "23505", message: "dup" } };
          banco.avisos.push(valores);
          return { data: null, error: null };
        }
        // ad_conversion_dispatches
        if (op === "insert") {
          const linha: Record<string, unknown> = { id: `l${++seq}`, next_attempt_at: null, ...valores };
          if (banco.livro.some((l) => l.appointment_id === linha.appointment_id && l.platform === linha.platform))
            return { data: null, error: { code: "23505", message: "dup" } };
          banco.livro.push(linha);
          return { data: { id: linha.id }, error: null };
        }
        if (op === "update") {
          const alvo = banco.livro.filter(casa);
          alvo.forEach((l) => Object.assign(l, valores));
          return { data: alvo.map((l) => ({ id: l.id })), error: null };
        }
        const linhas = banco.livro.filter(casa);
        return { data: unico ? (linhas[0] ?? null) : linhas, error: null };
      };
      const b = {
        select: () => b,
        insert: (v: Record<string, unknown>) => ((op = "insert"), (valores = v), b),
        update: (v: Record<string, unknown>) => ((op = "update"), (valores = v), b),
        eq: (k: string, v: unknown) => (filtros.push([k, v]), b),
        in: (_k: string, v: unknown[]) => ((ids = v), b),
        maybeSingle: () => resolver(true),
        then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => resolver(false).then(ok, erro),
      };
      return b;
    },
  };
}

const conexaoMeta = { enabled: true, dataset_id: "1234567", access_token_encrypted: "\\xaa", test_event_code: null };
const conexaoGoogle = {
  enabled: true,
  google_customer_id: "1234567890",
  google_login_customer_id: null,
  google_conversion_action_id: "987",
  google_oauth_client_id: "cliente.apps.googleusercontent.com",
  google_oauth_client_secret_encrypted: "\\xbb",
  google_refresh_token_encrypted: "\\xcc",
  google_developer_token_encrypted: "\\xdd",
};

function evento(tipo = "appointment.created"): EventRow {
  return {
    id: "evt",
    organization_id: ORG,
    event_type: tipo,
    entity_kind: "calendar_appointment",
    entity_id: AGENDAMENTO,
    // O payload real traz o nome do tipo de consulta. Ele não pode sair.
    payload: { appointment_id: AGENDAMENTO, event_type_name: "Avaliação de botox", contact_id: CONTATO },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date().toISOString(),
  };
}

let corpos: string[];
function redeQueResponde(meta200 = true) {
  corpos = [];
  return vi.spyOn(globalThis, "fetch").mockClear().mockImplementation(async (url, init) => {
    const u = String(url);
    corpos.push(String((init as RequestInit).body ?? ""));
    if (u.includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "acesso" }));
    if (u.includes("googleads")) return new Response(JSON.stringify({ results: [{ conversionAction: "x" }] }));
    return meta200
      ? new Response(JSON.stringify({ events_received: 1 }))
      : new Response(JSON.stringify({ error: { code: 1 } }), { status: 503 });
  });
}

beforeEach(() => {
  banco = {
    compromisso: {
      id: AGENDAMENTO,
      status: "confirmed",
      contact_id: CONTATO,
      created_at: new Date().toISOString(),
      source: "ui",
      history_import_key: null,
      excluded_at: null,
    },
    contato: {
      phone_number: "+5511988887777",
      email: null,
      is_blocked: false,
      ai_opt_out: false,
      is_anonymized: false,
      is_merged_into: null,
      inbox_hidden_at: null,
      source_metadata: { ad_platform: "meta_ads", ad_source_id: "ID_DO_ANUNCIO", ad_raw: { sourceId: "ID_DO_ANUNCIO" } },
    },
    settings: {},
    conexoes: { meta_ads: { ...conexaoMeta } },
    livro: [],
    avisos: [],
  };
  vi.mocked(createAdminClient).mockImplementation(() => fakeAdmin() as never);
});
afterEach(() => vi.restoreAllMocks());

describe("o handler", () => {
  it("escuta só agendamento criado e confirmado", () => {
    expect(conversaoDeAgendamentoHandler.events).toEqual(["appointment.created", "appointment.confirmed"]);
  });

  it("desligado por padrão: sem conexão ligada, nada sai", async () => {
    banco.conexoes = {};
    const rede = redeQueResponde();
    const r = await conversaoDeAgendamentoHandler.handle(evento());
    expect(r.status).toBe("ok");
    expect(rede).not.toHaveBeenCalled();
    banco.conexoes = { meta_ads: { ...conexaoMeta, enabled: false } };
    await conversaoDeAgendamentoHandler.handle(evento());
    expect(rede).not.toHaveBeenCalled();
    expect(banco.livro).toEqual([]);
  });

  it("envia uma vez, e o segundo evento do mesmo agendamento não reenvia", async () => {
    const rede = redeQueResponde();
    await conversaoDeAgendamentoHandler.handle(evento("appointment.created"));
    await conversaoDeAgendamentoHandler.handle(evento("appointment.confirmed"));
    await conversaoDeAgendamentoHandler.handle(evento("appointment.created"));
    expect(rede).toHaveBeenCalledTimes(1);
    expect(banco.livro).toHaveLength(1);
    expect(banco.livro[0]).toMatchObject({ status: "sent", platform: "meta_ads", appointment_id: AGENDAMENTO, attempts: 1 });
    // Nada de paciente no livro-razão.
    expect(JSON.stringify(banco.livro)).not.toContain("5511988887777");
    // Nem o nome do tipo de consulta, nem o id do anúncio como se fosse clique.
    expect(corpos.join()).not.toContain("botox");
    expect(corpos.join()).not.toContain("ID_DO_ANUNCIO");
  });

  it("agendamento cancelado: nada sai, e a tentativa pendente é encerrada", async () => {
    redeQueResponde(false);
    await conversaoDeAgendamentoHandler.handle(evento());
    expect(banco.livro[0]).toMatchObject({ status: "pending", attempts: 1 });

    banco.compromisso = { ...banco.compromisso!, status: "cancelled" };
    const rede = redeQueResponde();
    const r = await conversaoDeAgendamentoHandler.handle(evento("appointment.confirmed"));
    expect(r.status).toBe("skipped");
    expect(rede).not.toHaveBeenCalled();
    expect(banco.livro[0]).toMatchObject({ status: "skipped", reason: "agendamento_cancelado" });
  });

  it.each([
    ["is_blocked", true, "contato_bloqueado"],
    ["ai_opt_out", true, "sempre_atendimento_humano"],
    ["is_anonymized", true, "contato_anonimizado"],
    ["inbox_hidden_at", "2026-10-01T00:00:00Z", "contato_oculto"],
  ])("contato com %s nunca sai", async (campo, valor, motivo) => {
    banco.contato = { ...banco.contato!, [campo]: valor };
    const rede = redeQueResponde();
    const r = await conversaoDeAgendamentoHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: motivo });
    expect(rede).not.toHaveBeenCalled();
  });

  it("só quem veio de anúncio (padrão): orgânico não sai; desligado, sai", async () => {
    banco.contato = { ...banco.contato!, source_metadata: {} };
    const rede = redeQueResponde();
    await conversaoDeAgendamentoHandler.handle(evento());
    expect(rede).not.toHaveBeenCalled();

    banco.settings = settingsComPreferencias({}, { somenteDeAnuncio: false });
    await conversaoDeAgendamentoHandler.handle(evento());
    expect(rede).toHaveBeenCalledTimes(1);
  });

  it("quem veio da Meta não vai para o Google enquanto a opção estiver ligada", async () => {
    banco.conexoes.google_ads = { ...conexaoGoogle };
    const rede = redeQueResponde();
    await conversaoDeAgendamentoHandler.handle(evento());
    expect(rede.mock.calls.map(([u]) => String(u)).some((u) => u.includes("google"))).toBe(false);

    banco.settings = settingsComPreferencias({}, { somenteDeAnuncio: false });
    await conversaoDeAgendamentoHandler.handle(evento("appointment.confirmed"));
    expect(rede.mock.calls.map(([u]) => String(u)).some((u) => u.includes("googleads"))).toBe(true);
    expect(banco.livro.map((l) => l.status)).toEqual(["sent", "sent"]);
  });

  it("desligar a conexão para o que estava esperando nova tentativa", async () => {
    redeQueResponde(false);
    const r1 = await conversaoDeAgendamentoHandler.handle(evento());
    expect(r1.status).toBe("retry");

    banco.conexoes.meta_ads = { ...conexaoMeta, enabled: false };
    banco.livro[0]!.next_attempt_at = null;
    const rede = redeQueResponde();
    await conversaoDeAgendamentoHandler.handle(evento());
    expect(rede).not.toHaveBeenCalled();
    expect(banco.livro[0]).toMatchObject({ status: "skipped", reason: "conexao_desabilitada" });
  });

  it("falha transitória tenta de novo com espera crescente e, esgotada, abre UM aviso", async () => {
    expect([1, 2, 3, 7, 8].map(esperaDaTentativa)).toEqual([60_000, 120_000, 240_000, 3_600_000, 3_600_000]);
    redeQueResponde(false);
    for (let i = 0; i < MAX_TENTATIVAS; i++) {
      await conversaoDeAgendamentoHandler.handle(evento());
      if (banco.livro[0]) banco.livro[0].next_attempt_at = null;
    }
    expect(banco.livro[0]).toMatchObject({ status: "error", attempts: MAX_TENTATIVAS, error_code: "http_503" });
    expect(banco.avisos).toHaveLength(1);
    expect(banco.avisos[0]).toMatchObject({ kind: "ad_conversion_failing", organization_id: ORG });
    expect(JSON.stringify(banco.avisos)).not.toContain("5511988887777");
  });

  it("compromisso importado não é agendamento novo", async () => {
    banco.compromisso = { ...banco.compromisso!, source: "historical_import" };
    const rede = redeQueResponde();
    expect((await conversaoDeAgendamentoHandler.handle(evento())).detail).toBe("importado");
    expect(rede).not.toHaveBeenCalled();
  });
});

describe("leituras", () => {
  it("o clique da Meta vem só do payload cru, nunca do id do anúncio", () => {
    expect(lerOrigem({ ad_platform: "meta_ads", ad_source_id: "ANUNCIO" }).cliqueMeta).toBeNull();
    expect(lerOrigem({ ad_platform: "meta_ads", ad_raw: { ctwa_clid: "C1" } }).cliqueMeta).toBe("C1");
    expect(lerOrigem({ ad_platform: "meta_ads", ad_raw: { ctwaClid: "C2" } }).cliqueMeta).toBe("C2");
    expect(lerOrigem({ ad_platform: "outra" }).plataforma).toBeNull();
  });

  it("a preferência nasce ligada e sobrevive a lixo", () => {
    expect(lerPreferencias(undefined).somenteDeAnuncio).toBe(true);
    expect(lerPreferencias({ conversoes: { somente_de_anuncio: "não" } }).somenteDeAnuncio).toBe(true);
    expect(lerPreferencias({ conversoes: { somente_de_anuncio: false } }).somenteDeAnuncio).toBe(false);
    expect(settingsComPreferencias({ outra: 1 }, { somenteDeAnuncio: false })).toEqual({
      outra: 1,
      conversoes: { somente_de_anuncio: false },
    });
  });
});
