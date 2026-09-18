/**
 * Prova, contra Postgres real, o UPDATE que grava o horário comercial da
 * clínica em `organizations.settings.followups.bloqueios.janela` (o schema
 * REALMENTE consumido por `lerConfigDosBloqueios`/`dentroDaJanela` em
 * lib/followup/bloqueios-obrigatorios.ts — não `horario_comercial`, chave que
 * uma versão anterior desta tarefa propôs por engano e que o executor nunca lê).
 *
 * O UPDATE usa `jsonb_set` de UM nível por vez, com `coalesce(...) || jsonb_build_object(...)`
 * em cada nível — nunca um `jsonb_set` de caminho multi-nível, que faz nada em
 * silêncio quando um objeto intermediário (`settings.followups` ou
 * `settings.followups.bloqueios`) ainda não existe. Este teste prova os três
 * casos: settings vazio, settings.followups sem bloqueios, e bloqueios com
 * outras flags já configuradas (que devem sobreviver ao update).
 */
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { dentroDaJanela, lerConfigDosBloqueios } from "@/lib/followup/bloqueios-obrigatorios";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

afterAll(async () => {
  await pool.end();
});

let seq = 0;
function idDeTeste(): string {
  seq += 1;
  const s = seq.toString(16).padStart(4, "0");
  return `abcd0000-0000-4000-8000-${s}00000001`;
}

const SQL_ATUALIZA_HORARIO_COMERCIAL = `
  update organizations
  set settings = jsonb_set(
    coalesce(settings, '{}'::jsonb),
    '{followups}',
    coalesce(settings->'followups', '{}'::jsonb) || jsonb_build_object(
      'bloqueios',
      coalesce(settings->'followups'->'bloqueios', '{}'::jsonb) || jsonb_build_object(
        'janela', jsonb_build_object(
          'timezone', 'America/Sao_Paulo',
          'dias', jsonb_build_array(1, 2, 3, 4, 5),
          'intervalos', jsonb_build_array(
            jsonb_build_object('inicio', '09:00', 'fim', '12:00'),
            jsonb_build_object('inicio', '14:00', 'fim', '19:00')
          )
        )
      )
    ),
    true
  )
  where id = $1
  returning settings;
`;

async function seedOrg(org: string, settings: unknown): Promise<void> {
  const name = `clinica-${org.slice(0, 8)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1, $2, $3, $4, $5) on conflict (id) do update set settings = excluded.settings`,
    [org, name, name, name, settings ? JSON.stringify(settings) : null],
  );
}

async function aplicarUpdate(org: string): Promise<unknown> {
  const { rows } = await pool.query<{ settings: unknown }>(SQL_ATUALIZA_HORARIO_COMERCIAL, [org]);
  return rows[0]!.settings;
}

// Segunda-feira real usada nas asserções: 2026-09-21. 2026-09-19 é sábado, 2026-09-20 é domingo.
function horaEm(diaISO: string, hhmm: string): Date {
  const [h = Number.NaN, m = Number.NaN] = hhmm.split(":").map(Number);
  return new Date(`${diaISO}T${String(h + 3).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`);
}

describe("SQL do horário comercial da clínica: jsonb_set de 1 nível + coalesce, contra Postgres real", () => {
  it("settings NULL (organização nunca configurou nada): grava e o executor lê seg-sex 09-12/14-19", async () => {
    const org = idDeTeste();
    await seedOrg(org, null);

    const settings = await aplicarUpdate(org);
    const config = lerConfigDosBloqueios(settings);
    expect(config).not.toBeNull();
    expect(config!.janela).not.toBeNull();

    expect(dentroDaJanela(config!.janela!, horaEm("2026-09-21", "10:00"))).toBe(true); // seg manhã
    expect(dentroDaJanela(config!.janela!, horaEm("2026-09-21", "15:00"))).toBe(true); // seg tarde
    expect(dentroDaJanela(config!.janela!, horaEm("2026-09-21", "13:00"))).toBe(false); // almoço
    expect(dentroDaJanela(config!.janela!, horaEm("2026-09-21", "12:00"))).toBe(false); // fim exclusivo
    expect(dentroDaJanela(config!.janela!, horaEm("2026-09-21", "19:00"))).toBe(false); // fim exclusivo
    expect(dentroDaJanela(config!.janela!, horaEm("2026-09-19", "10:00"))).toBe(false); // sábado
    expect(dentroDaJanela(config!.janela!, horaEm("2026-09-20", "10:00"))).toBe(false); // domingo
  });

  it("settings.followups existe mas SEM bloqueios: o jsonb_set de 1 nível não perde o vizinho, e não faz no-op", async () => {
    const org = idDeTeste();
    await seedOrg(org, { followups: { algum_outro_campo: "x" } });

    const settings = await aplicarUpdate(org);
    expect((settings as { followups: { algum_outro_campo: string } }).followups.algum_outro_campo).toBe("x"); // preservado
    const config = lerConfigDosBloqueios(settings);
    expect(config).not.toBeNull();
    expect(dentroDaJanela(config!.janela!, horaEm("2026-09-21", "15:00"))).toBe(true);
  });

  it("bloqueios com outras flags já configuradas: sobrevivem ao update (não é um replace do objeto inteiro)", async () => {
    const org = idDeTeste();
    await seedOrg(org, {
      followups: { bloqueios: { uma_sequencia_por_contato: true, exigir_etapa_do_gatilho: true } },
      branding: { accent_hex: "#123456" },
    });

    const settings = await aplicarUpdate(org);
    const config = lerConfigDosBloqueios(settings);
    expect(config).not.toBeNull();
    expect(config!.uma_sequencia_por_contato).toBe(true);
    expect(config!.exigir_etapa_do_gatilho).toBe(true);
    expect((settings as { branding: { accent_hex: string } }).branding.accent_hex).toBe("#123456"); // fora de followups, intocado
    expect(dentroDaJanela(config!.janela!, horaEm("2026-09-21", "10:00"))).toBe(true);
  });
});
