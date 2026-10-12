/**
 * PEDIDO DE DADOS DO TITULAR SEM E-MAIL: DA APROVAÇÃO AO PDF NA MÃO DO OPERADOR.
 *
 * É o defeito da migration 0356 visto pela tela. O ambiente da suíte não tem
 * envio de e-mail configurado (o `.env.e2e` não define `RESEND_API_KEY`), que é
 * o estado de um primeiro deploy. Antes do conserto, este pedido ficava em
 * "Processando" para sempre: o banco recusava `pending_review` e ninguém lia o
 * erro. Agora:
 *
 *   Recebido → (operador aprova) → Processando → (dreno) → Revisão pendente,
 *   com "Baixar PDF" na página do pedido.
 *
 * Evidência visual em `.superpowers/evidence/lgpd-export/sem-email/`.
 */
import * as fs from "node:fs";

import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import {
  aprovarPelaTela,
  baixarPdfDaTela,
  criarPedido,
  drenarAteSairDeProcessando,
  servico,
} from "./helpers/lgpd-pedido";

const PASTA = ".superpowers/evidence/lgpd-export/sem-email";

test("pedido sem e-mail de entrega vira Revisão pendente e oferece o PDF", async ({ page }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(PASTA, { recursive: true });
  const creds = lerCreds() as ReturnType<typeof lerCreds> & { org_id: string };
  const banco = servico();
  const pedidoId = await criarPedido(banco, creds.org_id, "Titular Sem Email E2E", null);

  await loginComoAdmin(page, creds);
  await aprovarPelaTela(page, pedidoId, PASTA);

  const status = await drenarAteSairDeProcessando(page, banco, pedidoId);
  expect(status, "o pedido não pode ficar em processing nem falhar: o relatório foi gerado").toBe("pending_review");

  await page.reload();
  await expect(page.getByText("Revisão pendente", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const pdf = await baixarPdfDaTela(page);
  expect(pdf.length).toBeGreaterThan(1000);
  // A trilha conta o que aconteceu: aprovado por alguém, relatório gerado.
  await expect(page.getByText("lgpd.manually_approved")).toBeVisible();
  await expect(page.getByText("lgpd.export_generated")).toBeVisible();
  await page.screenshot({ path: `${PASTA}/4-revisao-pendente-com-pdf.png`, fullPage: true });

  const linha = await banco
    .from("lgpd_requests")
    .select("status, error_message, result, attempts")
    .eq("id", pedidoId)
    .single();
  expect(linha.data).toMatchObject({
    status: "pending_review",
    error_message: "no_delivery_email",
    attempts: 1,
    result: { pdf_path: `${creds.org_id}/${pedidoId}/report.pdf` },
  });

  // E a lista mostra o estado, e o filtro por ele encontra o pedido.
  await page.goto("/app/lgpd/requests");
  const naLista = page.getByRole("row").filter({ hasText: pedidoId.slice(0, 8) });
  await expect(naLista).toContainText("Revisão pendente", { timeout: 30_000 });
  await page.screenshot({ path: `${PASTA}/5-lista-revisao-pendente.png`, fullPage: true });
});
