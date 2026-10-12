/**
 * O PEDIDO DO TITULAR FECHA O CICLO: TODO ESTADO QUE O CÓDIGO GRAVA, O BANCO ACEITA (0356).
 *
 * Porte de melgarafael/DeskcommCRM #2788 (@melgarafael; lá a migration é a 0651),
 * com um caso a mais (o 1) que lê os estados do CÓDIGO em vez de transcrevê-los.
 *
 * ## O defeito
 *
 * O `lgpd-export-worker` grava `status = 'pending_review'` quando o relatório
 * ficou pronto e não há como entregar por e-mail (instalação sem transporte, ou
 * titular sem endereço). O CHECK `lgpd_requests_status_check` só aceitava
 * received/processing/completed/failed/expired: o UPDATE morria em 23514, o
 * worker não lia o erro, auditava `lgpd.export_generated` e devolvia `ok` ao
 * dreno. O pedido ficava em `processing` para sempre, com `result` nulo e o PDF
 * no bucket sem ponteiro. O `lgpd-redact-worker` grava o mesmo estado em dois
 * desfechos (sem pegada local; anonimização de organização com falha parcial).
 *
 * ## Qual caso guarda o quê
 *
 *   1. TODO estado que os workers, a aprovação e a criação gravam em
 *      `lgpd_requests.status` é aceito pelo banco que o self-hoster aplica. Os
 *      estados saem do FONTE (não de uma lista copiada aqui): estado novo no
 *      código sem migration deixa este caso vermelho. É a reprodução do defeito:
 *      antes da 0356 ele falha em `pending_review` com 23514.
 *   2. o CHECK continua RECUSANDO valor fora do vocabulário: sem este caso, um
 *      "conserto" que apagasse o CHECK passaria no caso 1.
 *   3. a cura dos pedidos presos, EXECUTADA do bloco do baseline numa transação
 *      revertida: os presos com prova no audit saem de `processing` com o
 *      `result` que o worker gravaria; o preso SEM prova fica, e a prova de
 *      OUTRA organização não alcança o pedido (isolamento entre organizações).
 *   4. migration e apêndice carregam o MESMO bloco: a cadeia e o deploy curam igual.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, lastLine, seedGov, sql } from "./gov-helpers";

const MIGRATION = "supabase/migrations/20261012180000_0356_pedido_lgpd_fecha_o_ciclo.sql";
const MARCADOR_INICIO = "-- ---- o pedido do titular fecha o ciclo (migration 0356) ----";
const MARCADOR_PROXIMO = "\n-- ---- ";

const ler = (relativo: string) => readFileSync(join(process.cwd(), relativo), "utf8");

/** Quem grava `lgpd_requests.status`. Arquivo novo que grave estado entra aqui. */
const QUEM_GRAVA = [
  "workers/lgpd-export-worker.ts",
  "workers/lgpd-redact-worker.ts",
  "app/api/v1/lgpd/requests/[id]/approve/route.ts",
  "app/api/v1/lgpd/requests/[id]/deliver/route.ts",
  "lib/lgpd/repository.ts",
];

/**
 * `status:` nesses arquivos também é o veredito devolvido ao dreno
 * (`HandlerResult`: ok/error/skipped/retry), o estado da ORGANIZAÇÃO
 * (`redacted`) e o do callback da Nuvemshop (`not_implemented`). Não são
 * estados do pedido.
 */
const NAO_E_ESTADO_DO_PEDIDO = new Set(["ok", "error", "skipped", "retry", "redacted", "not_implemented"]);

/**
 * Os estados que o código grava, lidos do fonte.
 *
 * ponytail: heurística de texto (todo literal numa expressão `status: ...`, até a
 * vírgula, ou num `const ...Status = ...`), e não análise de AST. O teto é um estado montado
 * por concatenação ou vindo de outro arquivo; se isso aparecer, troque por AST.
 * A guarda logo abaixo impede o modo de falha pior: extrair nada e passar vazio.
 */
function estadosGravadosPeloCodigo(): string[] {
  const achados = new Set<string>();
  for (const arquivo of QUEM_GRAVA) {
    const fonte = ler(arquivo)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    const expressoes = fonte.matchAll(
      /(?:\bstatus:|const\s+\w*[Ss]tatus\w*\s*=)([^,\n]*(?:\n\s*[?:][^,\n]*)*)/g,
    );
    for (const [, expressao] of expressoes) {
      for (const [, literal] of expressao!.matchAll(/"([a-z_]+)"/g)) {
        if (!NAO_E_ESTADO_DO_PEDIDO.has(literal!)) achados.add(literal!);
      }
    }
  }
  for (const esperado of ["received", "processing", "completed", "failed"]) {
    if (!achados.has(esperado)) {
      throw new Error(
        `extrator de estados: não achei "${esperado}" em ${QUEM_GRAVA.join(", ")}. ` +
          `Isso é falha do INSTRUMENTO (o fonte mudou de forma), não vocabulário menor.`,
      );
    }
  }
  return [...achados].sort();
}

/** O `do $$ ... end $$;` de um texto: o único que cada arquivo tem para este conserto. */
function blocoDo(texto: string, origem: string): string {
  const inicio = texto.indexOf("\ndo $$\n");
  const fim = texto.indexOf("\nend $$;", inicio);
  if (inicio < 0 || fim < 0) throw new Error(`bloco do $$ não encontrado em ${origem}`);
  const bloco = texto.slice(inicio + 1, fim + "\nend $$;".length);
  if (!/lgpd_requests_status_check/.test(bloco) || !/'lgpd\.tenant_redacted'/.test(bloco)) {
    throw new Error(`bloco extraído de ${origem} está truncado (extração quebrada)`);
  }
  return bloco;
}

function blocoDoApendice(): string {
  const baseline = ler("supabase/baseline.sql");
  const inicio = baseline.indexOf(MARCADOR_INICIO);
  if (inicio < 0) throw new Error(`marcador ${MARCADOR_INICIO} não encontrado em supabase/baseline.sql`);
  const fim = baseline.indexOf(MARCADOR_PROXIMO, inicio + MARCADOR_INICIO.length);
  return blocoDo(fim < 0 ? baseline.slice(inicio) : baseline.slice(inicio, fim), "baseline.sql");
}

// Namespace pela migration (0356).
const ORG_ALHEIA = "03560000-0000-4000-8000-0000000000aa";
const P_SEM_TRANSPORTE = "03560000-1111-4000-8000-000000000001";
const P_SEM_ENDERECO = "03560000-1111-4000-8000-000000000002";
const P_SEM_PEGADA = "03560000-1111-4000-8000-000000000003";
const P_TENANT = "03560000-1111-4000-8000-000000000004";
const P_SEM_PROVA = "03560000-1111-4000-8000-000000000005";
const P_PROVA_ALHEIA = "03560000-1111-4000-8000-000000000006";
const P_TESTE_CHECK = "03560000-1111-4000-8000-000000000007";

function pedido(id: string, tipo: string, escopo = "contact"): string {
  return `insert into public.lgpd_requests
            (id, organization_id, request_type, source, status, attempts, due_at, scope)
          values ('${id}', '${GOV_ORG}', '${tipo}', 'manual', 'processing', 1, now() + interval '5 days', '${escopo}');`;
}

function prova(id: string, acao: string, metadata: object, org = GOV_ORG): string {
  return `insert into public.api_audit_log (organization_id, action, resource_type, resource_id, bypassed_rls, metadata)
          values ('${org}', '${acao}', 'lgpd_request', '${id}', true, '${JSON.stringify(metadata)}'::jsonb);`;
}

type Linha = {
  status: string;
  error_message: string | null;
  result: unknown;
  completed_at: string | null;
  cascaded_to: unknown;
};

/** Planta os presos, reaplica o bloco do baseline e devolve as linhas. Tudo revertido. */
function depoisDaCura(): Record<string, Linha> {
  const saida = sql(`
    begin;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_ALHEIA}', 'org-alheia-0356', 'Org alheia 0356', 'Org alheia 0356');
    ${pedido(P_SEM_TRANSPORTE, "data_request")}
    ${prova(P_SEM_TRANSPORTE, "lgpd.export_generated", {
      sha256: "abc",
      signed_pades: false,
      warning: "email_not_configured",
      delivered_to_hash: "hash-do-titular",
    })}
    ${pedido(P_SEM_ENDERECO, "data_request")}
    ${prova(P_SEM_ENDERECO, "lgpd.export_generated", {
      sha256: "def",
      signed_pades: false,
      warning: "pades_key_missing",
      delivery: "pending_review_no_email",
    })}
    ${pedido(P_SEM_PEGADA, "redact")}
    ${prova(P_SEM_PEGADA, "lgpd.redact_no_local_footprint", { external_customer_id_present: true })}
    ${pedido(P_TENANT, "store_redact", "tenant")}
    ${prova(P_TENANT, "lgpd.tenant_redacted", {
      processed: 10,
      failed_count: 2,
      aggregate_counts: { contacts: 8 },
      callback_status: "not_implemented",
      attempts: 1,
      partial_failure: true,
    })}
    ${pedido(P_SEM_PROVA, "data_request")}
    ${pedido(P_PROVA_ALHEIA, "data_request")}
    ${prova(P_PROVA_ALHEIA, "lgpd.export_generated", { sha256: "x", signed_pades: false, warning: "email_not_configured" }, ORG_ALHEIA)}
    ${blocoDoApendice()}
    select json_object_agg(id, json_build_object(
             'status', status, 'error_message', error_message, 'result', result,
             'completed_at', completed_at, 'cascaded_to', cascaded_to))
      from public.lgpd_requests where id::text like '03560000-1111-%';
    rollback;
  `);
  const linha = saida.split("\n").find((l) => l.trim().startsWith("{"));
  if (!linha) throw new Error(`nenhum json na saída do psql: ${saida}`);
  return JSON.parse(linha);
}

beforeAll(() => {
  seedGov();
  sql(`delete from public.lgpd_requests where id::text like '03560000-1111-%';`);
});

describe("0356: o pedido do titular fecha o ciclo", () => {
  it("1. todo estado que o código grava em lgpd_requests.status é aceito pelo banco", () => {
    const estados = estadosGravadosPeloCodigo();
    const recusados: string[] = [];
    for (const estado of estados) {
      try {
        sql(`
          begin;
          ${pedido(P_TESTE_CHECK, "data_request")}
          update public.lgpd_requests set status = '${estado}' where id = '${P_TESTE_CHECK}';
          rollback;
        `);
      } catch (erro) {
        recusados.push(`${estado}: ${String(erro instanceof Error ? erro.message : erro).split("\n").find((l) => /ERROR/.test(l)) ?? "recusado"}`);
      }
    }
    expect(
      recusados,
      `o código grava estado que o banco recusa: o pedido fica preso no estado anterior.\n` +
        `  estados gravados pelo código: ${estados.join(", ")}`,
    ).toEqual([]);
  });

  it("2. e o banco continua recusando valor fora do vocabulário", () => {
    expect(() =>
      sql(`
        begin;
        ${pedido(P_TESTE_CHECK, "data_request")}
        update public.lgpd_requests set status = 'em_revisao' where id = '${P_TESTE_CHECK}';
        rollback;
      `),
    ).toThrow(/lgpd_requests_status_check/);
    expect(lastLine(sql(`select count(*) from public.lgpd_requests where id = '${P_TESTE_CHECK}';`))).toBe("0");
  });

  it("3. o bloco do baseline cura os presos com prova, e só eles (duas organizações)", () => {
    const r = depoisDaCura();

    expect(r[P_SEM_TRANSPORTE]).toMatchObject({
      status: "pending_review",
      error_message: "email_not_configured",
      result: {
        pdf_path: `${GOV_ORG}/${P_SEM_TRANSPORTE}/report.pdf`,
        json_path: `${GOV_ORG}/${P_SEM_TRANSPORTE}/data.json`,
        sha256: "abc",
        signed_pades: false,
        warning: "pades_key_missing",
        delivered_to_hash: "hash-do-titular",
      },
    });
    expect(r[P_SEM_ENDERECO]).toMatchObject({
      status: "pending_review",
      error_message: "no_delivery_email",
      result: { pdf_path: `${GOV_ORG}/${P_SEM_ENDERECO}/report.pdf`, sha256: "def", warning: "pades_key_missing" },
    });
    expect(r[P_SEM_ENDERECO]!.result).not.toHaveProperty("delivered_to_hash");
    expect(r[P_SEM_PEGADA]).toMatchObject({
      status: "pending_review",
      error_message: "no_local_footprint",
      result: { reason: "no_local_footprint" },
    });
    expect(r[P_TENANT]).toMatchObject({
      status: "pending_review",
      error_message: "partial_failure",
      cascaded_to: { contacts: 8 },
      result: { scope: "tenant", processed: 10, failed_contacts_count: 2, organization_status: "redacted" },
    });
    expect(r[P_TENANT]!.completed_at).not.toBeNull();

    // Sem prova, nada se inventa; prova de OUTRA organização não alcança o pedido.
    expect(r[P_SEM_PROVA]).toMatchObject({ status: "processing", result: null });
    expect(r[P_PROVA_ALHEIA]).toMatchObject({ status: "processing", result: null });
  });

  it("4. migration e apêndice do baseline carregam o mesmo bloco", () => {
    expect(blocoDoApendice()).toBe(blocoDo(ler(MIGRATION), MIGRATION));
  });
});
