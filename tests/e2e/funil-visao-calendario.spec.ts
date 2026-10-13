/**
 * A visão Calendário do funil, pela tela (porte do upstream #2790).
 *
 * Um gestor abre um funil, troca para o Calendário, vê o negócio no dia da data
 * dele, muda de mês, passa para a semana, recarrega (a escolha fica) e volta ao
 * quadro. Depois, a mesma tela na largura de um celular.
 *
 * Funil PRÓPRIO: o padrão é de outras specs, e um campo de data a mais nele
 * mudaria o que elas veem.
 *
 * As datas saem do "hoje" de São Paulo (o fuso da organização do seed), para o
 * caso valer em qualquer dia em que rodar e com o runner em qualquer fuso.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const falta = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    return !(JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds).users?.manager;
  };
  if (falta()) execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SUFIXO = `${Date.now()}`.slice(-7);
// Fora de `evidence/` (versionada): prova visual não entra em commit.
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "funil-calendario");

/** `YYYY-MM-DD` de hoje em São Paulo, e o dia 15 deste mês e do próximo. */
const HOJE = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
const [ANO, MES] = HOJE.split("-").map(Number) as [number, number];
const dia15 = (meses: number) => new Date(Date.UTC(ANO, MES - 1 + meses, 15)).toISOString().slice(0, 10);
const NESTE_MES = dia15(0);
const NO_PROXIMO = dia15(1);
const nomeDoMes = (chave: string) =>
  new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${chave}T00:00:00Z`),
  );

const T_ESTE = `Avaliação ${SUFIXO} deste mês`;
const T_PROXIMO = `Retorno ${SUFIXO} do mês que vem`;
const T_SEM = `Contato ${SUFIXO} sem data`;

let funilId = "";

async function limpar(): Promise<void> {
  const { data } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("name", "Calendário E2E %");
  const ids = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (ids.length === 0) return;
  await admin.from("crm_lead_activities").delete().in("pipeline_id", ids);
  await admin.from("crm_leads").delete().in("pipeline_id", ids);
  await admin.from("crm_stages").delete().in("pipeline_id", ids);
  await admin.from("crm_pipelines").delete().in("id", ids);
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function abrirFunil(page: Page): Promise<void> {
  const [quadro] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/v1/pipelines/${funilId}/board` && r.request().method() === "GET",
    ),
    page.goto(`/app/pipelines/${funilId}`),
  ]);
  expect(quadro.status()).toBe(200);
}

test.describe("visão Calendário do funil", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test.beforeAll(async () => {
    await limpar();
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    const { data: funil, error } = await admin
      .from("crm_pipelines")
      .insert({
        organization_id: creds.org_id,
        name: `Calendário E2E ${SUFIXO}`,
        slug: `calendario-e2e-${SUFIXO}`,
        settings: { fields: [{ key: "data_avaliacao", label: "Data da avaliação", type: "date" }] },
      })
      .select("id")
      .single();
    if (error) throw new Error(`funil: ${error.message}`);
    funilId = (funil as { id: string }).id;

    const { data: etapa, error: erroEtapa } = await admin
      .from("crm_stages")
      .insert({
        organization_id: creds.org_id,
        pipeline_id: funilId,
        name: "Entrada",
        slug: `entrada-${SUFIXO}`,
        position: 1000,
      })
      .select("id")
      .single();
    if (erroEtapa) throw new Error(`etapa: ${erroEtapa.message}`);

    const base = {
      organization_id: creds.org_id,
      pipeline_id: funilId,
      stage_id: (etapa as { id: string }).id,
      source: "manual",
    };
    const { error: erroLeads } = await admin.from("crm_leads").insert([
      { ...base, title: T_ESTE, position_in_stage: 1000, custom_fields: { data_avaliacao: NESTE_MES } },
      { ...base, title: T_PROXIMO, position_in_stage: 2000, custom_fields: { data_avaliacao: NO_PROXIMO } },
      { ...base, title: T_SEM, position_in_stage: 3000, custom_fields: {} },
    ]);
    if (erroLeads) throw new Error(`leads: ${erroLeads.message}`);
  });

  test.afterAll(async () => {
    await limpar();
  });

  test("troca para o calendário, vê o negócio no dia certo, muda de mês e volta ao quadro", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page);
    await abrirFunil(page);

    // O quadro é a visão padrão, com os três negócios.
    for (const titulo of [T_ESTE, T_PROXIMO, T_SEM]) {
      await expect(page.getByRole("heading", { name: titulo })).toBeVisible({ timeout: 60_000 });
    }
    await expect(page.getByTestId("visao-quadro")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("calendario-do-funil")).toHaveCount(0);

    await page.getByRole("button", { name: "Calendário", exact: true }).click();
    const calendario = page.getByTestId("calendario-do-funil");
    await expect(calendario).toBeVisible();
    await expect(calendario).toHaveAttribute("data-fuso", "America/Sao_Paulo");
    await expect(page.getByRole("combobox", { name: "Campo de data" })).toHaveText("Data da avaliação");
    await expect(page.getByTestId("calendario-periodo")).toHaveText(nomeDoMes(NESTE_MES));

    // O negócio está na célula do dia 15, e só nela.
    await expect(page.getByTestId(`calendario-dia-${NESTE_MES}`).getByRole("button", { name: T_ESTE })).toBeVisible();
    await expect(calendario.getByRole("button", { name: T_ESTE })).toHaveCount(1);
    await expect(calendario.getByRole("button", { name: T_PROXIMO })).toHaveCount(0);
    // Quem não tem data não some: é contado.
    await expect(page.getByTestId("calendario-sem-data")).toHaveText("1 sem data neste campo");
    await page.screenshot({ path: path.join(EVIDENCIA, "01-mes-com-negocio.png") });

    // Medido, não a olho: a grade tem 7 colunas iguais e não estoura a tela.
    const medidas = await page.evaluate((dia) => {
      const celula = document.querySelector(`[data-testid="calendario-dia-${dia}"]`)!.getBoundingClientRect();
      const grade = document.querySelector(`[data-testid="calendario-dia-${dia}"]`)!.parentElement!.getBoundingClientRect();
      return {
        celula: celula.width,
        grade: grade.width,
        rolagemLateral: document.documentElement.scrollWidth - window.innerWidth,
      };
    }, NESTE_MES);
    expect(Math.abs(medidas.celula * 7 - medidas.grade)).toBeLessThan(8);
    expect(medidas.rolagemLateral).toBeLessThanOrEqual(0);

    // A lista dos sem data abre, e o clique leva à ficha do negócio.
    await page.getByTestId("calendario-sem-data").click();
    await page.getByTestId("calendario-lista").getByRole("button", { name: new RegExp(T_SEM) }).click();
    await expect(page.getByRole("dialog").getByText(T_SEM).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Mês seguinte: o outro negócio aparece, o primeiro sai.
    await page.getByRole("button", { name: "Próximo mês" }).click();
    await expect(page.getByTestId("calendario-periodo")).toHaveText(nomeDoMes(NO_PROXIMO));
    await expect(page.getByTestId(`calendario-dia-${NO_PROXIMO}`).getByRole("button", { name: T_PROXIMO })).toBeVisible();
    await expect(calendario.getByRole("button", { name: T_ESTE })).toHaveCount(0);

    // Dois meses para trás: mês sem ninguém, e a tela diz isso.
    await page.getByRole("button", { name: "Mês anterior" }).click();
    await page.getByRole("button", { name: "Mês anterior" }).click();
    await expect(page.getByTestId("calendario-vazio")).toHaveText(
      "Nenhum negócio com este campo de data neste período.",
    );
    await page.screenshot({ path: path.join(EVIDENCIA, "02-mes-vazio.png") });

    // Semana: 7 dias, a partir do domingo.
    await page.getByRole("button", { name: "Hoje" }).click();
    await page.getByRole("button", { name: "Semana", exact: true }).click();
    await expect(page.locator('[data-testid^="calendario-dia-"]')).toHaveCount(7);
    const primeiro = await page.locator('[data-testid^="calendario-dia-"]').first().getAttribute("data-testid");
    expect(new Date(`${primeiro!.replace("calendario-dia-", "")}T00:00:00Z`).getUTCDay()).toBe(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "03-semana.png") });

    // Recarregar: continua no calendário, na semana.
    await abrirFunil(page);
    await expect(page.getByTestId("calendario-do-funil")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("calendario-semana")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Mês", exact: true }).click();
    await expect(page.getByTestId(`calendario-dia-${NESTE_MES}`).getByRole("button", { name: T_ESTE })).toBeVisible();

    // O filtro da barra vale no calendário: buscar por um título tira o outro.
    await page.getByPlaceholder(/buscar/i).first().fill(T_SEM);
    await expect(calendario.getByRole("button", { name: T_ESTE })).toHaveCount(0);
    await expect(page.getByTestId("calendario-sem-data")).toHaveText("1 sem data neste campo");
    await page.getByPlaceholder(/buscar/i).first().fill("");
    await expect(calendario.getByRole("button", { name: T_ESTE })).toHaveCount(1);

    // De volta ao quadro: os cards de sempre, e a escolha fica guardada.
    await page.getByRole("button", { name: "Quadro", exact: true }).click();
    await expect(page.getByTestId("calendario-do-funil")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: T_ESTE })).toBeVisible();
    await abrirFunil(page);
    await expect(page.getByRole("heading", { name: T_ESTE })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("visao-quadro")).toHaveAttribute("aria-pressed", "true");
  });

  test("na largura de um celular: o dia mostra a contagem, a lista abre embaixo e nada estoura", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await login(page);
    await abrirFunil(page);
    await page.getByRole("button", { name: "Calendário", exact: true }).click();
    await expect(page.getByTestId("calendario-do-funil")).toBeVisible({ timeout: 60_000 });

    // No celular o chip não cabe na célula: o dia mostra quantos são.
    const contagem = page.getByTestId(`calendario-contagem-${NESTE_MES}`);
    await expect(contagem).toBeVisible();
    await expect(contagem).toHaveText("1");
    await expect(page.getByTestId(`calendario-dia-${NESTE_MES}`).getByRole("button", { name: T_ESTE })).toBeHidden();

    await contagem.click();
    await expect(page.getByTestId("calendario-lista").getByRole("button", { name: new RegExp(T_ESTE) })).toBeVisible();

    const medidas = await page.evaluate((dia) => {
      const celula = document.querySelector(`[data-testid="calendario-dia-${dia}"]`)!.getBoundingClientRect();
      const botao = document.querySelector(`[data-testid="calendario-contagem-${dia}"]`)!.getBoundingClientRect();
      return {
        rolagemLateral: document.documentElement.scrollWidth - window.innerWidth,
        celulaDentro: celula.left >= 0 && celula.right <= window.innerWidth,
        botaoDentroDaCelula: botao.left >= celula.left && botao.right <= celula.right,
      };
    }, NESTE_MES);
    expect(medidas).toEqual({ rolagemLateral: 0, celulaDentro: true, botaoDentroDaCelula: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "04-celular-mes.png"), fullPage: true });

    // A semana vira uma coluna, com o nome de cada dia.
    await page.getByRole("button", { name: "Semana", exact: true }).click();
    const dias = page.locator('[data-testid^="calendario-dia-"]');
    await expect(dias).toHaveCount(7);
    const caixas = await dias.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
    expect(new Set(caixas.map(Math.round)).size).toBe(1);
    await page.screenshot({ path: path.join(EVIDENCIA, "05-celular-semana.png"), fullPage: true });

    // Deixa a preferência como estava para quem vier depois nesta sessão.
    await page.getByRole("button", { name: "Mês", exact: true }).click();
    await page.getByRole("button", { name: "Quadro", exact: true }).click();
  });
});
