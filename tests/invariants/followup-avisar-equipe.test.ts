/**
 * O aviso da caixa "Avisar a equipe" do follow-up (`followup_notify_team`,
 * migration 0406), contra o Postgres efêmero de `scripts/test-db.sh` com o
 * `baseline.sql` aplicado — o que o kit self-host instala.
 *
 *  - o CHECK de `agent_inbox_items.kind` aceita o kind novo;
 *  - o aviso anuncia `central.aviso_criado` na organização dele (é o que leva
 *    o push ao celular);
 *  - isolamento entre 2 organizações: o membro de B não vê o aviso de A.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql } from "./gov-helpers";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const MEMBRO_A = randomUUID();
const MEMBRO_B = randomUUID();
let aviso = "";

beforeAll(() => {
  sql(`insert into auth.users (id, email) values
         ('${MEMBRO_A}', 'aviso-equipe-a@invariant.test'), ('${MEMBRO_B}', 'aviso-equipe-b@invariant.test');
       insert into organizations (id, slug, legal_name, display_name) values
         ('${ORG_A}', 'aviso-equipe-${ORG_A}', 'A', 'A'), ('${ORG_B}', 'aviso-equipe-${ORG_B}', 'B', 'B');
       insert into user_organizations (user_id, organization_id, role, accepted_at) values
         ('${MEMBRO_A}', '${ORG_A}', 'admin', now()), ('${MEMBRO_B}', '${ORG_B}', 'admin', now());`);
  aviso = lastLine(
    sql(`with novo as (
           insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
           values ('${ORG_A}', 'followup_notify_team', 'warn', 'Paciente não respondeu ao pós-consulta do dia 15',
                   'Passo de um fluxo de follow-up.', 'conversation', gen_random_uuid())
           returning id
         )
         select id from novo;`),
  );
});

afterAll(() => {
  sql(`delete from organizations where id in ('${ORG_A}', '${ORG_B}');
       delete from auth.users where id in ('${MEMBRO_A}', '${MEMBRO_B}');`);
});

describe("aviso da caixa «Avisar a equipe»", () => {
  it("o CHECK aceita followup_notify_team e o aviso anuncia no barramento da organização", () => {
    expect(aviso).toMatch(/^[0-9a-f-]{36}$/);
    const evento = lastLine(
      sql(`select count(*)::text || '|' || coalesce(max(payload->>'kind'), '')
             from event_log
            where organization_id = '${ORG_A}' and event_type = 'central.aviso_criado' and entity_id = '${aviso}';`),
    );
    expect(evento).toBe("1|followup_notify_team");
  });

  it("isolamento: o membro de A vê o aviso, o membro de B não", () => {
    const q = `select count(*) from agent_inbox_items where id = '${aviso}';`;
    expect(countAs(MEMBRO_A, q)).toBe(1);
    expect(countAs(MEMBRO_B, q)).toBe(0);
  });
});
