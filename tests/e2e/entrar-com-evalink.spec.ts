/**
 * Entrar pela Conta EvaLink, pela tela, contra o Supabase local de verdade.
 *
 * A Conta é a falsa de `tests/helpers/conta-falsa.ts`, que o `playwright.config.ts`
 * sobe na porta 47812 (segundo `webServer`) e que o `.env.e2e` liga ao CRM. Ela
 * aprova na hora e devolve sempre a mesma pessoa: `sub` fixo, e-mail
 * `pessoa@eva.test` (fora do domínio do seed), papel `agent`.
 *
 * O que só este arquivo prova, porque depende do GoTrue real:
 *  1. a página 200 da volta grava o cookie de sessão e `/app` abre para a pessoa
 *     nova, que cai SÓ na organização padrão (nenhuma organização pessoal criada);
 *  2. o aviso `desligado` derruba a sessão (recarregar `/app` leva a `/login`) e
 *     o banimento barra a senha no próprio GoTrue;
 *  3. entrar de novo pelo EvaLink levanta o banimento, na mesma organização;
 *  4. aviso com assinatura errada responde 401;
 *  5. usuário do seed, que não está ligado, segue entrando por senha.
 *
 * A organização padrão não existe no seed: é criada aqui com o id fixo que o
 * `.env.e2e` põe em `EVALINK_ORG_PADRAO`. A pessoa da Conta falsa é apagada no
 * começo, para que o caso 1 seja sempre a entrada de alguém novo.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { cabecalhoDeAviso } from "../../lib/evalink/aviso";
import { lerCreds } from "./helpers/login-admin";

const SUB = "11111111-1111-4111-8111-111111111111";
const EMAIL = "pessoa@eva.test";
const ORG_PADRAO = process.env.EVALINK_ORG_PADRAO ?? "";
const SEGREDO = process.env.EVALINK_SEGREDO_AVISO ?? "";
const EVIDENCIA = ".superpowers/evidence/entrar-com-evalink";

const c = credenciaisSupabaseDeTeste();
const db = createClient(c.url, c.serviceRole, { auth: { persistSession: false } });

async function vinculadoId(): Promise<string> {
  const { data, error } = await db
    .from("evalink_vinculos")
    .select("user_id")
    .eq("evalink_sub", SUB)
    .single();
  if (error || !data)
    throw new Error(`vínculo da pessoa da Conta falsa não achado: ${error?.message}`);
  return (data as { user_id: string }).user_id;
}

/** auth.sessions não passa pela REST: conta direto no Postgres local. */
async function sessoesNoGoTrue(userId: string): Promise<number> {
  const cliente = new pg.Client({ connectionString: c.dbUrl });
  await cliente.connect();
  try {
    const r = await cliente.query(
      "select count(*)::int as n from auth.sessions where user_id = $1",
      [userId],
    );
    return (r.rows[0] as { n: number }).n;
  } finally {
    await cliente.end();
  }
}

async function vinculosAtivos(userId: string) {
  const { data, error } = await db
    .from("user_organizations")
    .select("organization_id, role")
    .eq("user_id", userId)
    .is("revoked_at", null);
  if (error) throw new Error(error.message);
  return data as { organization_id: string; role: string }[];
}

/** Clica no botão e devolve a resposta da volta, já com o navegador em /app. */
async function entrarPeloEvalink(page: Page) {
  await page.goto("/login");
  const botao = page.getByRole("link", { name: "Entrar com o EvaLink" });
  await expect(botao).toBeVisible();
  const volta = page.waitForResponse((r) => new URL(r.url()).pathname === "/evalink/volta");
  await botao.click();
  const resposta = await volta;
  await page.waitForURL((u) => u.pathname === "/app" || u.pathname.startsWith("/app/"), {
    timeout: 20_000,
  });
  return resposta;
}

async function enviarAviso(page: Page, segredo: string, motivo = "desligado") {
  const id = randomUUID();
  const corpo = JSON.stringify({ id, sub: SUB, motivo, modulo: "crm" });
  return page.request.post("/evalink/aviso", {
    data: corpo,
    headers: {
      "content-type": "application/json",
      "x-evalink-assinatura": cabecalhoDeAviso(segredo, corpo, id),
    },
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  expect(["127.0.0.1", "localhost"]).toContain(new URL(c.dbUrl).hostname);
  expect(ORG_PADRAO, "EVALINK_ORG_PADRAO ausente: rode `pnpm e2e:env`").toMatch(/^[0-9a-f-]{36}$/);
  expect(
    SEGREDO.length,
    "EVALINK_SEGREDO_AVISO ausente: rode `pnpm e2e:env`",
  ).toBeGreaterThanOrEqual(32);

  const org = await db.from("organizations").upsert(
    {
      id: ORG_PADRAO,
      slug: "e2e-evalink-org",
      display_name: "E2E EvaLink Org",
      legal_name: "E2E EvaLink Org",
      timezone: "America/Sao_Paulo",
      locale: "pt-BR",
      status: "active",
      onboarded_at: new Date().toISOString(),
    } as never,
    { onConflict: "id" },
  );
  if (org.error) throw new Error(`organização padrão: ${org.error.message}`);

  // Rodada anterior deixou a pessoa (ligada ou não): apaga, e o caso 1 volta a ser entrada nova.
  const lista = await db.auth.admin.listUsers({ perPage: 1000 });
  if (lista.error) throw new Error(lista.error.message);
  for (const u of lista.data.users.filter((u) => u.email?.toLowerCase() === EMAIL)) {
    const del = await db.auth.admin.deleteUser(u.id);
    if (del.error) throw new Error(`apagar ${EMAIL}: ${del.error.message}`);
  }
  fs.mkdirSync(EVIDENCIA, { recursive: true });
});

test("entra pelo EvaLink, o aviso desligado derruba e bane, e entrar de novo religa", async ({
  page,
}) => {
  test.setTimeout(120_000);
  let userId = "";

  await test.step("a volta responde 200 com o cookie de sessão e /app abre na organização padrão", async () => {
    const volta = await entrarPeloEvalink(page);
    expect(volta.status()).toBe(200);
    const setCookie = (await volta.headersArray())
      .filter((h) => h.name.toLowerCase() === "set-cookie")
      .map((h) => h.value.split("=")[0]);
    expect(
      setCookie.some((n) => n?.startsWith("sb-deskcomm-auth")),
      `Set-Cookie da volta: ${setCookie}`,
    ).toBe(true);
    const cookies = await page.context().cookies();
    expect(cookies.some((k) => k.name.startsWith("sb-deskcomm-auth"))).toBe(true);
    await expect(page.getByRole("heading", { name: "Início" })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${EVIDENCIA}/01-app-depois-do-evalink.png`, fullPage: true });

    userId = await vinculadoId();
    expect(await vinculosAtivos(userId)).toEqual([{ organization_id: ORG_PADRAO, role: "agent" }]);
    expect(await sessoesNoGoTrue(userId)).toBeGreaterThan(0);
  });

  await test.step("aviso desligado: 200, a sessão some do GoTrue e recarregar /app leva a /login", async () => {
    const r = await enviarAviso(page, SEGREDO);
    expect(r.status()).toBe(200);
    expect(await sessoesNoGoTrue(userId)).toBe(0);
    await page.goto("/app");
    await page.waitForURL(/\/login/, { timeout: 20_000 });
    await page.screenshot({ path: `${EVIDENCIA}/02-login-depois-do-aviso.png`, fullPage: true });
  });

  await test.step("desligada, a senha não entra: o GoTrue recusa por banimento", async () => {
    // O aviso trocou a senha por uma aleatória. Uma senha conhecida, posta pela API admin
    // (que não mexe no banimento), separa as duas barreiras: se o GoTrue ainda aceitasse
    // a senha, a recusa viria só da regra de reserva do CRM.
    const senha = `E2E!${randomUUID()}`;
    const upd = await db.auth.admin.updateUserById(userId, { password: senha });
    expect(upd.error).toBeNull();

    const direto = await fetch(`${c.url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: c.anonKey, "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: senha }),
    });
    const corpo = (await direto.json()) as { error_code?: string };
    expect(direto.status).toBe(400);
    expect(corpo.error_code).toBe("user_banned");

    await page.goto("/login");
    await page.locator("#email").fill(EMAIL);
    await page.locator("#password").fill(senha);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.getByText("Email ou senha incorretos.")).toBeVisible({ timeout: 15_000 });
    expect(new URL(page.url()).pathname).toBe("/login");
  });

  await test.step("entrar de novo pelo EvaLink levanta o banimento, na mesma organização", async () => {
    const volta = await entrarPeloEvalink(page);
    expect(volta.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Início" })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${EVIDENCIA}/03-app-na-segunda-entrada.png`, fullPage: true });

    const u = await db.auth.admin.getUserById(userId);
    const banidoAte =
      (u.data.user as { banned_until?: string | null } | null)?.banned_until ?? null;
    expect(banidoAte === null || new Date(banidoAte) <= new Date()).toBe(true);
    expect(await vinculadoId()).toBe(userId);
    expect(await vinculosAtivos(userId)).toEqual([{ organization_id: ORG_PADRAO, role: "agent" }]);
  });
});

test("aviso com assinatura errada responde 401", async ({ page }) => {
  const r = await enviarAviso(page, "x".repeat(48));
  expect(r.status()).toBe(401);
});

test("usuário do seed, que não está ligado, segue entrando por senha", async ({ page }) => {
  const creds = lerCreds();
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Entrar com o EvaLink" })).toBeVisible();
  await page.locator("#email").fill(creds.users.agent!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.waitForURL((u) => u.pathname === "/app" || u.pathname.startsWith("/app/"), {
    timeout: 20_000,
  });
});
