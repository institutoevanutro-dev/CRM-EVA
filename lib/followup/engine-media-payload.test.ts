import { describe, expect, it } from "vitest";

import { turnPayloadExtras } from "./engine";
import { resumoDoNo } from "./eventos-legiveis";
import type { FlowNode } from "./graph-schema";

const id = "123e4567-e89b-42d3-a456-426614174000";
const no = (caption?: string): FlowNode => ({
  id: "a1",
  type: "action",
  label: "Foto",
  position: { x: 0, y: 0 },
  config: { mode: "media", media_id: id, ...(caption ? { caption } : {}) },
});

describe("modo media", () => {
  it("payload leva media_id/media_caption, sem fixed_body nem prompt_hint", () => {
    const out = turnPayloadExtras(no("Volta {{volta}}"), [], []);
    expect(out).toEqual({ media_id: id, media_caption: "Volta {{volta}}" });
    expect(out).not.toHaveProperty("fixed_body");
    expect(out).not.toHaveProperty("prompt_hint");
  });
  it("sem legenda, sem media_caption", () => {
    expect(turnPayloadExtras(no(), [], [])).toEqual({ media_id: id });
  });
  it("resumo não fala de modelo nem de agente", () => {
    const r = resumoDoNo(no()).resumo;
    expect(r).toBe("envia uma imagem ou vídeo da biblioteca");
    expect(r).not.toMatch(/modelo|agente/);
  });
});
