/**
 * A ÚLTIMA MARCA BOA DA CONTA MORA EM `platform_branding` (migration 0409).
 *
 * O leitor da Conta Eva Link (`lib/branding/conta.ts`) guarda aqui o que leu e
 * aprovou: nome da clínica, cor-semente, caminho da logo no bucket, os sha256
 * das logos anunciadas, o ETag e os carimbos. É o que o worker de LGPD/e-mail
 * (`marcaDaSaida`) usa sem esperar a Conta, e o que vale quando ela está fora.
 *
 * Este arquivo mede três coisas — e roda DEPOIS de install e update, porque o
 * `scripts/test-db.sh` aplica o baseline nos dois modos antes dos invariantes:
 *
 *   1. as colunas existem (o bloco da 0409 chegou ao baseline);
 *   2. os CHECKs recusam o que o leitor nunca deve gravar — hex maiúsculo
 *      (a mesma régua de `accent_hex`) e caminho fora de
 *      `platform/conta-<sha256>.(png|jpg)`;
 *   3. as colunas novas NÃO abriram a tabela: `anon` e `authenticated` seguem
 *      sem privilégio nenhum (o resto do contrato de acesso está em
 *      `marca-da-instalacao.test.ts`; aqui só o que a 0409 poderia ter mudado).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { motivoDoErro, sql } from "./psql-transporte";

const TABELA = "platform_branding";

const COLUNAS = {
  conta_nome: "text",
  conta_accent_hex: "text",
  conta_logo_path: "text",
  conta_logos: "jsonb",
  conta_etag: "text",
  conta_atualizado_em: "timestamp with time zone",
  conta_lida_em: "timestamp with time zone",
} as const;

const SHA = "a".repeat(64);

function erroAo(comando: string): string | null {
  try {
    sql(comando);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

beforeAll(() => {
  sql(`delete from public.${TABELA};`);
  sql(`insert into public.${TABELA} (id) values (1);`);
});

afterAll(() => {
  sql(`delete from public.${TABELA};`);
});

describe("as colunas da Conta existem", () => {
  for (const [coluna, tipo] of Object.entries(COLUNAS)) {
    it(`${coluna} é ${tipo}, anulável`, () => {
      const linha = sql(`
        select data_type || '|' || is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = '${TABELA}'
           and column_name = '${coluna}';
      `).trim();
      expect(linha).toBe(`${tipo}|YES`);
    });
  }
});

describe("os CHECKs da 0409", () => {
  it("`conta_accent_hex` aceita `#rrggbb` minúsculo e NULL", () => {
    expect(erroAo(`update public.${TABELA} set conta_accent_hex = '#27463b' where id = 1;`)).toBeNull();
    expect(erroAo(`update public.${TABELA} set conta_accent_hex = null where id = 1;`)).toBeNull();
  });

  it("`conta_accent_hex` recusa maiúscula e qualquer outra grafia", () => {
    for (const ruim of ["#27463B", "#FFFFFF", "#fff", "27463b", "#27463bb", "verde"]) {
      const erro = erroAo(`update public.${TABELA} set conta_accent_hex = '${ruim}' where id = 1;`);
      expect(erro, `deveria recusar ${JSON.stringify(ruim)}`).toContain(
        "platform_branding_conta_accent_hex",
      );
    }
  });

  it("`conta_logo_path` aceita `platform/conta-<sha256>.png|jpg` e NULL", () => {
    for (const bom of [`platform/conta-${SHA}.png`, `platform/conta-${SHA}.jpg`]) {
      expect(erroAo(`update public.${TABELA} set conta_logo_path = '${bom}' where id = 1;`)).toBeNull();
    }
    expect(erroAo(`update public.${TABELA} set conta_logo_path = null where id = 1;`)).toBeNull();
  });

  it("`conta_logo_path` recusa caminho fora do padrão", () => {
    for (const ruim of [
      `platform/conta-${SHA}.webp`,
      `platform/conta-${SHA}.svg`,
      `platform/conta-${"A".repeat(64)}.png`,
      `platform/conta-${"a".repeat(63)}.png`,
      `platform/${SHA}.png`,
      `org/conta-${SHA}.png`,
      `platform/conta-${SHA}.png/../x`,
      `https://exemplo.com/conta-${SHA}.png`,
    ]) {
      const erro = erroAo(`update public.${TABELA} set conta_logo_path = '${ruim}' where id = 1;`);
      expect(erro, `deveria recusar ${JSON.stringify(ruim)}`).toContain(
        "platform_branding_conta_logo_path",
      );
    }
  });

  it("cada CHECK existe uma vez só — reaplicar o baseline não duplica", () => {
    const quantos = sql(`
      select count(*) from pg_constraint
       where conrelid = 'public.${TABELA}'::regclass
         and conname in ('platform_branding_conta_accent_hex', 'platform_branding_conta_logo_path');
    `).trim();
    expect(quantos).toBe("2");
  });
});

describe("as colunas novas não abriram a tabela", () => {
  for (const papel of ["anon", "authenticated"]) {
    it(`\`${papel}\` segue sem privilégio nenhum, nem por coluna`, () => {
      const tabela = sql(`
        select count(*) from information_schema.role_table_grants
         where table_schema = 'public' and table_name = '${TABELA}' and grantee = '${papel}';
      `).trim();
      const coluna = sql(`
        select count(*) from information_schema.column_privileges
         where table_schema = 'public' and table_name = '${TABELA}' and grantee = '${papel}';
      `).trim();
      expect(tabela).toBe("0");
      expect(coluna).toBe("0");
    });

    it(`\`${papel}\` é BARRADO ao ler as colunas da Conta`, () => {
      const erro = erroAo(`set role ${papel};\nselect conta_nome, conta_etag from public.${TABELA};\nreset role;`);
      expect(erro, `\`${papel}\` leu as colunas da Conta SEM erro`).not.toBeNull();
      expect(erro).toContain("permission denied");
    });
  }
});
