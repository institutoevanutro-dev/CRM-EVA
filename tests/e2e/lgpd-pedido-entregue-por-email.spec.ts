/**
 * PEDIDO DE DADOS DO TITULAR ENTREGUE POR E-MAIL: DA APROVAÇÃO AO "CONCLUÍDO".
 *
 * O caminho feliz inteiro, com um RECEPTOR HTTP DE VERDADE no lugar da Resend:
 * o servidor sob teste sobe com `RESEND_BASE_URL` apontando para o receptor
 * deste arquivo, e a prova é o que CHEGOU nele (destinatário, assunto e o link
 * do relatório, que tem de baixar um PDF).
 *
 *   Recebido → (operador aprova) → Processando → (dreno) → Concluído
 *
 * FORA DO CI, e o motivo é a precondição: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
 * e `RESEND_BASE_URL` são lidos quando o `next start` sobe, e o ambiente da
 * suíte roda SEM envio de e-mail de propósito (é o estado de um primeiro
 * deploy, e é o que `lgpd-pedido-sem-email-vira-revisao-pendente` mede). Ligar
 * o envio por causa desta spec trocaria o ambiente da suíte inteira. Ela
 * confere a própria precondição e falha em voz alta, em vez de se pular.
 *
 * Para rodar:
 *   RESEND_API_KEY=re_e2e_placeholder_nao_e_segredo RESEND_FROM_EMAIL=lgpd@clinica.test \
 *   RESEND_BASE_URL=http://127.0.0.1:47899 pnpm test:e2e lgpd-pedido-entregue-por-email
 *
 * Evidência visual em `.superpowers/evidence/lgpd-export/entregue/`.
 */
import * as fs from "node:fs";
import * as http from "node:http";

import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import {
  aprovarPelaTela,
  baixarPdfDaTela,
  criarPedido,
  drenarAteSairDeProcessando,
  servico,
} from "./helpers/lgpd-pedido";

const PASTA = ".superpowers/evidence/lgpd-export/entregue";
const TITULAR = "titular.e2e@paciente.test";

type Recebido = { caminho: string; corpo: { to?: string[] | string; subject?: string; html?: string; text?: string } };
const recebidos: Recebido[] = [];
let receptor: http.Server;

test.beforeAll(async () => {
  const base = process.env.RESEND_BASE_URL ?? "";
  expect(
    /^http:\/\/127\.0\.0\.1:\d+$/.test(base) && !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM_EMAIL,
    "esta spec precisa do servidor de pé com RESEND_BASE_URL local, RESEND_API_KEY e RESEND_FROM_EMAIL (ver o cabeçalho)",
  ).toBe(true);

  receptor = http.createServer((req, res) => {
    let bruto = "";
    req.on("data", (pedaco) => (bruto += pedaco));
    req.on("end", () => {
      recebidos.push({ caminho: req.url ?? "", corpo: JSON.parse(bruto || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "e2e-mensagem-1" }));
    });
  });
  await new Promise<void>((ok) => receptor.listen(Number(new URL(base).port), "127.0.0.1", ok));
});

test.afterAll(async () => {
  await new Promise((ok) => receptor?.close(ok));
});

test("pedido com e-mail de entrega é enviado ao titular e conclui", async ({ page }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(PASTA, { recursive: true });
  const creds = lerCreds() as ReturnType<typeof lerCreds> & { org_id: string };
  const banco = servico();
  const pedidoId = await criarPedido(banco, creds.org_id, "Titular Com Email E2E", TITULAR);

  await loginComoAdmin(page, creds);
  await aprovarPelaTela(page, pedidoId, PASTA);

  const status = await drenarAteSairDeProcessando(page, banco, pedidoId);
  expect(status).toBe("completed");

  // O que CHEGOU ao receptor: um e-mail, para o titular, com o link do relatório.
  const emails = recebidos.filter((r) => r.caminho.startsWith("/emails"));
  expect(emails, "o titular tem de receber exatamente um e-mail").toHaveLength(1);
  const email = emails[0]!.corpo;
  expect([email.to].flat()).toEqual([TITULAR]);
  expect(email.subject).toContain(pedidoId.slice(0, 8));
  const link = /https?:\/\/[^\s"]+report\.pdf[^\s"]*/.exec(email.text ?? "")?.[0];
  expect(link, "o e-mail não traz o link do relatório").toBeTruthy();
  const doEmail = await page.request.get(link!);
  expect(doEmail.status()).toBe(200);
  expect((await doEmail.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  fs.writeFileSync(
    `${PASTA}/email-recebido.json`,
    JSON.stringify({ to: email.to, subject: email.subject, text: email.text }, null, 2),
  );

  await page.reload();
  await expect(page.getByText("Concluído", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await baixarPdfDaTela(page);
  await expect(page.getByText("lgpd.export_generated")).toBeVisible();
  await expect(page.getByText("lgpd.export_delivered")).toBeVisible();
  await page.screenshot({ path: `${PASTA}/4-concluido.png`, fullPage: true });

  await page.goto("/app/lgpd/requests");
  await expect(page.getByRole("row").filter({ hasText: pedidoId.slice(0, 8) })).toContainText("Concluído", {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${PASTA}/5-lista-concluido.png`, fullPage: true });
});
