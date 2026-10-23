import { describe, expect, it } from "vitest";

import { lerCanalDoLembrete, settingsComCanalDoLembrete } from "./canal-do-lembrete";

const CANAL = "44444444-4444-4444-8444-444444444444";

describe("lerCanalDoLembrete — nunca lança; torto = automático", () => {
  it("lê o uuid gravado", () => {
    expect(lerCanalDoLembrete({ agenda_lembrete: { channel_session_id: CANAL } })).toBe(CANAL);
  });

  it.each([
    ["settings nulo", null],
    ["settings indefinido", undefined],
    ["settings string", "x"],
    ["sem a chave", { agenda: { confirmation_delay_minutes: 10 } }],
    ["nulo explícito", { agenda_lembrete: { channel_session_id: null } }],
    ["não é uuid", { agenda_lembrete: { channel_session_id: "zap-1" } }],
    ["número", { agenda_lembrete: { channel_session_id: 42 } }],
    ["objeto torto", { agenda_lembrete: "x" }],
  ])("%s → null", (_nome, settings) => {
    expect(lerCanalDoLembrete(settings)).toBeNull();
  });
});

describe("settingsComCanalDoLembrete — troca só a chave", () => {
  it("preserva o resto do jsonb, inclusive os prazos de `agenda`", () => {
    const antes = {
      routing: { mode: "manual" },
      agenda: { confirmation_delay_minutes: 10, unknown_protection_minutes: 1440 },
      agenda_lembrete: { outra: 1 },
    };
    expect(settingsComCanalDoLembrete(antes, CANAL)).toEqual({
      routing: { mode: "manual" },
      agenda: { confirmation_delay_minutes: 10, unknown_protection_minutes: 1440 },
      agenda_lembrete: { outra: 1, channel_session_id: CANAL },
    });
  });

  it("null volta ao automático", () => {
    const s = settingsComCanalDoLembrete({ agenda_lembrete: { channel_session_id: CANAL } }, null);
    expect(lerCanalDoLembrete(s)).toBeNull();
  });

  it("settings que não é objeto não vira chaves numéricas", () => {
    expect(settingsComCanalDoLembrete("abc", CANAL)).toEqual({ agenda_lembrete: { channel_session_id: CANAL } });
  });
});
