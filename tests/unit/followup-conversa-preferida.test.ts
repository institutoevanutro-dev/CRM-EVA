import { describe, expect, it } from "vitest";
import { sessaoPreferidaParaFollowup, type ConversaCandidata } from "@/lib/followup/conversa-do-followup";

const conv = (channel: string, sess: string, lastMsg: string, is_group = false): ConversaCandidata =>
  ({ channel, channel_session_id: sess, is_group, last_message_at: lastMsg, created_at: "2026-09-01T00:00:00Z" });

describe("sessaoPreferidaParaFollowup", () => {
  it("prefere WhatsApp mesmo com Instagram mais recente", () => {
    expect(sessaoPreferidaParaFollowup([conv("instagram", "ig", "2026-09-26T10:00:00Z"), conv("whatsapp", "wa", "2026-09-20T10:00:00Z")])).toBe("wa");
  });
  it("entre dois WhatsApp, o mais recente", () => {
    expect(sessaoPreferidaParaFollowup([conv("whatsapp", "wa1", "2026-09-10T00:00:00Z"), conv("whatsapp", "wa2", "2026-09-20T00:00:00Z")])).toBe("wa2");
  });
  it("sem WhatsApp, Instagram", () => {
    expect(sessaoPreferidaParaFollowup([conv("instagram", "ig", "2026-09-26T10:00:00Z")])).toBe("ig");
  });
  it("grupo de WhatsApp não conta", () => {
    expect(sessaoPreferidaParaFollowup([conv("whatsapp", "grupo", "2026-09-26T00:00:00Z", true), conv("instagram", "ig", "2026-09-20T00:00:00Z")])).toBe("ig");
  });
  it("sem conversa, undefined", () => {
    expect(sessaoPreferidaParaFollowup([])).toBeUndefined();
  });
  it("last_message_at nulo fica atrás de uma conversa do MESMO canal com last_message_at real, mesmo criada antes", () => {
    const semUltimaMensagem: ConversaCandidata = {
      channel: "whatsapp",
      channel_session_id: "wa-sem-msg",
      is_group: false,
      last_message_at: null,
      created_at: "2026-09-26T00:00:00Z",
    };
    const comUltimaMensagem: ConversaCandidata = {
      channel: "whatsapp",
      channel_session_id: "wa-com-msg",
      is_group: false,
      last_message_at: "2026-09-10T00:00:00Z",
      created_at: "2026-09-01T00:00:00Z",
    };
    expect(sessaoPreferidaParaFollowup([semUltimaMensagem, comUltimaMensagem])).toBe("wa-com-msg");
  });
});
