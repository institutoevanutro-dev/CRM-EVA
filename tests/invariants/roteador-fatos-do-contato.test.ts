import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAXIMO_DE_ANTERIORES,
  buildFatosDoContato,
  fatosDoContato,
} from "@/lib/agent-engine/agent/fatos-do-contato";

import { GOV_ORG, seedGov } from "./gov-helpers";

/**
 * OS FATOS DA AGENDA QUE O CLASSIFICADOR DO ROTEADOR RECEBE, LIDOS DO BANCO.
 *
 * O teste unitário prova o TEXTO. Este prova a LEITURA, que é onde mora o que
 * custa caro: cancelado e falta virando "já é paciente", o título servindo de
 * tipo quando não há tipo, o teto, e uma organização lendo a agenda da outra.
 *
 * `agora` é fixo, em 2030: nada aqui depende do dia em que a suíte roda.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = GOV_ORG;
const OUTRA_ORG = randomUUID();
const AGORA = new Date("2030-07-01T15:00:00Z");

const MISTO = randomUUID();
const SO_DESMARCOU = randomUUID();
const SEM_TIPO = randomUUID();
const MUITOS = randomUUID();
const DA_OUTRA = randomUUID();

const TIPO = "Primeira consulta — Dr. André";
let tipoId: string;

async function contato(id: string, org = ORG) {
  await q(`insert into contacts(id,organization_id,display_name) values($1,$2,'Contato Fictício')`, [id, org]);
}

/** Um compromisso de meia hora começando em `inicio`. */
async function compromisso(
  contactId: string,
  inicio: string,
  status: string,
  opts: { org?: string; tipo?: string | null; titulo?: string } = {},
) {
  await q(
    `insert into calendar_appointments
       (organization_id, contact_id, event_type_id, title, starts_at, ends_at, time_zone, status, cancelled_at)
     values ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '30 minutes', 'America/Sao_Paulo', $6,
             case when $6 = 'cancelled' then now() end)`,
    [opts.org ?? ORG, contactId, opts.tipo ?? null, opts.titulo ?? "Compromisso", inicio, status],
  );
}

beforeAll(async () => {
  seedGov();
  await q(
    `insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Outra Org','Outra Org')`,
    [OUTRA_ORG],
  );
  const { rows } = await q(
    `insert into calendar_event_types(organization_id,name,slug) values($1,$2,'primeira-consulta') returning id`,
    [ORG, TIPO],
  );
  tipoId = rows[0].id;

  await contato(MISTO);
  await compromisso(MISTO, "2030-06-10T17:00:00Z", "completed", { tipo: tipoId, titulo: "Título que o tipo vence" });
  await compromisso(MISTO, "2030-06-11T17:00:00Z", "cancelled");
  await compromisso(MISTO, "2030-06-12T17:00:00Z", "no_show");
  await compromisso(MISTO, "2030-07-10T17:00:00Z", "confirmed", { titulo: "Drenagem linfática" });
  await compromisso(MISTO, "2030-07-11T17:00:00Z", "cancelled");

  await contato(SO_DESMARCOU);
  await compromisso(SO_DESMARCOU, "2030-06-11T17:00:00Z", "cancelled");
  await compromisso(SO_DESMARCOU, "2030-06-12T17:00:00Z", "no_show");
  await compromisso(SO_DESMARCOU, "2030-07-11T17:00:00Z", "cancelled");

  await contato(SEM_TIPO);
  await compromisso(SEM_TIPO, "2030-06-10T17:00:00Z", "completed", { titulo: "Avaliação corporal" });

  await contato(MUITOS);
  for (let dia = 1; dia <= 7; dia++) {
    await compromisso(MUITOS, `2030-06-0${dia}T17:00:00Z`, "completed", { titulo: `Retorno ${dia}` });
  }

  // A outra organização tem agenda própria: o vazio do caso de isolamento não
  // pode vir de uma organização sem compromisso nenhum.
  await contato(DA_OUTRA, OUTRA_ORG);
  await compromisso(DA_OUTRA, "2030-06-10T17:00:00Z", "completed", { org: OUTRA_ORG });
});

describe("roteador: os fatos da agenda do contato", () => {
  it("conta só o que aconteceu e o que está de pé: 1 anterior (com o nome do tipo) e 1 futuro", async () => {
    const fatos = await fatosDoContato(pool, ORG, MISTO, AGORA);
    expect(fatos.anteriores.map((f) => [f.tipo, f.status])).toEqual([[TIPO, "completed"]]);
    expect(fatos.futuros.map((f) => [f.tipo, f.status])).toEqual([["Drenagem linfática", "confirmed"]]);
  });

  it("⭐ quem só cancelou ou faltou NÃO vira 'já é paciente'", async () => {
    expect(await buildFatosDoContato(pool, ORG, SO_DESMARCOU, AGORA)).toBe(
      "Fatos do CRM sobre este contato (agenda):\n- Sem atendimentos registrados na agenda.",
    );
  });

  it("sem tipo de atendimento, o tipo é o título do compromisso", async () => {
    const fatos = await fatosDoContato(pool, ORG, SEM_TIPO, AGORA);
    expect(fatos.anteriores.map((f) => f.tipo)).toEqual(["Avaliação corporal"]);
  });

  it("⭐ isolamento: o mesmo contato, perguntado pela outra organização, não tem fato nenhum", async () => {
    // Controle positivo: os dois lados têm o que ler quando a organização é a certa.
    expect((await fatosDoContato(pool, ORG, MISTO, AGORA)).anteriores).toHaveLength(1);
    expect((await fatosDoContato(pool, OUTRA_ORG, DA_OUTRA, AGORA)).anteriores).toHaveLength(1);

    expect(await fatosDoContato(pool, OUTRA_ORG, MISTO, AGORA)).toEqual({ anteriores: [], futuros: [] });
    expect(await fatosDoContato(pool, ORG, DA_OUTRA, AGORA)).toEqual({ anteriores: [], futuros: [] });
  });

  it("7 atendimentos passados: vêm teto + 1, o mais recente primeiro", async () => {
    const { anteriores } = await fatosDoContato(pool, ORG, MUITOS, AGORA);
    expect(anteriores).toHaveLength(MAXIMO_DE_ANTERIORES + 1);
    expect(anteriores.map((f) => f.tipo)).toEqual([
      "Retorno 7", "Retorno 6", "Retorno 5", "Retorno 4", "Retorno 3", "Retorno 2",
    ]);
  });
});
