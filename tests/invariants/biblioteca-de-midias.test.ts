// tests/invariants/biblioteca-de-midias.test.ts
import { describe, expect, it } from "vitest";

import { countAs, lastLine, sql, writeCountAs } from "./gov-helpers";

/**
 * O que a migration 0326 promete no banco que o clone recebe:
 *  1. media_library_items com RLS e a restritiva mfa_provada.
 *  2. Escrita de gestor; atendente lê e não escreve.
 *  3. Isolamento entre duas organizações, inclusive o lado `with check`.
 *  4. Bucket media-library privado, 50 MB, só imagem e vídeo, sem policy.
 */
const ORG_A = "0326aaaa-0000-4000-8000-000000000001";
const ORG_B = "0326bbbb-0000-4000-8000-000000000002";
const GESTOR_A = "0326aaaa-1111-4000-8000-000000000001";
const ATENDENTE_A = "0326aaaa-2222-4000-8000-000000000001";
const GESTOR_B = "0326bbbb-1111-4000-8000-000000000002";
const ITEM_A = "0326aaaa-3333-4000-8000-000000000001";

function seed(): void {
  sql(`
    insert into auth.users (id, email) values
      ('${GESTOR_A}', 'midia-gestor-a@invariant.test'),
      ('${ATENDENTE_A}', 'midia-atendente-a@invariant.test'),
      ('${GESTOR_B}', 'midia-gestor-b@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'midia-inv-a', 'Midia Inv A', 'Midia A'),
      ('${ORG_B}', 'midia-inv-b', 'Midia Inv B', 'Midia B')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GESTOR_A}', '${ORG_A}', 'manager', now()),
      ('${ATENDENTE_A}', '${ORG_A}', 'agent', now()),
      ('${GESTOR_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
  `);
}

describe("0326 · biblioteca de mídias chega ao clone isolada e com papel", () => {
  it("nasce com RLS e a restritiva do segundo fator", () => {
    seed();
    expect(sql(`select relrowsecurity from pg_class where relname = 'media_library_items' and relnamespace = 'public'::regnamespace`)).toBe("t");
    expect(sql(`select count(*) from pg_policies where schemaname = 'public' and tablename = 'media_library_items' and policyname = 'mfa_provada'`)).toBe("1");
  });

  it("gestor cria; contains_person nasce true e variants nasce vazio", () => {
    expect(writeCountAs(GESTOR_A, `insert into public.media_library_items (id, organization_id, title) values ('${ITEM_A}', '${ORG_A}', 'Vídeo da unidade')`)).toBe(1);
    expect(sql(`select contains_person::text || ' ' || variants::text from public.media_library_items where id = '${ITEM_A}'`)).toBe("true []");
  });

  it("atendente lê e não escreve", () => {
    expect(countAs(ATENDENTE_A, `select count(*) from public.media_library_items where organization_id = '${ORG_A}';`)).toBe(1);
    expect(writeCountAs(ATENDENTE_A, `update public.media_library_items set title = 'x' where id = '${ITEM_A}'`)).toBe(0);
  });

  it("org B não vê nem escreve na org A", () => {
    expect(countAs(GESTOR_B, `select count(*) from public.media_library_items where organization_id = '${ORG_A}';`)).toBe(0);
    expect(writeCountAs(GESTOR_B, `insert into public.media_library_items (organization_id, title) values ('${ORG_A}', 'invadido')`)).toBe(0);
  });

  it("título vazio é recusado", () => {
    expect(() => sql(`insert into public.media_library_items (organization_id, title) values ('${ORG_A}', '   ')`)).toThrow();
  });

  it("bucket media-library existe privado, 50 MB, só imagem e vídeo, sem policy", () => {
    expect(lastLine(sql(`select public::text || '|' || file_size_limit::text || '|' || array_to_string(allowed_mime_types, ',') from storage.buckets where id = 'media-library';`)))
      .toBe("false|52428800|image/jpeg,image/png,image/webp,video/mp4,video/3gpp");
    expect(lastLine(sql(`select coalesce(string_agg(policyname, ','), 'NENHUMA') from pg_policies where schemaname = 'storage' and tablename = 'objects' and (coalesce(qual,'') || coalesce(with_check,'')) like '%media-library%';`)))
      .toBe("NENHUMA");
  });
});
