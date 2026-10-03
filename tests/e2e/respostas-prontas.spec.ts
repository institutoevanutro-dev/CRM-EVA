/**
 * PERGUNTAS FREQUENTES — provadas pela tela, como o gestor da clínica as usa.
 *
 * Estado de primeiro deploy: o `.env.e2e` do CI não tem chave da OpenAI. Então a
 * forma de perguntar SALVA, e a tela tem de DIZER que ela ainda não é
 * reconhecida (e oferecer "Calcular agora"). Com chave, a tela não pode dizer
 * isso. O spec confere a verdade no banco antes de afirmar qualquer coisa — os
 * dois estados são legítimos, mentir sobre qualquer um deles não é.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3032 pnpm exec playwright test tests/e2e/respostas-prontas.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/respostas-prontas");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const PREFIXO = "FAQ E2E";
const TITULO = `${PREFIXO} preço da limpeza ${Date.now()}`;
let creds: Creds;

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

async function limpar(): Promise<void> {
  await admin.from("respostas_prontas").delete().eq("organization_id", creds.org_id).like("titulo", `${PREFIXO}%`);
  await admin.from("respostas_prontas_config").delete().eq("organization_id", creds.org_id);
}

const cartao = (page: Page) => page.getByTestId("resposta-pronta").filter({ hasText: TITULO });

test.describe("Perguntas frequentes — o gestor cadastra, liga e revisa", () => {
  test.describe.configure({ timeout: 180_000, mode: "serial" });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limpar();
  });

  test.afterAll(async () => {
    await limpar();
  });

  test("nasce desligada, cadastra e diz a verdade sobre o reconhecimento", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/perguntas-frequentes");
    await expect(page.getByRole("heading", { level: 1, name: "Perguntas frequentes" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page).toHaveTitle(/Perguntas frequentes/);
    await expect(page.getByRole("switch", { name: "Responder sem IA" })).toHaveAttribute("aria-checked", "false");

    await page.getByRole("button", { name: "Nova pergunta frequente" }).click();
    await page.getByLabel("Título").fill(TITULO);
    await page.getByLabel("Resposta", { exact: true }).fill("A limpeza custa R$ 180,00.");
    await page
      .getByLabel("Formas de perguntar (uma por linha)")
      .fill("Quanto custa a limpeza?\nQual o valor da limpeza?");
    await page.getByRole("button", { name: "Salvar", exact: true }).click();

    await expect(cartao(page)).toBeVisible({ timeout: 30_000 });
    await expect(cartao(page)).toContainText("Revisada em");
    await expect(cartao(page)).toContainText("Quanto custa a limpeza?");

    const { data: item } = await admin
      .from("respostas_prontas")
      .select("id")
      .eq("organization_id", creds.org_id)
      .eq("titulo", TITULO)
      .single();
    const { data: perguntas } = await admin
      .from("respostas_prontas_perguntas")
      .select("modelo_embedding")
      .eq("resposta_pronta_id", (item as { id: string }).id);
    const reconhecidas = ((perguntas as Array<{ modelo_embedding: string | null }>) ?? []).filter(
      (p) => p.modelo_embedding !== null,
    ).length;
    if (reconhecidas === 2) {
      await expect(cartao(page).getByText("não reconhecida")).toHaveCount(0);
    } else {
      await expect(cartao(page).getByText("não reconhecida").first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Calcular agora" })).toBeVisible();
      await page.getByRole("button", { name: "Calcular agora" }).click();
      await expect(
        page.getByText("Não foi possível calcular agora. Confira a chave da OpenAI em Credenciais."),
      ).toBeVisible({ timeout: 30_000 });
    }
    // Medição do período: nasce em zero numa clínica que nunca respondeu pronto.
    await expect(page.getByTestId("rp-resolvidas")).toHaveText("0");
    await captura(page, "cadastrada");
  });

  test("liga, aperta o rigor, e a escolha sobrevive ao recarregar", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/perguntas-frequentes");
    const chave = page.getByRole("switch", { name: "Responder sem IA" });
    await expect(chave).toBeVisible({ timeout: 60_000 });
    await chave.click();
    await page.getByLabel("Rigor do reconhecimento").fill("0.88");
    await page.getByRole("button", { name: "Salvar configuração" }).click();
    await expect(page.getByText("Configuração salva.")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("switch", { name: "Responder sem IA" })).toHaveAttribute("aria-checked", "true", {
      timeout: 30_000,
    });
    await expect(page.getByLabel("Rigor do reconhecimento")).toHaveValue("0.88");
    await captura(page, "ligada");
  });

  test("desativa e reativa, e marcar como revisada não some com a pergunta", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/perguntas-frequentes");
    await expect(cartao(page)).toBeVisible({ timeout: 60_000 });
    await cartao(page).getByRole("button", { name: "Desativar" }).click();
    await expect(cartao(page)).toContainText("Desativada");
    await cartao(page).getByRole("button", { name: "Reativar" }).click();
    await expect(cartao(page)).toContainText("Ativa");
    await cartao(page).getByRole("button", { name: "Marcar como revisada" }).click();
    await expect(cartao(page)).toContainText("Revisada em");
    await captura(page, "revisada");
  });

  test("atendente (agent) não chega à tela", async ({ page }) => {
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto("/app/ai/perguntas-frequentes");
    await page.waitForURL(/\/403/, { timeout: 30_000 });
  });
});
