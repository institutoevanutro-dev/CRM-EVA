// @vitest-environment node
import { describe, expect, it } from "vitest";

import { conferirDestino } from "./destino-informado";

const API = "https://abcdefgh.supabase.co";
const POOLER = "postgresql://postgres.abcdefgh:senha@aws-0-sa-east-1.pooler.supabase.com:5432/postgres";

describe("conferirDestino", () => {
  it("aceita o host informado com o Postgres do mesmo projeto (pooler ou direto)", () => {
    expect(conferirDestino(API, POOLER, "abcdefgh.supabase.co")).toEqual({ ok: true });
    expect(conferirDestino(API, "postgresql://postgres:s@db.abcdefgh.supabase.co:5432/postgres", "ABCDEFGH.supabase.co")).toEqual({ ok: true });
    expect(conferirDestino("http://127.0.0.1:54321", "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "127.0.0.1")).toEqual({ ok: true });
  });

  it.each([
    ["sem --destino", API, POOLER, undefined],
    ["outro host", API, POOLER, "outro.supabase.co"],
    ["sem SUPABASE_DB_URL", API, "", "abcdefgh.supabase.co"],
    ["misto: API remota, banco local", API, "postgresql://postgres:postgres@127.0.0.1:54322/postgres", "abcdefgh.supabase.co"],
    ["banco de outro projeto", API, "postgresql://postgres.zzzzzzzz:s@aws-0-sa-east-1.pooler.supabase.com:5432/postgres", "abcdefgh.supabase.co"],
  ])("recusa: %s", (_caso, api, db, informado) => {
    const r = conferirDestino(api, db, informado);
    expect(r.ok).toBe(false);
  });
});
