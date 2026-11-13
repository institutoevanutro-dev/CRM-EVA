import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * Migration 0411: `calendar_event_types.requires_patient` existe, é NOT NULL e
 * nasce true; o tipo semeado "Reunião" (reunião interna) nasce sem exigir.
 */
const ORG = "5eed0000-0000-4000-8000-0000000000b1";

describe("calendar_event_types.requires_patient (0411)", () => {
  it("boolean not null default true", () => {
    const r = sql(`select data_type || '|' || is_nullable || '|' || column_default
      from information_schema.columns
      where table_schema='public' and table_name='calendar_event_types'
        and column_name='requires_patient';`).trim();
    expect(r).toBe("boolean|NO|true");
  });

  it("organização nova: Consulta e Atendimento exigem paciente, Reunião não", () => {
    sql(`insert into public.organizations (id, slug, legal_name, display_name)
         values ('${ORG}', 'exige-paciente', 'Exige Paciente', 'Exige Paciente')
         on conflict (id) do nothing;`);
    const r = sql(`select string_agg(slug || '=' || requires_patient, ',' order by position)
      from public.calendar_event_types where organization_id = '${ORG}';`).trim();
    expect(r).toBe("consulta=true,reuniao=false,atendimento=true");
  });
});
