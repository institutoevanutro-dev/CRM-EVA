/**
 * RELATÓRIO POR ETIQUETA — a tela, provada como um gestor a usaria.
 *
 * A rota (`GET /api/v1/reports/tags`) tem contrato próprio em
 * `tests/unit/reports-por-etiqueta.test.ts`. O que só a tela prova:
 *  · a PORTA: o gestor chega pelo menu ("Ver tudo em Análise" → "Por
 *    etiqueta"), não digitando a URL. O item fica fora da barra lateral porque
 *    a dobra de 1280×900 já está no limite (ver `app/app/analise/page.tsx`);
 *  · a TABELA mostra as etiquetas semeadas, ordenadas por volume, com a espera
 *    escrita em minutos;
 *  · o PERÍODO chega ao servidor: a conversa de 20 dias atrás conta em 30 dias
 *    e some em 7. Um seletor que só troca o rótulo devolveria o mesmo número.
 *
 * Pré-requisitos (banco local do baseline, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/relatorio-por-etiqueta.spec.ts
 */
import { randomInt, randomUUID } from "node:crypto";

import { test, type Page } from "@playwright/test";

import { admin, captura, creds, expect, insere, login, type Creds } from "./qa-l12-comum";

const SUFIXO = `${Date.now()}`.slice(-7);
const ORCAMENTO = `orcamento-e2e-${SUFIXO}`;
const RECLAMACAO = `reclamacao-e2e-${SUFIXO}`;
const MIN = 60_000;
const DIA = 86_400_000;

let c: Creds;
let canal = "";
const conversas: string[] = [];
const contatos: string[] = [];

async function conversa(tags: string[], diasAtras: number, status = "open"): Promise<void> {
  const contato = await insere("contacts", {
    organization_id: c.org_id,
    name: `Etiqueta E2E ${SUFIXO} ${contatos.length}`,
    phone_number: `+5511${randomInt(100000000, 1000000000)}`,
    tags: [],
  });
  contatos.push(contato);
  // Meio-dia de N dias atrás: longe da virada do dia em qualquer fuso razoável.
  const inicio = Date.now() - diasAtras * DIA;
  conversas.push(
    await insere("conversations", {
      organization_id: c.org_id,
      contact_id: contato,
      channel_session_id: canal,
      status,
      tags,
      service_started_at: new Date(inicio).toISOString(),
      // Respondida 12 minutos depois: a espera média da etiqueta é 12 min.
      awaiting_since: new Date(inicio).toISOString(),
      last_outbound_at: new Date(inicio + 12 * MIN).toISOString(),
      ...(status === "closed" ? { service_closed_at: new Date(inicio + 30 * MIN).toISOString() } : {}),
    }),
  );
}

/** As linhas da tabela que são desta fixture, na ordem em que a tela as mostra. */
async function linhas(page: Page): Promise<Array<{ etiqueta: string; celulas: string[] }>> {
  return page.locator("[data-etiqueta]").evaluateAll((trs, nossas) =>
    trs
      .map((tr) => ({
        etiqueta: tr.getAttribute("data-etiqueta") ?? "",
        celulas: [...tr.querySelectorAll("td")].map((td) => (td.textContent ?? "").trim()),
      }))
      .filter((l) => (nossas as string[]).includes(l.etiqueta)),
    [ORCAMENTO, RECLAMACAO],
  );
}

async function escolherPeriodo(page: Page, dias: number): Promise<void> {
  const resposta = page.waitForResponse((r) => r.url().includes("/api/v1/reports/tags?"));
  await page.getByRole("combobox", { name: "Período" }).click();
  await page.getByRole("option", { name: `Últimos ${dias} dias` }).click();
  await resposta;
}

test.describe("Relatório por etiqueta — pela tela", () => {
  test.describe.configure({ timeout: 240_000 });
  test.use({ timezoneId: "America/Sao_Paulo" });

  test.beforeAll(async () => {
    c = creds();
    canal = await insere("channel_sessions", {
      organization_id: c.org_id,
      waha_session_name: `qa-relatorio-etiqueta-${randomUUID()}`,
      display_name: "Canal QA relatório por etiqueta",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    // Orçamento: 3 nos últimos dias (1 encerrada). Reclamação: 1 recente e 1
    // de 20 dias atrás — só esta muda entre 7 e 30 dias.
    await conversa([ORCAMENTO], 1);
    await conversa([ORCAMENTO], 2);
    await conversa([ORCAMENTO], 3, "closed");
    await conversa([RECLAMACAO], 1);
    await conversa([RECLAMACAO], 20);
  });

  test.afterAll(async () => {
    if (conversas.length) await admin.from("conversations").delete().in("id", conversas);
    if (contatos.length) await admin.from("contacts").delete().in("id", contatos);
    if (canal) await admin.from("channel_sessions").delete().eq("id", canal);
  });

  test("entra pelo menu, lê a tabela e troca o período", async ({ page }) => {
    await login(page, c.users.manager!.email, c.password);

    // A PORTA: pelo menu, nunca pela URL.
    const sidebar = page.getByRole("navigation", { name: "Navegação principal" });
    await sidebar.getByRole("link", { name: "Ver tudo em Análise" }).click();
    await page.waitForURL(/\/app\/analise/, { timeout: 30_000 });
    await page.getByRole("link", { name: /^Por etiqueta/ }).click();
    await page.waitForURL(/\/app\/tag-report/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Por etiqueta", level: 1 })).toBeVisible();

    // Padrão: últimos 30 dias — as duas de reclamação estão dentro.
    await expect(page.getByTestId("tabela-por-etiqueta")).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => (await linhas(page)).length, { timeout: 30_000 }).toBe(2);
    const em30 = await linhas(page);
    // Colunas: etiqueta, iniciadas, abertas, encerradas, espera, fatia.
    expect(em30.map((l) => l.etiqueta), "ordenada por volume").toEqual([ORCAMENTO, RECLAMACAO]);
    expect(em30[0]!.celulas.slice(1, 5)).toEqual(["3", "2", "1", "12 min"]);
    expect(em30[1]!.celulas.slice(1, 5)).toEqual(["2", "2", "0", "12 min"]);
    expect(em30[0]!.celulas[5]).toMatch(/^\d+%$/);
    await captura(page, "relatorio-por-etiqueta-30-dias");

    // 7 dias: a reclamação de 20 dias atrás sai da conta.
    await escolherPeriodo(page, 7);
    await expect
      .poll(async () => (await linhas(page)).find((l) => l.etiqueta === RECLAMACAO)?.celulas[1], {
        timeout: 30_000,
      })
      .toBe("1");
    expect((await linhas(page)).find((l) => l.etiqueta === ORCAMENTO)?.celulas[1]).toBe("3");
    await captura(page, "relatorio-por-etiqueta-7-dias");

    const transbordo = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(transbordo, "a tela não rola na horizontal").toBeLessThanOrEqual(0);
  });
});
