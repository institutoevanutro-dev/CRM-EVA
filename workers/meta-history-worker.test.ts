import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";

import { processarChunkDeHistorico } from "./meta-history-worker";

const posEntrada = vi.fn(async (..._a: unknown[]) => undefined);
const marcar = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: (...a: unknown[]) => posEntrada(...a) }));
vi.mock("@/lib/channels/marcar-conversa", () => ({ marcarConversaComMensagem: (...a: unknown[]) => marcar(...a) }));

const ORG = "11111111-0000-4000-8000-000000000001";
const SESSAO = "22222222-0000-4000-8000-000000000002";
const CONTATO = "33333333-0000-4000-8000-000000000003";
const CONV = "44444444-0000-4000-8000-000000000004";

/** O `value` cru do webhook `history` (fixture da Parte A): H1 do contato, H2 do celular. */
const FIXTURES = JSON.parse(readFileSync("tests/fixtures/meta/coexistencia-webhooks.json", "utf8")) as Array<{
  entry: Array<{ changes: Array<{ value: Record<string, unknown> }> }>;
}>;
const FIXTURE_HISTORY_VALUE = FIXTURES[1]!.entry[0]!.changes[0]!.value;

const LINHA: EventRow = {
  id: "ev1", organization_id: ORG, event_type: "meta.history_chunk", entity_kind: "channel_session", entity_id: SESSAO,
  consumed_by: [], attempts: 0, metadata: {},
  payload: { phone_number_id: "111", fase: 0, progresso: 20, chunk_order: 1, erro_codigo: null, value: FIXTURE_HISTORY_VALUE },
};

function comMensagens(msgs: Array<Record<string, unknown>>): EventRow {
  const value = { history: [{ metadata: { phase: 0, chunk_order: 1, progress: 20 }, threads: [{ id: "5531998966398", messages: msgs }] }] };
  return { ...LINHA, payload: { ...LINHA.payload, value } };
}

const COEX = { onboarding_em: "2026-10-01T00:00:00.000Z", pedidos: { contatos: null, historico: { request_id: "r1" } }, historico: null };

let rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
let inserts: Array<Record<string, unknown>>;
let updates: Array<{ tabela: string; patch: Record<string, unknown>; filtros: Record<string, unknown> }>;
let insertErro: { code: string; message: string } | null;
let insertErroPorExternalId: Record<string, { code: string; message: string }>;
let db: {
  sessoes: Record<string, { id: string; phone_number: string; metadata: Record<string, unknown>; archived_at: string | null }>;
  conversas: Record<string, { last_message_at: string | null; last_message_preview: string | null }>;
};

/** Banco de mentira no formato de `lib/channels/meta/ingest-echo.test.ts`: filtros eq/is valem, updates e inserts ficam registrados. */
function adminFalso(): SupabaseClient {
  const from = (tabela: string) => {
    let insert: Record<string, unknown> | null = null;
    let patch: Record<string, unknown> | null = null;
    const filtros: Record<string, unknown> = {};
    const resposta = () => {
      if (patch) {
        updates.push({ tabela, patch, filtros: { ...filtros } });
        const s = tabela === "channel_sessions" ? db.sessoes[String(filtros.id)] : undefined;
        if (s && patch.metadata) s.metadata = patch.metadata as Record<string, unknown>;
        return { data: null, error: null };
      }
      if (tabela === "messages" && insert) {
        const erro = insertErroPorExternalId[String(insert.external_id)] ?? insertErro;
        if (erro) return { data: null, error: erro };
        inserts.push(insert);
        return { data: { id: `m-${String(insert.external_id)}` }, error: null };
      }
      if (tabela === "channel_sessions") {
        const s = db.sessoes[String(filtros.id)];
        return { data: s && filtros.organization_id === ORG ? structuredClone(s) : null, error: null }; // cópia: como o banco, a leitura não acompanha mudanças posteriores
      }
      if (tabela === "conversations") return { data: db.conversas[String(filtros.id)] ?? null, error: null };
      return { data: [], error: null }; // contacts por variantes: ninguém ainda
    };
    const filtrar = (coluna: string, valor: unknown) => {
      filtros[coluna] = valor;
      return alvo;
    };
    const alvo: Record<string, unknown> = {
      select: () => alvo, eq: filtrar, is: filtrar, in: () => alvo, order: () => alvo, limit: () => alvo,
      insert: (p: Record<string, unknown>) => { insert = p; return alvo; },
      update: (p: Record<string, unknown>) => { patch = p; return alvo; },
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
    if (fn === "fn_upsert_wa_contact") {
      aoResolverContato?.();
      return { data: CONTATO, error: null };
    }
    if (fn === "fn_upsert_wa_conversation" || fn === "fn_upsert_wa_conversation_do_historico") return { data: CONV, error: null };
    return { data: null, error: null };
  };
  return { from, rpc } as unknown as SupabaseClient;
}

let aoResolverContato: (() => void) | null;
let admin: SupabaseClient;
const metadataGravada = () => updates.find((u) => u.tabela === "channel_sessions")?.patch.metadata;

beforeEach(() => {
  rpcs = [];
  inserts = [];
  updates = [];
  insertErro = null;
  insertErroPorExternalId = {};
  db = {
    sessoes: { [SESSAO]: { id: SESSAO, phone_number: "+5527999049879", metadata: { coexistencia: COEX }, archived_at: null } },
    conversas: {},
  };
  aoResolverContato = null;
  posEntrada.mockClear();
  marcar.mockClear();
  admin = adminFalso();
});

describe("processarChunkDeHistorico", () => {
  it("direção pela origem: from = número do negócio → outbound; sent_at do timestamp original; marca importada", async () => {
    await processarChunkDeHistorico(LINHA, admin);
    expect(inserts.map((i) => [i.external_id, i.direction])).toEqual([["wamid.H1", "inbound"], ["wamid.H2", "outbound"]]);
    expect(inserts[0]).toMatchObject({
      sent_at: new Date(1759000000 * 1000).toISOString(), status: "delivered", body: "oi",
      metadata: { importada_do_historico: true, origem: "contato" },
    });
    expect(inserts[1]).toMatchObject({ sent_via: "external_device", status: "sent", metadata: { importada_do_historico: true, origem: "celular" } });
    expect(inserts[0]).not.toHaveProperty("sent_via");
  });

  it("não chama efeitos pós-entrada nem carimba a conversa (last_inbound_at intocado)", async () => {
    await processarChunkDeHistorico(LINHA, admin);
    expect(inserts).toHaveLength(2);
    expect(posEntrada).not.toHaveBeenCalled();
    expect(marcar).not.toHaveBeenCalled();
    expect(rpcs.map((r) => r.fn)).not.toContain("fn_mark_conversation_message");
    const patches = updates.filter((u) => u.tabela === "conversations").map((u) => Object.keys(u.patch).sort());
    for (const chaves of patches) expect(chaves).toEqual(["last_message_at", "last_message_preview"]);
  });

  it("reprocessar o mesmo chunk não duplica (23505 é ok) e devolve ok", async () => {
    insertErro = { code: "23505", message: "dup" };
    const r = await processarChunkDeHistorico(LINHA, admin);
    expect(r).toMatchObject({ status: "ok", detail: "gravadas=0 duplicadas=2 falhas=0" });
    expect(inserts).toHaveLength(0);
  });

  it("direção com/sem o 9: from '552799049879' (sem o 9) ainda é o número do negócio '+5527999049879'", async () => {
    await processarChunkDeHistorico(
      comMensagens([{ from: "552799049879", id: "wamid.H9", timestamp: "1759000200", type: "text", text: { body: "sem o nove" } }]),
      admin,
    );
    expect(inserts[0]).toMatchObject({ external_id: "wamid.H9", direction: "outbound" });
  });

  it("mídia dos últimos 14 dias pede media.persist_requested; mais velha vira midia_indisponivel", async () => {
    const ha3dias = String(Math.floor((Date.now() - 3 * 86_400_000) / 1000));
    const ha40dias = String(Math.floor((Date.now() - 40 * 86_400_000) / 1000));
    await processarChunkDeHistorico(
      comMensagens([
        { from: "5531998966398", id: "wamid.IMG3", timestamp: ha3dias, type: "image", image: { id: "media-3", mime_type: "image/jpeg" } },
        { from: "5531998966398", id: "wamid.IMG40", timestamp: ha40dias, type: "image", image: { id: "media-40", mime_type: "image/jpeg" } },
      ]),
      admin,
    );
    expect(inserts[0]).toMatchObject({ media_url: "meta-media:media-3", metadata: { meta_media_id: "media-3" } });
    expect(inserts[1]).toMatchObject({ media_url: null, metadata: { midia_indisponivel: true } });
    const persistencias = rpcs.filter((r) => r.fn === "emit_event" && r.args.p_event_type === "media.persist_requested");
    expect(persistencias).toHaveLength(1);
    expect(persistencias[0]!.args).toMatchObject({ p_entity_id: "m-wamid.IMG3", p_metadata: { source: "meta_history" } });
  });

  it("tipo exótico entra como system com body [tipo] (CHECK do banco)", async () => {
    await processarChunkDeHistorico(
      comMensagens([{ from: "5531998966398", id: "wamid.BTN", timestamp: "1759000300", type: "button", button: { text: "Sim" } }]),
      admin,
    );
    expect(inserts[0]).toMatchObject({ type: "system", body: "[button]", metadata: { tipo_da_meta: "button" } });
  });

  it("erro numa mensagem pula só ela: as outras entram e o chunk devolve ok com a contagem", async () => {
    insertErroPorExternalId = { "wamid.H1": { code: "23514", message: "check violation" } };
    const r = await processarChunkDeHistorico(LINHA, admin);
    expect(inserts.map((i) => i.external_id)).toEqual(["wamid.H2"]);
    expect(r).toMatchObject({ status: "ok", detail: "gravadas=1 duplicadas=0 falhas=1" });
  });

  it("progresso vai para metadata.coexistencia.historico; progresso 100 marca concluido", async () => {
    await processarChunkDeHistorico(LINHA, admin);
    expect(metadataGravada()).toMatchObject({
      coexistencia: { ...COEX, historico: { fase: 0, progresso: 20, concluido: false, erro_codigo: null } },
    });
    updates.length = 0;
    await processarChunkDeHistorico({ ...LINHA, payload: { ...LINHA.payload, progresso: 100 } }, admin);
    expect(metadataGravada()).toMatchObject({ coexistencia: { historico: { progresso: 100, concluido: true } } });
  });

  it("erro 2593109 grava historico.erro_codigo (a frase é montada na tela, traduzida)", async () => {
    await processarChunkDeHistorico({ ...LINHA, payload: { ...LINHA.payload, erro_codigo: 2593109, value: { history: [] } } }, admin);
    expect(metadataGravada()).toMatchObject({ coexistencia: { historico: { erro_codigo: 2593109 } } });
    expect(inserts).toHaveLength(0);
  });

  it("ao concluir ok, limpa payload.value do event_log (LGPD) filtrando organization_id e id", async () => {
    await processarChunkDeHistorico(LINHA, admin);
    const limpeza = updates.find((u) => u.tabela === "event_log");
    expect(limpeza?.filtros).toMatchObject({ organization_id: ORG, id: "ev1" });
    expect(limpeza?.patch.payload).toMatchObject({ value: null, progresso: 20, chunk_order: 1 });
    expect(typeof (limpeza?.patch.payload as { limpo_em?: unknown }).limpo_em).toBe("string");
  });

  it("prévia da conversa só avança se o histórico é mais novo que o que já há, e nunca por fn_mark_conversation_message", async () => {
    db.conversas[CONV] = { last_message_at: "2026-10-01T00:00:00.000Z", last_message_preview: "atual" };
    await processarChunkDeHistorico(LINHA, admin); // mensagens de 2025-09-27: mais velhas
    expect(updates.filter((u) => u.tabela === "conversations")).toHaveLength(0);
    db.conversas[CONV] = { last_message_at: "2025-01-01T00:00:00.000Z", last_message_preview: "velha" };
    await processarChunkDeHistorico(LINHA, admin);
    const prev = updates.find((u) => u.tabela === "conversations");
    expect(prev?.patch).toEqual({ last_message_at: new Date(1759000100 * 1000).toISOString(), last_message_preview: "olá" });
    expect(prev?.filtros).toMatchObject({ organization_id: ORG, id: CONV });
  });

  it("sessão arquivada → skipped sem gravar nada (e o bruto sai da fila mesmo assim)", async () => {
    db.sessoes[SESSAO]!.archived_at = "2026-10-01T00:00:00.000Z";
    expect(await processarChunkDeHistorico(LINHA, admin)).toMatchObject({ status: "skipped", detail: "sessao_arquivada" });
    expect(inserts).toHaveLength(0);
    expect(updates.map((u) => u.tabela)).toEqual(["event_log"]);
  });

  it("conversa criada pelo histórico usa a variante que nasce encerrada (sem roteamento)", async () => {
    await processarChunkDeHistorico(LINHA, admin);
    const fns = rpcs.map((r) => r.fn);
    expect(fns).toContain("fn_upsert_wa_conversation_do_historico");
    expect(fns).not.toContain("fn_upsert_wa_conversation");
  });

  it("mensagem sem timestamp é pulada e contada em falhas (nada de 1970)", async () => {
    const r = await processarChunkDeHistorico(
      comMensagens([
        { from: "5531998966398", id: "wamid.SEMTS", type: "text", text: { body: "sem hora" } },
        { from: "5531998966398", id: "wamid.COMTS", timestamp: "1759000300", type: "text", text: { body: "com hora" } },
      ]),
      admin,
    );
    expect(inserts.map((i) => i.external_id)).toEqual(["wamid.COMTS"]);
    expect(r).toMatchObject({ status: "ok", detail: "gravadas=1 duplicadas=0 falhas=1" });
  });

  it("progresso e fase nunca regridem (chunk atrasado não puxa a barra para trás)", async () => {
    await processarChunkDeHistorico({ ...LINHA, payload: { ...LINHA.payload, fase: 1, progresso: 60 } }, admin);
    await processarChunkDeHistorico({ ...LINHA, payload: { ...LINHA.payload, fase: 0, progresso: 20 } }, admin);
    expect(db.sessoes[SESSAO]!.metadata).toMatchObject({ coexistencia: { historico: { fase: 1, progresso: 60, concluido: false } } });
  });

  it("grava só o historico sobre a metadata MAIS RECENTE: pedidos mudados durante o chunk não voltam", async () => {
    aoResolverContato = () => {
      db.sessoes[SESSAO]!.metadata = { coexistencia: { ...COEX, pedidos: { contatos: null, historico: { request_id: "novo" } } }, outra: 1 };
    };
    await processarChunkDeHistorico(LINHA, admin);
    expect(db.sessoes[SESSAO]!.metadata).toMatchObject({
      outra: 1,
      coexistencia: { pedidos: { historico: { request_id: "novo" } }, historico: { progresso: 20 } },
    });
  });

  it("erro_codigo: só o chunk COM erro o grava; chunk sem erro não o apaga; 100% sem erro o limpa", async () => {
    await processarChunkDeHistorico({ ...LINHA, payload: { ...LINHA.payload, erro_codigo: 2593109, value: { history: [] } } }, admin);
    await processarChunkDeHistorico({ ...LINHA, payload: { ...LINHA.payload, progresso: 40 } }, admin);
    expect(db.sessoes[SESSAO]!.metadata).toMatchObject({ coexistencia: { historico: { erro_codigo: 2593109, progresso: 40 } } });
    await processarChunkDeHistorico({ ...LINHA, payload: { ...LINHA.payload, progresso: 100 } }, admin);
    expect(db.sessoes[SESSAO]!.metadata).toMatchObject({ coexistencia: { historico: { erro_codigo: null, progresso: 100, concluido: true } } });
  });

  it("sessão ausente → skipped", async () => {
    expect(await processarChunkDeHistorico({ ...LINHA, entity_id: "nao-existe" }, admin)).toMatchObject({ status: "skipped", detail: "sessao_ausente" });
    expect(inserts).toHaveLength(0);
  });
});
