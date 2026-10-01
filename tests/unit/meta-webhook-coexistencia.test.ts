import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMetaWebhook } from "@/lib/channels/meta/webhook";

const F = JSON.parse(readFileSync("tests/fixtures/meta/coexistencia-webhooks.json", "utf8")) as Parameters<typeof parseMetaWebhook>[0][];

describe("coexistência — parser", () => {
  it("smb_message_echoes vira echo_message com o DESTINATÁRIO como contato", () => {
    expect(parseMetaWebhook(F[0]!)[0]).toMatchObject({ kind: "echo_message", phoneNumberId: "111", externalId: "wamid.ECO1", to: "5531998966398", type: "text", text: "respondi pelo celular" });
  });
  it("history vira UM history_chunk com fase/progresso e o value cru", () => {
    const [e] = parseMetaWebhook(F[1]!);
    expect(e).toMatchObject({ kind: "history_chunk", fase: 0, progresso: 20, chunkOrder: 1, erroCodigo: null });
    expect((e as unknown as { bruto: { history: unknown[] } }).bruto.history).toHaveLength(1);
  });
  it("history com erro 2593109 carrega o código", () => {
    expect(parseMetaWebhook(F[2]!)[0]).toMatchObject({ kind: "history_chunk", erroCodigo: 2593109 });
  });
  it("smb_app_state_sync vira contatos com wa_id só dígitos e nome", () => {
    expect(parseMetaWebhook(F[3]!)[0]).toMatchObject({ kind: "state_sync", contatos: [{ waId: "5531998966398", nome: "Maria Silva" }] });
  });
  it("account_update PARTNER_REMOVED traz o motivo; ACCOUNT_RECONNECTED não", () => {
    expect(parseMetaWebhook(F[4]!)[0]).toMatchObject({ kind: "account_event", evento: "PARTNER_REMOVED", motivo: "USER_INITIATED_DISCONNECT", phoneNumber: "+5527999049879" });
    expect(parseMetaWebhook(F[5]!)[0]).toMatchObject({ kind: "account_event", evento: "ACCOUNT_RECONNECTED", motivo: null });
  });
  it("account_offboarded e account_reconnected como CAMPOS viram o mesmo account_event", () => {
    expect(parseMetaWebhook(F[6]!)[0]).toMatchObject({ kind: "account_event", evento: "ACCOUNT_OFFBOARDED", motivo: "BUSINESS_INITIATED_OFFBOARDING", phoneNumber: "+5527999049879" });
    expect(parseMetaWebhook(F[7]!)[0]).toMatchObject({ kind: "account_event", evento: "ACCOUNT_RECONNECTED", motivo: null, phoneNumber: "+5527999049879" });
  });
  it("tipo exótico no eco é preservado cru no evento (quem mapeia para o CHECK é tipoDoCrm, no ingest)", () => {
    const eco = structuredClone(F[0]!) as { entry: Array<{ changes: Array<{ value: { message_echoes: Array<{ type: string }> } }> }> };
    eco.entry[0]!.changes[0]!.value.message_echoes[0]!.type = "interactive";
    expect(parseMetaWebhook(eco as never)[0]).toMatchObject({ kind: "echo_message", type: "interactive", text: null });
  });
});
