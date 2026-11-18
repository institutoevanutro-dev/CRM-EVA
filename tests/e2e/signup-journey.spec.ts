/**
 * E2E — jornada completa de criação de conta (usuário real, browser real):
 *
 * 1. /signup (com o EvaLink ligado, como no e2e, o login NÃO oferece "Criar
 *    conta": quem é da equipe criava uma clínica vazia — auditoria 17/11, item 52)
 * 2. preenche o formulário de signup e envia
 * 3. abre o e-mail de confirmação (Mailpit) e clica no link
 * 4. cai autenticado no onboarding (tenant provisionado)
 * 5. sai e entra de novo com as credenciais criadas
 *
 * Pré-requisitos: Supabase local com Mailpit + app `next start` (ver README
 * da suíte / playwright.config.ts).
 */
import { test, expect } from "@playwright/test";

import { waitForEmail, extractAuthConfirmLink, uniqueEmail } from "./helpers/auth";

test("criar conta: signup → e-mail de confirmação → onboarding → re-login", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail("signup");
  const password = "SenhaForte!123";

  // 1. Com o EvaLink ligado (o ambiente do e2e), o login não oferece "Criar
  //    conta" (item 52 da auditoria de 17/11): o cadastro continua em /signup.
  //    Sem EvaLink e com cadastro aberto o link segue lá — coberto em
  //    `tests/unit/login-entrada-sessao-e-evalink.test.tsx`.
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Entrar com o EvaLink" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Criar conta" })).toHaveCount(0);
  await page.goto("/signup");
  await expect(page).toHaveURL(/\/signup$/);

  // 2. Formulário de signup
  await page.getByLabel("Nome da empresa").fill("Loja E2E Signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await page.getByLabel("Confirmar senha").fill(password);
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page.getByText("Confirme seu e-mail")).toBeVisible();

  // 3. Abre o e-mail real no Mailpit e segue o link
  const html = await waitForEmail(email, "Confirme seu e-mail");
  const link = extractAuthConfirmLink(html, baseURL!);
  await page.goto(link);

  // 4. Autenticado no onboarding — tenant provisionado
  await expect(page).toHaveURL(/\/onboarding\/welcome/);
  await expect(page.getByText("Boas-vindas ao DeskcommCRM")).toBeVisible();
  await expect(page.getByText("Loja E2E Signup")).toBeVisible();

  // 5. Sai (limpa sessão) e entra de novo com as credenciais criadas
  await context.clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/(app|onboarding)\//, { timeout: 30_000 });
  await expect(page).not.toHaveURL(/\/login/);
});
