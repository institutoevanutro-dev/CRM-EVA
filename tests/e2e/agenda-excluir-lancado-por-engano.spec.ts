import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { escolherDiaDesenhado, irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";
import { esperarAgenda } from "./helpers/tela-agenda";

/**
 * EXCLUIR UM AGENDAMENTO LANÇADO POR ENGANO, PELA TELA (migration 0364).
 *
 * A jornada de quem administra a clínica: marca um horário de teste, abre o
 * detalhe, exclui com motivo. O que tem de acontecer, medido na tela:
 *   - o card some da grade;
 *   - a linha some de TODAS as abas (Próximos, Aguardando confirmação,
 *     Passados e Cancelados), inclusive de Cancelados, que é a diferença entre
 *     excluir e cancelar;
 *   - o mesmo horário volta a ser oferecido ao marcar;
 *   - e a linha continua no banco, com o motivo (o detalhe pelo id responde).
 *
 * Quem exclui é o `manager` das credenciais de teste: o piso da rota.
 */
const RAIZ = path.resolve(__dirname, "../..");
const EVIDENCIA = path.join(RAIZ, ".superpowers/evidence/agenda-excluir-lancado-por-engano");

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  agenda?: { tipo_nome: string; tipo_slug: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c;
}

async function entrar(page: Page, creds: Creds): Promise<string[]> {
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
  await page.goto("/app/agenda");
  await esperarAgenda(page, 20_000);
  return irParaASemanaSeguinte(page);
}

/** Abre o painel, escolhe o tipo e o dia, e devolve o primeiro horário oferecido. */
async function primeiroHorarioOferecido(page: Page, tipoNome: string, dias: readonly string[]) {
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: new RegExp(`^${tipoNome}`) }).click();
  await escolherDiaDesenhado(page, dias);
  const horario = page.locator('[data-testid^="horario-"]').first();
  await expect(horario).toBeVisible({ timeout: 15_000 });
  return horario;
}

const idsNaGrade = (page: Page) =>
  page
    .locator('[data-testid="grade-da-agenda"] [data-testid^="agendamento-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.slice("agendamento-".length)));

test.describe.configure({ timeout: 150_000 });

test("excluir pela tela: some da grade e de todas as listas, o horário volta, e a linha fica com o motivo", async ({
  page,
}) => {
  const creds = lerCreds();
  const tipo = creds.agenda!.tipo_nome;
  const dias = await entrar(page, creds);
  const antes = new Set(await idsNaGrade(page));

  // ── 1. Marca o agendamento de teste ────────────────────────────────────
  const horario = await primeiroHorarioOferecido(page, tipo, dias);
  const rotulo = (await horario.getAttribute("data-testid"))!.replace("horario-", "");
  await horario.click();
  await page.getByTestId("confirmar-marcacao").click();
  await expect(page.getByTestId("ver-na-agenda")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");

  let id = "";
  await expect
    .poll(async () => (id = (await idsNaGrade(page)).find((x) => !antes.has(x)) ?? ""), {
      timeout: 20_000,
      message: "o agendamento recém-marcado não apareceu na grade",
    })
    .not.toBe("");
  const historico = page.getByTestId("historico-da-agenda");
  await historico.getByTestId("aba-proximos").click();
  await expect(historico.getByTestId(`linha-${id}`)).toBeVisible({ timeout: 15_000 });

  // ── 2. Abre o detalhe e exclui ─────────────────────────────────────────
  await page.getByTestId(`agendamento-${id}`).click();
  await page.getByTestId("excluir-compromisso").click();
  const dialogo = page.getByRole("alertdialog");
  await expect(dialogo).toBeVisible({ timeout: 10_000 });
  await expect(dialogo).toContainText("teste ou lançado por engano");
  await expect(dialogo).toContainText('use "Cancelar agendamento"');
  // A caixa tem altura de verdade (não um diálogo de altura zero).
  const caixa = await dialogo.boundingBox();
  expect(caixa?.height ?? 0).toBeGreaterThan(150);
  await page.screenshot({ path: path.join(EVIDENCIA, "1-dialogo.png") });

  const confirmar = page.getByTestId("confirmar-exclusao");
  await expect(confirmar, "aceitou excluir sem motivo").toBeDisabled();
  await page.getByLabel("Motivo da exclusão").fill("ab");
  await expect(confirmar, "dois caracteres passam, e a rota exige três").toBeDisabled();
  await page.getByLabel("Motivo da exclusão").fill("agendamento de teste do sistema");
  await confirmar.click();
  await expect(dialogo).toBeHidden({ timeout: 15_000 });

  // ── 3. Some da grade e de TODAS as abas ────────────────────────────────
  await expect(page.getByTestId(`agendamento-${id}`), "o card continuou na grade").toHaveCount(0, {
    timeout: 20_000,
  });
  for (const aba of ["proximos", "aguardando", "passados", "cancelados"]) {
    await historico.getByTestId(`aba-${aba}`).click();
    await expect(historico.getByTestId(`linha-${id}`), `ainda aparece na aba ${aba}`).toHaveCount(0);
  }
  await page.screenshot({ path: path.join(EVIDENCIA, "2-sumiu-da-agenda.png"), fullPage: true });

  // ── 4. O horário volta a ser oferecido ─────────────────────────────────
  const deNovo = await primeiroHorarioOferecido(page, tipo, dias);
  await expect(deNovo, "o horário do excluído não voltou a ficar livre").toHaveAttribute(
    "data-testid",
    `horario-${rotulo}`,
  );
  await page.keyboard.press("Escape");

  // ── 5. A linha fica no banco, com quem e por quê ───────────────────────
  const detalhe = await page.request.get(`/api/v1/agenda/agendamentos/${id}`);
  expect(detalhe.status()).toBe(200);
  const { data } = (await detalhe.json()) as {
    data: { status: string; excluded_at: string | null; exclusion_reason: string | null };
  };
  expect(data).toMatchObject({ status: "cancelled", exclusion_reason: "agendamento de teste do sistema" });
  expect(data.excluded_at).toBeTruthy();
});
