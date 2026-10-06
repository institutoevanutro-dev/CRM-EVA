/**
 * OS DOIS CAMINHOS DE ANONIMIZAR CHAMAM A MESMA FUNÇÃO DE REDACT — migration 0317.
 *
 * Portado do DeskcommCRM original (commit ca39e824e, de webtecnica, issue
 * #1504) e adaptado a este fork: a migration daqui é a 0317, e o que o botão
 * deixava para trás aqui está descrito no cabeçalho dela.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Havia DUAS redações com alcances diferentes:
 *
 *   fn_lgpd_cascade_redact_contact   pedido formal (lib/lgpd/redact-cascade.ts)
 *   fn_lgpd_anonymize_contact        botão "Anonimizar contato" da ficha
 *
 * O botão reescrevia o contato (nome, e-mail, telefone, CPF, nascimento) e mais
 * nada por conta própria. `contacts.consent` / `source_metadata` / `tags`, a
 * identidade do Instagram, pedidos, chamadas e o resto do negócio só eram
 * alcançados por quem abria um pedido formal.
 *
 * ─── O que este arquivo mede ────────────────────────────────────────────────
 *
 * A correção é no ENCADEAMENTO: desde a 0317 o portão CHAMA a cascata e não
 * redige por conta própria. Aqui ficam quatro propriedades que uma migration
 * futura poderia perder sem que nada na tela mudasse:
 *
 *   1. os DOIS caminhos terminam na MESMA função (portão → cascata; rota →
 *      portão; worker → helper da cascata);
 *   2. o portão não tem escrita própria — um `update` colado ali seria a
 *      divergência de novo, com a chamada dando a ILUSÃO de cobertura;
 *   3. os portões da 0229 continuam no corpo (MFA, 42501, trava antes do
 *      `for update`): `create or replace` troca o corpo inteiro e não avisa;
 *   4. o rótulo que o diálogo PROMETE é o rótulo que a cascata GRAVA.
 *
 * O efeito no banco (o botão de verdade, a equivalência com o pedido formal, a
 * varredura do @ e do IGSID) mora em
 * `tests/invariants/lgpd-botao-limpa-o-que-o-pedido-limpa.test.ts`, que precisa
 * de Postgres (`pnpm test:db`). O que é TEXTO do repositório é medido aqui.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = process.cwd();
const BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
const MIGRACOES = join(RAIZ, "supabase", "migrations");

/**
 * A ÚLTIMA definição de uma função num texto aplicado de cima para baixo — é
 * ela que o Postgres deixa de pé. O delimitador é lido do próprio texto
 * (o baseline usa `$$` e `$fn$`), senão o corpo é lido além do fim: a armadilha
 * que `apendice-do-baseline-nao-diverge-da-cadeia` já pagou.
 */
function ultimaDefinicao(texto: string, nome: string): string {
  let ultimo = "";
  // As duas grafias do repo: a cadeia/apêndice escreve minúsculo sem aspas, o
  // bloco do `pg_dump` escreve MAIÚSCULO com `"public"."…"`. A última cópia da
  // cascata no baseline é da segunda forma, e lê-la com uma só grafia devolveria
  // string vazia — asserção verde por instrumento morto.
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+(?:"?public"?\\.)?"?${nome}"?\\s*\\(`,
    "gi",
  );
  for (let m = re.exec(texto); m !== null; m = re.exec(texto)) {
    const abertura = /\$([a-z_]*)\$/i.exec(texto.slice(m.index, m.index + 600));
    if (!abertura) continue;
    const marca = abertura[0];
    const fim = texto.indexOf(marca, m.index + abertura.index + marca.length);
    if (fim === -1) continue;
    ultimo = texto.slice(m.index, fim + marca.length);
  }
  return ultimo;
}

const cadeia = readdirSync(MIGRACOES)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRACOES, f), "utf8"))
  .join("\n");

const portaoNoBaseline = ultimaDefinicao(BASELINE, "fn_lgpd_anonymize_contact");
const portaoNaCadeia = ultimaDefinicao(cadeia, "fn_lgpd_anonymize_contact");
const cascatas = ultimaDefinicao(BASELINE, "fn_lgpd_cascade_redact_contact");
const rota = readFileSync(
  join(RAIZ, "app", "api", "v1", "lgpd", "anonymize", "route.ts"),
  "utf8",
);
const helperDoPedido = readFileSync(join(RAIZ, "lib", "lgpd", "redact-cascade.ts"), "utf8");
const worker = readFileSync(join(RAIZ, "workers", "lgpd-redact-worker.ts"), "utf8");
const dialogo = readFileSync(join(RAIZ, "components", "contacts", "AnonymizeDialog.tsx"), "utf8");

describe("redact unificado: os dois caminhos chamam a MESMA função", () => {
  it("CONTROLE: as sondas acharam os corpos — se não acharem, o verde não vale nada", () => {
    // Um parser que devolve string vazia faria TODA asserção abaixo passar por
    // vacuidade: nada contém nada, e "não contém escrita própria" seria verde.
    expect(portaoNoBaseline.length).toBeGreaterThan(400);
    expect(portaoNaCadeia.length).toBeGreaterThan(400);
    expect(cascatas.length).toBeGreaterThan(2000);
    expect(portaoNoBaseline).toContain("fn_lgpd_anonymize_contact");
  });

  it("o portão do botão CHAMA a cascata canônica — baseline E cadeia de migrations", () => {
    for (const [origem, corpo] of [
      ["baseline", portaoNoBaseline],
      ["cadeia", portaoNaCadeia],
    ] as const) {
      expect(
        corpo,
        `${origem}: o portão não chama fn_lgpd_cascade_redact_contact — os dois caminhos voltam a ter alcances diferentes`,
      ).toContain("public.fn_lgpd_cascade_redact_contact(");
    }
  });

  it("o portão não redige por conta própria — nenhuma escrita de tabela no corpo", () => {
    // `for update` é leitura com trava, não escrita: o que proíbe é `update X set`
    // e `delete from X`, a forma concreta de alguém reacrescentar um passo aqui.
    expect(portaoNoBaseline).not.toMatch(/\bupdate\s+(?:public\.)?"?[a-z_]+"?\s+set\b/i);
    expect(portaoNoBaseline).not.toMatch(/\bdelete\s+from\s+(?:public\.)?"?[a-z_]+/i);
    expect(portaoNaCadeia).not.toMatch(/\bupdate\s+(?:public\.)?"?[a-z_]+"?\s+set\b/i);
    expect(portaoNaCadeia).not.toMatch(/\bdelete\s+from\s+(?:public\.)?"?[a-z_]+/i);
  });

  it("os portões da 0229 continuam: MFA, 42501 e mutex antes do `for update`", () => {
    for (const corpo of [portaoNoBaseline, portaoNaCadeia]) {
      expect(corpo).toContain("fn_session_mfa_proven");
      expect(corpo).toContain("contact_anonymize_forbidden");
      expect(corpo).toContain("errcode='42501'");
      expect(corpo.indexOf("fn_service_lock")).toBeLessThan(corpo.indexOf("for update"));
    }
  });

  it("a rota da tela chama o portão, e o portão é o da cadeia (0317)", () => {
    expect(rota).toContain('"fn_lgpd_anonymize_contact"');
    expect(cadeia).toContain("create or replace function public.fn_lgpd_anonymize_contact(");
    expect(readdirSync(MIGRACOES).some((f) => /^2026\d{10}_0317_.*\.sql$/.test(f))).toBe(true);
  });

  it("o pedido formal chama a MESMA cascata — helper e worker", () => {
    expect(helperDoPedido).toContain('"fn_lgpd_cascade_redact_contact"');
    expect(worker).toContain('from "@/lib/lgpd/redact-cascade"');
    expect(worker).toContain("cascadeRedactContact(");
  });

  it("o diálogo promete o rótulo que a cascata grava", () => {
    // A cascata escreve `v_anon_label := 'Cliente Anonimizado #' || …`; com a
    // unificação é esse rótulo que o botão da ficha passa a gravar.
    expect(cascatas).toContain("Cliente Anonimizado #");
    expect(dialogo).toContain("Cliente Anonimizado #N");
    expect(dialogo).not.toContain("Contato Anonimizado #N");
  });
});
