/**
 * Gatilho "Quando um contato ganhar um telefone" + ação "Enviar e-mail"
 * (portes do upstream #2861 e #2794), montados pela TELA.
 *
 * O que a spec prova, numa instalação fresca SEM `RESEND_API_KEY` (o estado de
 * um primeiro deploy):
 *
 *   1. o editor de regras oferece o gatilho novo e a ação nova, e salva;
 *   2. a ficha que estava sem número ganha um (PATCH da ficha, o mesmo que a
 *      tela do contato faz) e a regra RODA, uma vez;
 *   3. a aba Atividade diz que o e-mail NÃO saiu porque a instalação não tem
 *      serviço de e-mail, e não diz "Sucesso";
 *   4. trocar o número de quem já tinha não dispara de novo.
 *
 * Deixa o estado como encontrou: apaga a regra e o contato no `finally`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
const ts = Date.now();
const RULE_NAME = `E2E Telefone ganho ${ts}`;

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function drenar(request: APIRequestContext): Promise<void> {
  const segredo = carregarEnvLocal().INTERNAL_SECRET?.trim();
  if (!segredo) throw new Error("INTERNAL_SECRET não encontrado no ambiente de teste");
  for (let i = 0; i < 3; i++) {
    const r = await request.post(`${APP_URL}/api/v1/cron/event-log-drain`, {
      headers: { Authorization: `Bearer ${segredo}` },
      timeout: 60_000,
    });
    expect(r.ok()).toBeTruthy();
  }
}

async function execucoesDaRegra(page: Page): Promise<number> {
  const resposta = await page.request.get(`${APP_URL}/api/v1/automation-rules/runs?limit=50`);
  expect(resposta.ok()).toBeTruthy();
  const corpo = (await resposta.json()) as { data: Array<{ automation_rules: { name: string } | null }> };
  return corpo.data.filter((r) => r.automation_rules?.name === RULE_NAME).length;
}

test.describe("contato ganhou telefone → Enviar e-mail, sem serviço de e-mail", () => {
  test.setTimeout(180_000);
  test.use({ actionTimeout: 15_000 });

  test("a regra roda uma vez e a Atividade diz que o e-mail não saiu, e por quê", async ({ page, request }) => {
    let ruleId: string | undefined;
    let contactId: string | undefined;
    try {
      await login(page, creds.users.manager!.email);
      await page.goto(`${APP_URL}/app/webhooks`);
      await page.getByRole("tab", { name: "Automações" }).click();
      await page.getByRole("button", { name: /Nova automação/ }).click();
      await page.locator("#rule-name").fill(RULE_NAME);

      const editor = page.getByRole("dialog");
      await editor.getByRole("combobox").first().click();
      await page.getByRole("option", { name: "Quando um contato ganhar um telefone" }).click();

      await editor.getByRole("combobox").filter({ hasText: "Adicionar ação" }).click();
      await page.getByRole("option", { name: "Enviar e-mail" }).click();

      await editor.getByRole("combobox").filter({ hasText: "E-mail do contato" }).click();
      await page.getByRole("option", { name: "Endereço fixo" }).click();
      await editor.getByPlaceholder("nome@empresa.com").fill("recepcao@clinica.test");
      await editor.getByPlaceholder("Seu horário com {{nome}}").fill("Novo telefone de {{nome}}");
      await editor.getByPlaceholder("Oi {{nome}}, tudo bem?").fill("O contato {{nome}} informou o telefone {{telefone}}.");
      await expect(editor.getByText(/serviço de e-mail desta instalação/)).toBeVisible();
      fs.mkdirSync(EVIDENCIA, { recursive: true });
      await page.screenshot({ path: path.join(EVIDENCIA, "telefone-ganho-email-editor.png"), fullPage: true });

      const [salvo] = await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/v1/automation-rules") && r.request().method() === "POST"),
        page.getByRole("button", { name: "Criar automação" }).click(),
      ]);
      expect(salvo.ok(), await salvo.text()).toBeTruthy();
      ruleId = ((await salvo.json()) as { data: { id: string } }).data.id;

      await page.getByLabel(new RegExp(`Ligar ${RULE_NAME}`)).click();
      await expect(page.getByText("Automação ligada.")).toBeVisible({ timeout: 15_000 });

      // A ficha nasce SEM telefone e ganha um pelo PATCH (o mesmo da tela).
      const criado = await page.request.post(`${APP_URL}/api/v1/contacts`, {
        data: { name: `Paciente Fictícia ${ts}` },
      });
      expect(criado.ok(), await criado.text()).toBeTruthy();
      contactId = ((await criado.json()) as { data: { contact: { id: string } } }).data.contact.id;
      const fone = `+5511977${String(ts).slice(-6)}`;
      const ganhou = await page.request.patch(`${APP_URL}/api/v1/contacts/${contactId}`, {
        data: { phone_number: fone },
      });
      expect(ganhou.ok(), await ganhou.text()).toBeTruthy();

      let execucoes = 0;
      for (let i = 0; i < 10 && execucoes === 0; i++) {
        await drenar(request);
        execucoes = await execucoesDaRegra(page);
      }
      expect(execucoes, "a regra não rodou ao contato ganhar telefone").toBe(1);

      await page.getByRole("tab", { name: "Atividade" }).click();
      await expect(page.getByText(RULE_NAME, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(/Nenhum serviço de e-mail está configurado/).first()).toBeVisible();
      await page.screenshot({ path: path.join(EVIDENCIA, "telefone-ganho-email-atividade.png"), fullPage: true });

      // Trocar o número de quem já tinha não é "ganhar": nenhuma execução nova.
      const trocou = await page.request.patch(`${APP_URL}/api/v1/contacts/${contactId}`, {
        data: { phone_number: `+5511966${String(ts).slice(-6)}` },
      });
      expect(trocou.ok()).toBeTruthy();
      await drenar(request);
      expect(await execucoesDaRegra(page)).toBe(1);
    } finally {
      if (ruleId) await page.request.delete(`${APP_URL}/api/v1/automation-rules/${ruleId}`).catch(() => undefined);
      if (contactId) await page.request.delete(`${APP_URL}/api/v1/contacts/${contactId}`).catch(() => undefined);
    }
  });
});
