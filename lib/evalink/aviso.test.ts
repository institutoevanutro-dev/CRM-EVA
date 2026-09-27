import { describe, expect, it } from "vitest";
import { cabecalhoDeAviso, conferirAviso } from "./aviso";

const S = "s".repeat(32), corpo = '{"sub":"x"}', agora = 1_800_000_000_000;

describe("conferirAviso", () => {
  it("aceita o que a Conta assina", () => {
    expect(conferirAviso(S, corpo, cabecalhoDeAviso(S, corpo, "id-1", agora), agora)).toMatchObject({ ok: true, id: "id-1" });
  });
  it("recusa segredo errado, corpo trocado, sem cabeçalho e fora da janela", () => {
    const h = cabecalhoDeAviso(S, corpo, "id-1", agora);
    expect(conferirAviso("t".repeat(32), corpo, h, agora).ok).toBe(false);
    expect(conferirAviso(S, '{"sub":"y"}', h, agora).ok).toBe(false);
    expect(conferirAviso(S, corpo, null, agora).ok).toBe(false);
    expect(conferirAviso(S, corpo, h, agora + 301_000).ok).toBe(false);
    expect(conferirAviso(S, corpo, "t=1,id=x,v1=zz", agora).ok).toBe(false);
  });
});
