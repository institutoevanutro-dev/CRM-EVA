/**
 * Extração silenciosa de cadastro (migration 0407), contra o Postgres efêmero
 * de `scripts/test-db.sh` com o `baseline.sql` aplicado — o que o kit
 * self-host instala.
 *
 *  - o CHECK de `contact_field_proposals.campo` aceita `cpf` e `endereco` e
 *    segue recusando campo livre;
 *  - CPF nunca entra em claro na fila: proposta de CPF exige `valor_cifrado`,
 *    recusa valor anterior e recusa `valor_proposto` com mais de 2 dígitos;
 *    outro campo não pode carregar `valor_cifrado`;
 *  - o CHECK de `agent_inbox_items.kind` aceita `contact_data_divergent`, e o
 *    aviso é isolado entre 2 organizações.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql } from "./gov-helpers";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const MEMBRO_A = randomUUID();
const MEMBRO_B = randomUUID();
const CONTATO = randomUUID();

function proposta(campo: string, valor: string, extra = "null::bytea", anterior = "null"): string {
  return `insert into contact_field_proposals
            (organization_id, contact_id, campo, valor_proposto, valor_anterior, valor_cifrado, expires_at)
          values ('${ORG_A}', '${CONTATO}', '${campo}', '${valor}', ${anterior}, ${extra}, now() + interval '7 days');`;
}

function falha(script: string): string | null {
  try {
    sql(`begin; ${script} rollback;`);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

beforeAll(() => {
  sql(`insert into auth.users (id, email) values
         ('${MEMBRO_A}', 'extracao-a@invariant.test'), ('${MEMBRO_B}', 'extracao-b@invariant.test');
       insert into organizations (id, slug, legal_name, display_name) values
         ('${ORG_A}', 'extracao-${ORG_A}', 'A', 'A'), ('${ORG_B}', 'extracao-${ORG_B}', 'B', 'B');
       insert into user_organizations (user_id, organization_id, role, accepted_at) values
         ('${MEMBRO_A}', '${ORG_A}', 'admin', now()), ('${MEMBRO_B}', '${ORG_B}', 'admin', now());
       insert into contacts (id, organization_id, display_name, source)
         values ('${CONTATO}', '${ORG_A}', 'Paciente Fictícia', 'whatsapp');`);
});

afterAll(() => {
  sql(`delete from organizations where id in ('${ORG_A}', '${ORG_B}');
       delete from auth.users where id in ('${MEMBRO_A}', '${MEMBRO_B}');`);
});

describe("contact_field_proposals depois da 0407", () => {
  it("aceita endereço como texto e segue recusando campo fora do vocabulário", () => {
    expect(falha(proposta("endereco", "Rua das Flores, 100, Vitória"))).toBeNull();
    expect(falha(proposta("custom_fields", "qualquer coisa"))).toMatch(/contact_field_proposals_campo_check/);
  });

  it("aceita CPF só cifrado e mascarado", () => {
    expect(falha(proposta("cpf", "•••.•••.•••-09", "'\\x01'::bytea"))).toBeNull();
  });

  it("recusa CPF em claro, sem cifra ou com valor anterior", () => {
    expect(falha(proposta("cpf", "529.982.247-25", "'\\x01'::bytea"))).toMatch(/contact_field_proposals_cpf_cifrado/);
    expect(falha(proposta("cpf", "•••.•••.•••-25"))).toMatch(/contact_field_proposals_cpf_cifrado/);
    expect(falha(proposta("cpf", "•••.•••.•••-25", "'\\x01'::bytea", "'•••.•••.•••-11'"))).toMatch(
      /contact_field_proposals_cpf_cifrado/,
    );
  });

  it("outro campo não carrega valor cifrado", () => {
    expect(falha(proposta("email", "pessoa@exemplo.test", "'\\x01'::bytea"))).toMatch(
      /contact_field_proposals_cpf_cifrado/,
    );
  });
});

describe("aviso contact_data_divergent", () => {
  it("o CHECK aceita o kind e o aviso é isolado entre organizações", () => {
    const aviso = lastLine(
      sql(`with novo as (
             insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
             values ('${ORG_A}', 'contact_data_divergent', 'info', 'Dado diferente do cadastro',
                     'Confira a sugestão na ficha.', 'contact', '${CONTATO}')
             returning id
           )
           select id from novo;`),
    );
    expect(aviso).toMatch(/^[0-9a-f-]{36}$/);
    const q = `select count(*) from agent_inbox_items where id = '${aviso}';`;
    expect(countAs(MEMBRO_A, q)).toBe(1);
    expect(countAs(MEMBRO_B, q)).toBe(0);
  });
});
