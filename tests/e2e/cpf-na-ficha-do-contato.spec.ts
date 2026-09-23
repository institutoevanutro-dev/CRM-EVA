/**
 * VER O CPF NA FICHA DO CONTATO — pela tela, como quem atende faria.
 *
 * O CPF é guardado cifrado (migration 0274) e a ficha só sabia dizer que
 * "existe CPF": o número não aparecia em tela nenhuma, porque a função de
 * leitura (`decrypt_cpf`, 0275) não existia. Este spec prova o caminho inteiro
 * pelo front: cadastrar um contato com CPF, abrir a ficha, ver o número
 * mascarado, clicar em "Ver CPF" e ler o número formatado.
 *
 * Prova junto as duas coisas que dão o valor à feature e não se veem no número:
 *   - o CPF NÃO vem no carregamento da ficha (só depois do clique) — quem abre
 *     uma conversa não arrasta dado sensível para o browser sem pedir;
 *   - o registro da consulta (`contact.cpf_viewed`) fica no audit log — medido
 *     no unit, porque ler o audit pela API é de administrador de plataforma.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  org_id: string;
  password: string;
  users: Record<string, { email: string }>;
}

function lerCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.users?.manager) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

const creds = lerCreds();

/** CPF válido de teste (dígitos verificadores corretos) e nome único por execução. */
const CPF = "52998224725";
const CPF_FORMATADO = "529.982.247-25";
const sufixo = `${process.pid}`.slice(-6);
const NOME = `Paciente CPF ${sufixo}`;

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

test("o CPF guardado cifrado aparece na ficha depois do clique — e não antes", async ({ page }) => {
  await login(page);

  const criado = await page.request.post("/api/v1/contacts", {
    data: { display_name: NOME, cpf: CPF, source: "manual" },
  });
  expect(criado.status(), "não deu para criar o contato com CPF").toBe(201);
  const corpo = (await criado.json()) as { data: { contact: { id: string } } };
  const contatoId = corpo.data.contact.id;

  // 1. A ficha carrega SEM o CPF no corpo da resposta — nem cru nem formatado.
  const semPedir = await page.request.get(`/api/v1/contacts/${contatoId}`);
  const texto = await semPedir.text();
  expect(texto, "o CPF veio sem ninguém pedir").not.toContain(CPF);

  await page.goto(`/app/contacts/${contatoId}`);
  await expect(page.getByText(NOME).first()).toBeVisible({ timeout: 20_000 });

  // 2. Na tela, o número está mascarado e há o botão.
  await expect(page.getByText("•••.•••.•••-••")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("cpf-revelado")).toHaveCount(0);

  // 3. O clique revela o CPF formatado.
  await page.getByRole("button", { name: /ver cpf/i }).click();
  await expect(
    page.getByTestId("cpf-revelado"),
    "o CPF tem de aparecer na ficha depois do clique",
  ).toHaveText(CPF_FORMATADO, { timeout: 20_000 });

  await page.screenshot({ path: "evidence/cpf/cpf-revelado-na-ficha.png", fullPage: true });

  // O registro da consulta (`contact.cpf_viewed`) é medido em
  // `tests/unit/cpf-na-ficha-quem-ve.test.ts`: a leitura do audit log pela API
  // é de administrador de PLATAFORMA, e o usuário deste spec é gerente do
  // tenant — pedir 403 aqui provaria só o 403.
});
