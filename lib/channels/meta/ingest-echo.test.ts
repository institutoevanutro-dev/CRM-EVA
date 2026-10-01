import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ingestMetaEcho } from "./ingest";
import type { EchoMessageEvent } from "./webhook";

const pausar = vi.fn(async (..._a: unknown[]) => true);
const posEntrada = vi.fn(async (..._a: unknown[]) => undefined);
const marcar = vi.fn(async (..._a: unknown[]) => undefined);

vi.mock("@/lib/escalacao/atendimento-manual", () => ({
  pausarIaPorAtendimentoManual: (...a: unknown[]) => pausar(...a),
}));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: (...a: unknown[]) => posEntrada(...a),
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: (...a: unknown[]) => marcar(...a),
}));

const ORG = "11111111-0000-4000-8000-000000000001";
const SESSAO = "22222222-0000-4000-8000-000000000002";
const CONTATO = "33333333-0000-4000-8000-000000000003";
const CONV = "44444444-0000-4000-8000-000000000004";

const ECO: EchoMessageEvent = {
  kind: "echo_message",
  wabaId: "222",
  phoneNumberId: "111",
  externalId: "wamid.ECO1",
  to: "5531998966398",
  sentAt: new Date("2026-10-10T12:00:00Z"),
  type: "text",
  text: "respondi pelo celular",
  media: null,
};

/**
 * Banco de mentira no formato de `adminFalso`
 * (`tests/unit/ingestao-do-canal-oficial-por-organizacao.test.ts`), com o que
 * este fluxo precisa a mais: registra as RPCs e os payloads de insert, e o
 * insert em `messages` devolve o erro que o caso quiser (23505 = duplicata).
 */
let rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
let inserts: Array<Record<string, unknown>>;
let insertErro: { code: string; message: string } | null;
let db: { messages: Array<Record<string, unknown>> };
let semSessao: boolean;
let erroContato: { message: string } | null;

function adminFalso(): SupabaseClient {
  const from = (tabela: string) => {
    let payload: Record<string, unknown> | null = null;
    // Os filtros valem de verdade: uma consulta a `messages` devolve as linhas
    // de `db.messages` que casam com eq/is — a pré-condição do caso P10 existe.
    const filtros: Record<string, unknown> = {};
    const resposta = () => {
      if (tabela === "channel_sessions") {
        return { data: semSessao ? null : { id: SESSAO, organization_id: ORG }, error: null };
      }
      if (tabela === "messages" && payload) {
        if (insertErro) return { data: null, error: insertErro };
        db.messages.push({ id: "m-eco", ...payload });
        return { data: { id: "m-eco" }, error: null };
      }
      if (tabela === "messages") {
        const linhas = db.messages.filter((m) => Object.entries(filtros).every(([k, v]) => (m[k] ?? null) === v));
        return { data: linhas, error: null };
      }
      // `contacts` por variantes: ninguém cadastrado ainda.
      return { data: [], error: null };
    };
    const filtrar = (coluna: string, valor: unknown) => {
      filtros[coluna] = valor;
      return alvo;
    };
    const alvo: Record<string, unknown> = {
      select: () => alvo,
      eq: filtrar,
      is: filtrar,
      in: () => alvo,
      order: () => alvo,
      limit: () => alvo,
      insert: (p: Record<string, unknown>) => {
        payload = p;
        inserts.push(p);
        return alvo;
      },
      maybeSingle: async () => {
        const r = resposta();
        return Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error } : r;
      },
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resposta()).then(ok, ko),
    };
    return alvo;
  };
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    rpcs.push({ fn, args });
    if (fn === "fn_upsert_wa_contact") return erroContato ? { data: null, error: erroContato } : { data: CONTATO, error: null };
    if (fn === "fn_upsert_wa_conversation") return { data: CONV, error: null };
    return { data: null, error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

let admin: SupabaseClient;

beforeEach(() => {
  rpcs = [];
  inserts = [];
  insertErro = null;
  db = { messages: [] };
  semSessao = false;
  erroContato = null;
  pausar.mockClear();
  posEntrada.mockClear();
  marcar.mockClear();
  admin = adminFalso();
});

describe("ingestMetaEcho — mensagem que a clínica mandou pelo celular", () => {
  it("grava outbound sent_via external_device, origem celular, e pausa a IA com a regra do atendimento manual", async () => {
    const r = await ingestMetaEcho(admin, ECO, { organizationId: ORG });
    expect(r).toMatchObject({ status: "ingested" });
    expect(inserts[0]).toMatchObject({
      organization_id: ORG,
      direction: "outbound",
      status: "sent",
      sent_via: "external_device",
      external_id: "wamid.ECO1",
      body: "respondi pelo celular",
      metadata: { origem: "celular", fromMe: true },
    });
    expect(pausar).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, conversationId: CONV, canal: "meta" }),
    );
    expect(posEntrada).not.toHaveBeenCalled();
    expect(marcar).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ direction: "outbound" }));
  });

  it("wamid já gravado → duplicate, e NÃO silencia (pode ser o eco de um envio do CRM reentregue)", async () => {
    insertErro = { code: "23505", message: "dup" };
    expect(await ingestMetaEcho(admin, ECO, { organizationId: ORG })).toEqual({ status: "duplicate" });
    expect(pausar).not.toHaveBeenCalled();
    expect(marcar).not.toHaveBeenCalled();
  });

  it("o contato é o DESTINATÁRIO e o nome do perfil não é passado (seria o da loja)", async () => {
    await ingestMetaEcho(admin, ECO, { organizationId: ORG });
    expect(rpcs.find((r) => r.fn === "fn_upsert_wa_contact")?.args).toMatchObject({
      p_chat_id: "5531998966398",
      p_notify: null,
    });
  });

  it("linha `queued` sem external_id na mesma conversa NÃO barra o eco (premissa decidida: a Meta não ecoa envio feito pela API)", async () => {
    // O gate do #519 (`ehEcoDeEnvioNosso`, lib/waha/ingest.ts) existe porque o WAHA
    // ecoa o que o próprio CRM enviou. Em `smb_message_echoes` a doc descreve só o
    // que saiu do APLICATIVO; se a premissa cair, o custo é a IA calada 5 min depois
    // do próprio envio — e este caso é o que vai mudar.
    db.messages.push({ id: "m-queued", organization_id: ORG, conversation_id: CONV, direction: "outbound", status: "queued", external_id: null });
    // A pré-condição é real: a consulta que um gate do #519 faria acha a linha.
    const { data: pendentes } = await admin
      .from("messages")
      .select("id")
      .eq("organization_id", ORG)
      .eq("conversation_id", CONV)
      .eq("direction", "outbound")
      .eq("status", "queued")
      .is("external_id", null);
    expect(pendentes).toEqual([expect.objectContaining({ id: "m-queued" })]);

    expect(await ingestMetaEcho(admin, ECO, { organizationId: ORG })).toMatchObject({ status: "ingested" });
    expect(pausar).toHaveBeenCalledTimes(1);
  });

  it("tipo exótico (interactive) entra como system com body [interactive], nunca viola o CHECK", async () => {
    await ingestMetaEcho(admin, { ...ECO, type: "interactive", text: null }, { organizationId: ORG });
    expect(inserts[0]).toMatchObject({ type: "system", body: "[interactive]" });
  });

  it("mídia pelo celular pede persistência com o ponteiro opaco da Meta", async () => {
    await ingestMetaEcho(
      admin,
      { ...ECO, type: "image", text: null, media: { id: "MID1", url: null, mime: "image/jpeg", voice: false } },
      { organizationId: ORG },
    );
    expect(inserts[0]).toMatchObject({ type: "image", media_url: "meta-media:MID1" });
    expect(rpcs.find((r) => r.fn === "emit_event")?.args).toMatchObject({
      p_event_type: "media.persist_requested",
      p_entity_id: "m-eco",
      p_metadata: { source: "meta_echo" },
    });
  });

  it("número que a organização não administra → no_session, nada gravado nem pausado", async () => {
    semSessao = true;
    expect(await ingestMetaEcho(admin, ECO, { organizationId: ORG })).toEqual({ status: "no_session" });
    expect(inserts).toEqual([]);
    expect(rpcs).toEqual([]);
    expect(pausar).not.toHaveBeenCalled();
  });

  it("contato que não resolve → failed com o motivo, sem mensagem nem pausa", async () => {
    erroContato = { message: "rls" };
    expect(await ingestMetaEcho(admin, ECO, { organizationId: ORG })).toEqual({ status: "failed", reason: "contato: rls" });
    expect(inserts).toEqual([]);
    expect(pausar).not.toHaveBeenCalled();
    expect(marcar).not.toHaveBeenCalled();
  });
});
