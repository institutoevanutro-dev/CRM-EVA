import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { triggerConfigSchema } from "@/lib/followup/api-schemas";
import {
  PROVIDERS_DO_CANAL_FIXADO,
  conferirCanalDoGatilho,
  type LeitorDeCanal,
} from "@/lib/followup/canal-do-gatilho";
import { PROVIDERS_DE_MENSAGEM, canalDeEnvioAutomatico } from "@/lib/channels/capabilities";

/**
 * Canal fixado no gatilho de consulta (migration 0377). O banco volta ao canal
 * da consulta quando o fixado não vale; a API recusa antes, com a pessoa na tela.
 */
const CANAL = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const ORG = "0a0a0a0a-0b0b-4c0c-8d0d-0e0e0e0e0e0e";

describe("schema: params.channel_session_id", () => {
  it.each(["appointment_attended", "appointment_no_show"])("%s aceita uuid e aceita ausência", (kind) => {
    expect(triggerConfigSchema.safeParse({ kind, params: { channel_session_id: CANAL } }).success).toBe(true);
    expect(triggerConfigSchema.safeParse({ kind, params: { event_type_ids: [] } }).success).toBe(true);
  });

  it.each(["appointment_attended", "appointment_no_show"])("%s recusa o que não é uuid", (kind) => {
    expect(triggerConfigSchema.safeParse({ kind, params: { channel_session_id: "numero-do-medico" } }).success).toBe(false);
  });

  it("gatilho que não é de consulta não ganha o campo (strict)", () => {
    expect(
      triggerConfigSchema.safeParse({ kind: "stage_change", params: { stage_id: CANAL, channel_session_id: CANAL } }).success,
    ).toBe(false);
  });
});

function leitor(linha: { provider: string | null; archived_at: string | null } | null): LeitorDeCanal & { chamadas: string[][] } {
  const chamadas: string[][] = [];
  const f = (async (org: string, id: string) => {
    chamadas.push([org, id]);
    return { data: linha, error: null };
  }) as LeitorDeCanal & { chamadas: string[][] };
  f.chamadas = chamadas;
  return f;
}

describe("conferirCanalDoGatilho (PATCH e publicação)", () => {
  const cfg = { kind: "appointment_attended", params: { channel_session_id: CANAL } };

  it("sem canal fixado não consulta nada e não recusa", async () => {
    const l = leitor(null);
    expect(await conferirCanalDoGatilho(l, ORG, { kind: "appointment_attended" })).toBeNull();
    expect(await conferirCanalDoGatilho(l, ORG, { kind: "manual" })).toBeNull();
    expect(l.chamadas).toHaveLength(0);
  });

  it("pergunta pelo canal NA organização ativa", async () => {
    const l = leitor({ provider: "waha", archived_at: null });
    expect(await conferirCanalDoGatilho(l, ORG, cfg)).toBeNull();
    expect(l.chamadas).toEqual([[ORG, CANAL]]);
  });

  it("canal de outra organização (não achado) é recusado", async () => {
    expect(await conferirCanalDoGatilho(leitor(null), ORG, cfg)).toMatchObject({ code: "trigger_channel_not_found", status: 422 });
  });

  it("canal arquivado é recusado", async () => {
    expect(await conferirCanalDoGatilho(leitor({ provider: "waha", archived_at: "2026-10-01T00:00:00Z" }), ORG, cfg)).toMatchObject({
      code: "trigger_channel_archived",
      status: 422,
    });
  });

  it.each(["meta_instagram", "wacalls"])("canal %s é recusado", async (provider) => {
    expect(await conferirCanalDoGatilho(leitor({ provider, archived_at: null }), ORG, cfg)).toMatchObject({
      code: "trigger_channel_unsupported",
    });
  });
});

describe("a regra é a mesma na tela, na API e no banco", () => {
  it("providers aceitos = os que a tela oferece (canaisQueEnviam)", () => {
    const daTela = PROVIDERS_DE_MENSAGEM.filter((p) => canalDeEnvioAutomatico(p));
    expect([...PROVIDERS_DO_CANAL_FIXADO].sort()).toEqual([...daTela].sort());
  });

  it("providers aceitos = o `s.provider in (...)` da migration 0377", () => {
    const dir = join(process.cwd(), "supabase", "migrations");
    const arquivo = readdirSync(dir).find((f) => f.includes("_0377_"));
    expect(arquivo).toBeDefined();
    const sql = readFileSync(join(dir, arquivo!), "utf8");
    const lista = /s\.provider in \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    expect(lista.split(",").map((s) => s.trim().replace(/'/g, "")).sort()).toEqual([...PROVIDERS_DO_CANAL_FIXADO].sort());
  });
});
