/**
 * [P1] O horário de envio dos follow-ups tem porta.
 *
 * A janela de envio (`settings.followups.bloqueios.janela`) era respeitada pelo
 * executor desde a migration 0265 e escrita por ninguém: sem ela, um lead que
 * parava de responder às 20h recebia a primeira cobrança às 23h, e o único
 * jeito de limitar era `UPDATE` à mão no Postgres.
 *
 * Esta spec prova o caminho como o dono da clínica faria: entra em Follow-ups
 * pelo menu, liga o horário, ajusta, salva e recarrega — o estado tem de voltar
 * do banco. Cobre também quem só lê (agent vê o quadro travado).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "horario-de-envio");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const precisa = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager || !c.users?.agent;
  };
  if (precisa()) execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

function dia(page: Page, rotulo: string) {
  return page.getByTestId("horario-de-envio").getByRole("button", { name: rotulo, exact: true });
}

test.describe("follow-ups — horário de envio", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  test.afterAll(async ({ browser }) => {
    // Devolve a org ao padrão do produto (sem limite) para não mudar o que as
    // specs seguintes medem.
    const page = await browser.newPage();
    await login(page, creds.users.manager!.email);
    await page.request.patch("/api/v1/settings/followups/horario", { data: { janela: null } });
    await page.close();
  });

  test("manager liga o horário pela tela e o estado volta do banco", async ({ page }) => {
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await login(page, creds.users.manager!.email);

    // A porta: pelo menu, não pela URL digitada.
    await page.getByRole("link", { name: "Follow-ups" }).first().click();
    await page.waitForURL(/\/app\/ai\/followups/);

    const quadro = page.getByTestId("horario-de-envio");
    const chave = quadro.getByRole("switch", { name: "Limitar horário de envio" });
    await expect(quadro).toContainText("Sem limite");
    await expect(chave).toHaveAttribute("aria-checked", "false");

    // Ligar já traz 8h–21h todos os dias.
    await chave.click();
    await expect(page.locator("#horario_inicio")).toHaveValue("08:00");
    await expect(page.locator("#horario_fim")).toHaveValue("21:00");
    for (const d of ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]) {
      await expect(dia(page, d)).toHaveAttribute("aria-pressed", "true");
    }

    // Horário impossível é avisado e não salva.
    await page.locator("#horario_fim").fill("07:00");
    await expect(quadro).toContainText("O fim precisa ser depois do início.");
    await expect(quadro.getByRole("button", { name: "Salvar" })).toBeDisabled();

    await page.locator("#horario_fim").fill("20:30");
    await dia(page, "Dom").click();
    await expect(dia(page, "Dom")).toHaveAttribute("aria-pressed", "false");
    await page.screenshot({ path: path.join(EVIDENCIA, "01-antes-de-salvar.png"), fullPage: true });

    await quadro.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Horário de envio salvo.")).toBeVisible();

    // Recarrega: o que aparece agora veio do banco, não do estado do React.
    await page.reload();
    await expect(chave).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#horario_inicio")).toHaveValue("08:00");
    await expect(page.locator("#horario_fim")).toHaveValue("20:30");
    await expect(dia(page, "Dom")).toHaveAttribute("aria-pressed", "false");
    await expect(dia(page, "Seg")).toHaveAttribute("aria-pressed", "true");
    await expect(quadro.getByRole("button", { name: "Salvar" })).toHaveCount(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "02-depois-do-reload.png"), fullPage: true });
  });

  test("agent vê o horário, mas não muda", async ({ page }) => {
    await login(page, creds.users.agent!.email);
    await page.goto("/app/ai/followups");
    const quadro = page.getByTestId("horario-de-envio");
    await expect(quadro.getByRole("switch", { name: "Limitar horário de envio" })).toBeDisabled();
    await expect(quadro.getByRole("button", { name: "Salvar" })).toHaveCount(0);

    const res = await page.request.patch("/api/v1/settings/followups/horario", { data: { janela: null } });
    expect(res.status()).toBe(403);
  });
});
