import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { lerBloqueiosDaGrade } from "./bloqueios-da-grade";

/** Dublê que filtra `eq`/`in`/`gte`/`lte` de verdade, sobre linhas em memória. */
function cliente(tabelas: Record<string, Array<Record<string, unknown>>>): SupabaseClient {
  return {
    from: (tabela: string) => {
      const filtros: Array<(l: Record<string, unknown>) => boolean> = [];
      const api = {
        select: () => api,
        eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), api),
        in: (c: string, v: unknown[]) => (filtros.push((l) => v.includes(l[c])), api),
        gte: (c: string, v: string) => (filtros.push((l) => String(l[c]) >= v), api),
        lte: (c: string, v: string) => (filtros.push((l) => String(l[c]) <= v), api),
        then: (r: (v: unknown) => unknown) =>
          Promise.resolve({
            data: (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l))),
            error: null,
          }).then(r),
      };
      return api;
    },
  } as unknown as SupabaseClient;
}

const ORG = "org-1";
const RECORTE = {
  organizationId: ORG,
  de: "2026-10-19T03:00:00.000Z",
  ate: "2026-10-26T03:00:00.000Z",
};
const linha = (over: Record<string, unknown>) => ({
  id: "b1",
  organization_id: ORG,
  user_id: "dra",
  exception_date: "2026-10-20",
  is_unavailable: true,
  start_minute: 840,
  end_minute: 960,
  ...over,
});

describe("lerBloqueiosDaGrade", () => {
  it("14:00 a 16:00 em São Paulo vira 17:00Z a 19:00Z, na agenda da dona", async () => {
    const { blocos } = await lerBloqueiosDaGrade(
      cliente({
        calendar_availability_exceptions: [linha({})],
        attendant_availability: [
          { organization_id: ORG, user_id: "dra", schedule: { timezone: "America/Sao_Paulo" } },
        ],
      }),
      RECORTE,
      ["dra"],
      "UTC",
    );
    expect(blocos).toEqual([
      {
        id: "bloqueio:b1",
        donoId: "dra",
        iniciaEm: "2026-10-20T17:00:00.000Z",
        terminaEm: "2026-10-20T19:00:00.000Z",
      },
    ]);
  });

  it("dia ABERTO, outra organização e quem a tela não mostra ficam de fora", async () => {
    const { blocos } = await lerBloqueiosDaGrade(
      cliente({
        calendar_availability_exceptions: [
          linha({ id: "aberto", is_unavailable: false }),
          linha({ id: "outra-org", organization_id: "org-2" }),
          linha({ id: "colega", user_id: "colega" }),
        ],
      }),
      RECORTE,
      ["dra"],
      "America/Sao_Paulo",
    );
    expect(blocos).toEqual([]);
  });

  it("o dia todo é recortado ao que a tela pede", async () => {
    const { blocos } = await lerBloqueiosDaGrade(
      cliente({
        calendar_availability_exceptions: [
          linha({ exception_date: "2026-10-19", start_minute: 0, end_minute: 1440 }),
        ],
      }),
      { ...RECORTE, de: "2026-10-19T12:00:00.000Z" },
      ["dra"],
      "America/Sao_Paulo",
    );
    expect(blocos[0]).toMatchObject({
      iniciaEm: "2026-10-19T12:00:00.000Z",
      terminaEm: "2026-10-20T03:00:00.000Z",
    });
  });
});
