import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

describe("platform_meta_app.app_id / es_config_id — sem grant a anon/authenticated", () => {
  it("as colunas existem", () => {
    const r = sql(`select string_agg(column_name, ',' order by column_name)
      from information_schema.columns
      where table_schema='public' and table_name='platform_meta_app'
        and column_name in ('app_id','es_config_id');`).trim();
    expect(r).toBe("app_id,es_config_id");
  });
  it("nenhum privilégio por coluna nem por tabela para anon/authenticated", () => {
    const porColuna = sql(`select count(*) from information_schema.column_privileges
      where table_schema='public' and table_name='platform_meta_app'
        and column_name in ('app_id','es_config_id') and grantee in ('anon','authenticated');`).trim();
    const porTabela = sql(`select count(*) from information_schema.role_table_grants
      where table_schema='public' and table_name='platform_meta_app' and grantee in ('anon','authenticated');`).trim();
    expect(porColuna).toBe("0");
    expect(porTabela).toBe("0");
  });
});
