/**
 * O CRM reabre na organização que a pessoa usou por último (migration 0282).
 *
 * ─── O que este arquivo mede, e o que NÃO mede ─────────────────────────────
 *
 * Mede a FONTE, não o comportamento: a ordenação vive numa cadeia `.order()`
 * do PostgREST, e o que decide de fato é o Postgres. Um teste de verdade
 * precisaria de banco, e o lugar dele seria `tests/invariants/`.
 *
 * Então por que existir? Porque o defeito que ele guarda é de OMISSÃO, e
 * omissão não quebra nada visível: tirar o `.order("ultima_ativacao_em")` não
 * derruba build, não derruba tipo, não derruba nenhum outro teste. A tela
 * simplesmente volta a abrir na organização errada, e ninguém liga isso a um
 * commit. O mesmo vale para o `nullsFirst: false`, que é o detalhe que faz a
 * coluna significar alguma coisa: com o default (nulos primeiro), quem NUNCA
 * trocou de organização venceria quem trocou, e a feature inteira viraria
 * enfeite com o gate verde.
 *
 * NÃO MEDIDO aqui: que o Postgres ordena como pedido, que o UPDATE alcança a
 * linha, e que o cookie continua tendo prioridade. O primeiro é contrato do
 * PostgREST; os dois últimos foram conferidos à mão numa instalação real.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const raiz = join(__dirname, "..", "..");
const servidor = readFileSync(join(raiz, "lib/auth/server.ts"), "utf8");
const acao = readFileSync(join(raiz, "app/actions/shell/setActiveOrg.ts"), "utf8");

describe("a organização que a pessoa usou por último", () => {
  it("é lida por loadAuthUser, e a coluna vem no select", () => {
    expect(servidor).toContain("ultima_ativacao_em, organizations(display_name, locale)");
  });

  it("ordena com os nulos POR ÚLTIMO — sem isso, quem nunca trocou vence quem trocou", () => {
    const linha = servidor
      .split("\n")
      .find((l) => l.includes('.order("ultima_ativacao_em"'));
    expect(linha, "a ordenação por ultima_ativacao_em sumiu de loadAuthUser").toBeDefined();
    expect(linha).toContain("ascending: false");
    expect(linha).toContain("nullsFirst: false");
  });

  it("vem ANTES do desempate por accepted_at, que é o critério antigo", () => {
    const novo = servidor.indexOf('.order("ultima_ativacao_em"');
    const velho = servidor.indexOf('.order("accepted_at"');
    expect(novo).toBeGreaterThan(-1);
    expect(velho).toBeGreaterThan(-1);
    expect(novo, "inverter a ordem faz a coluna nova nunca decidir nada").toBeLessThan(velho);
  });

  it("é escrita quando a pessoa troca de organização pelo seletor", () => {
    expect(acao).toContain("ultima_ativacao_em: new Date().toISOString()");
    expect(acao).toContain('.eq("user_id", user.id)');
  });

  it("é escrita pelo admin client, porque a policy de UPDATE exige admin da org", () => {
    // Pelo client do usuário, um `agent` não gravaria nada e o PostgREST
    // devolveria sucesso com zero linhas: falha calada. Trocar por `db` aqui
    // faz a feature funcionar só para quem é admin.
    expect(acao).toContain("createAdminClient()\n    .from(\"user_organizations\")");
  });

  it("nunca derruba a troca de organização quando a preferência falha", () => {
    // A troca já aconteceu no cookie. Um `return { ok: false }` aqui tiraria da
    // pessoa a capacidade de trocar de organização por causa de um enfeite.
    const trecho = acao.slice(acao.indexOf("erroPreferencia"));
    expect(trecho).toContain("logger.warn");
    expect(trecho.slice(0, trecho.indexOf("return { ok: true }"))).not.toContain("ok: false");
  });
});

describe("a migration 0282 chega a quem já instalou", () => {
  it("está no baseline.sql, que é o que o self-host aplica", () => {
    const baseline = readFileSync(join(raiz, "supabase/baseline.sql"), "utf8");
    expect(baseline).toContain("add column if not exists ultima_ativacao_em timestamptz");
    expect(baseline).toContain("user_organizations_ultima_ativacao_idx");
  });

  it("está no MANIFEST", () => {
    const manifest = readFileSync(join(raiz, "supabase/migrations/MANIFEST.md"), "utf8");
    expect(manifest).toContain("0283_ultima_organizacao_ativada");
  });
});
