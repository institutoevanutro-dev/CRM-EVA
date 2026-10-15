/**
 * A cor da etapa, pela tela, como a dona da clínica faria: em Configurações ›
 * Funis ela escolhe o tom de uma etapa pelo NOME, abre o quadro e a coluna
 * inteira está daquele tom (cabeçalho tingido, faixa no alto, corpo leve e
 * borda); depois tira a cor e a coluna volta a ser exatamente como era.
 *
 * Medido por ferramenta, nunca a olho: `getComputedStyle` da coluna, do
 * cabeçalho e do ponto, e o contraste do nome da etapa sobre o cabeçalho
 * tingido calculado com a régua do repo (`lib/branding/contraste.ts`), nos
 * temas claro e escuro.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { PISOS, razaoDeContraste } from "../../lib/branding/contraste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "cor-da-etapa");

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

const adminClient = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

/** Ponto de partida conhecido: uma rodada anterior pode ter parado no meio. */
async function semCorNoBanco(stageId: string): Promise<void> {
  const { error } = await adminClient().from("crm_stages").update({ color: null }).eq("id", stageId);
  if (error) throw error;
}

/**
 * Um card na coluna colorida, para provar que ele continua na superfície dele.
 * Título fictício; o banco é o efêmero deste teste.
 */
async function cardNaEtapa(pipelineId: string, stageId: string, titulo: string): Promise<void> {
  const admin = adminClient();
  const { data: funil, error: e1 } = await admin
    .from("crm_pipelines")
    .select("organization_id")
    .eq("id", pipelineId)
    .single();
  if (e1) throw e1;
  const { error } = await admin.from("crm_leads").insert({
    organization_id: (funil as { organization_id: string }).organization_id,
    pipeline_id: pipelineId,
    stage_id: stageId,
    title: titulo,
  });
  if (error) throw error;
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/);
}

async function tema(page: Page, qual: "light" | "dark"): Promise<void> {
  await page.evaluate((t) => localStorage.setItem("deskcomm-theme", t), qual);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", qual);
}

/** `rgb(…)`, `rgba(…)` ou `color(srgb r g b / a)` → canais 0–255 e alfa. */
function lerCor(css: string): { r: number; g: number; b: number; a: number } {
  const srgb = css.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)/);
  if (srgb) {
    const [r, g, b] = [srgb[1], srgb[2], srgb[3]].map((v) => Number(v) * 255);
    return { r: r!, g: g!, b: b!, a: srgb[4] === undefined ? 1 : Number(srgb[4]) };
  }
  const rgb = css.match(/rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:[,/] ?([\d.]+))?\)/);
  if (!rgb) throw new Error(`cor que não sei ler: ${css}`);
  return {
    r: Number(rgb[1]),
    g: Number(rgb[2]),
    b: Number(rgb[3]),
    a: rgb[4] === undefined ? 1 : Number(rgb[4]),
  };
}

const hex = (c: { r: number; g: number; b: number }) =>
  `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** Compõe uma cor translúcida sobre um fundo opaco. */
function sobre(cor: ReturnType<typeof lerCor>, fundo: ReturnType<typeof lerCor>) {
  const m = (a: number, b: number) => a * cor.a + b * (1 - cor.a);
  return { r: m(cor.r, fundo.r), g: m(cor.g, fundo.g), b: m(cor.b, fundo.b), a: 1 };
}

/** Tudo o que se mede numa coluna do quadro. */
async function medirColuna(page: Page, stageId: string) {
  const coluna = page.locator(`[data-etapa-do-quadro="${stageId}"]`);
  await expect(coluna).toBeVisible();
  return coluna.evaluate((el) => {
    const cab = el.querySelector("[data-fundo-do-cabecalho]") as HTMLElement;
    const preso = el.querySelector("[data-cabecalho-da-etapa]") as HTMLElement;
    const ponto = cab.querySelector("span[aria-hidden]") as HTMLElement;
    const nome = cab.querySelector("h2") as HTMLElement;
    const cs = getComputedStyle(el);
    return {
      corDaEtapa: el.getAttribute("data-cor-da-etapa"),
      estiloInline: el.getAttribute("style"),
      colunaFundo: cs.backgroundColor,
      colunaBorda: cs.borderTopColor,
      cabecalhoFundo: getComputedStyle(cab).backgroundColor,
      cabecalhoSombra: getComputedStyle(cab).boxShadow,
      cabecalhoEstiloInline: cab.getAttribute("style"),
      presoFundo: getComputedStyle(preso).backgroundColor,
      pontoFundo: getComputedStyle(ponto).backgroundColor,
      nomeCor: getComputedStyle(nome).color,
    };
  });
}

// O banco do CI é COMPARTILHADO entre as specs da mesma parte: o que esta spec
// cria no funil padrão (cards e a etapa nova) sai no fim, para nenhuma outra
// spec contar colunas ou cards a mais.
const PREFIXO_DO_CARD = "Paciente Fictício cor-da-etapa";
const PREFIXO_DA_ETAPA = "Retorno cor-da-etapa";

test.afterAll(async () => {
  const admin = adminClient();
  await admin.from("crm_leads").delete().like("title", `${PREFIXO_DO_CARD}%`);
  await admin.from("crm_stages").update({ is_archived: true }).like("name", `${PREFIXO_DA_ETAPA}%`);
});

test.describe("cor da etapa", () => {
  test.setTimeout(120_000);

  test("escolher a cor pela tela pinta a coluna inteira; tirar a cor devolve o quadro como era", async ({
    page,
  }) => {
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await login(page);

    await page.goto("/app/settings/tenant/pipelines");
    const secao = page.locator('[data-testid^="etapas-"]').first();
    await expect(secao.locator('li[data-testid^="etapa-"]').first()).toBeVisible();
    const pipelineId = (await secao.getAttribute("data-testid"))!.replace(/^etapas-/, "");
    const linha = secao.locator('li[data-testid^="etapa-"]').first();
    const stageId = (await linha.getAttribute("data-testid"))!.replace(/^etapa-/, "");
    await semCorNoBanco(stageId);
    await page.reload();
    const nome = await page.getByTestId(`nome-${stageId}`).inputValue();

    // A coluna vizinha não é tocada: é a régua de "sem cor = quadro de sempre".
    const vizinha = secao.locator('li[data-testid^="etapa-"]').nth(1);
    const vizinhaId = (await vizinha.getAttribute("data-testid"))!.replace(/^etapa-/, "");

    // 1. Escolher «Rosa» pelo nome.
    const gatilho = page.getByRole("button", { name: `Cor da etapa «${nome}»` });
    await gatilho.click();
    const rosa = page.getByRole("button", { name: "Rosa", exact: true });
    await expect(rosa).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Sem cor" })).toHaveAttribute("aria-pressed", "true");
    await page.screenshot({ path: path.join(EVIDENCIA, "01-paleta-aberta.png") });
    await rosa.click();
    await expect(page.getByText("Etapa atualizada.")).toBeVisible();

    // A escolha voltou do servidor: reabrir mostra Rosa marcada.
    await page.reload();
    await page.getByRole("button", { name: `Cor da etapa «${nome}»` }).click();
    await expect(page.getByRole("button", { name: "Rosa", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.keyboard.press("Escape");

    // 2. O quadro, nos dois temas, com um card na coluna colorida.
    const titulo = `${PREFIXO_DO_CARD} ${Date.now()}`;
    await cardNaEtapa(pipelineId, stageId, titulo);
    await page.goto(`/app/pipelines/${pipelineId}`);
    for (const qual of ["light", "dark"] as const) {
      await tema(page, qual);
      const m = await medirColuna(page, stageId);
      expect(m.corDaEtapa?.toUpperCase()).toBe("#D4537E");

      // O ponto continua, no tom cheio.
      expect(hex(lerCor(m.pontoFundo))).toBe("#d4537e");

      // Cabeçalho: tom da etapa a 22% sobre o fundo opaco preso no alto.
      const cab = lerCor(m.cabecalhoFundo);
      expect(hex(cab)).toBe("#d4537e");
      expect(cab.a).toBeCloseTo(0.22, 2);
      expect(m.cabecalhoSombra).toContain("inset");

      // Corpo da coluna: o mesmo tom, mais leve; borda puxada para o tom.
      const corpo = lerCor(m.colunaFundo);
      expect(hex(corpo)).toBe("#d4537e");
      expect(corpo.a).toBeCloseTo(0.08, 2);
      const borda = hex(lerCor(m.colunaBorda));
      const vizinhaM = await medirColuna(page, vizinhaId);
      expect(borda).not.toBe(hex(lerCor(vizinhaM.colunaBorda)));

      // O nome da etapa segue legível sobre o cabeçalho tingido (WCAG 1.4.3).
      const fundoReal = sobre(cab, lerCor(m.presoFundo));
      const contraste = razaoDeContraste(hex(lerCor(m.nomeCor)), hex(fundoReal));
      expect(contraste).toBeGreaterThanOrEqual(PISOS.texto);
      test.info().annotations.push({
        type: `contraste ${qual}`,
        description: `${contraste.toFixed(2)} (nome ${hex(lerCor(m.nomeCor))} sobre ${hex(fundoReal)})`,
      });

      // O card continua na superfície do tema, sem tinta da etapa.
      const card = page
        .locator(`[data-etapa-do-quadro="${stageId}"] .bg-surface.rounded-md`)
        .filter({ hasText: titulo })
        .first();
      await expect(card).toBeVisible();
      const fundoDoCard = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
      const superficie = await page.evaluate(() => {
        const sonda = document.createElement("div");
        sonda.className = "bg-surface";
        document.body.appendChild(sonda);
        const c = getComputedStyle(sonda).backgroundColor;
        sonda.remove();
        return c;
      });
      expect(fundoDoCard).toBe(superficie);

      // A coluna sem cor não ganha estilo nenhum.
      expect(vizinhaM.corDaEtapa).toBeNull();
      expect(vizinhaM.estiloInline).toBeNull();
      expect(vizinhaM.cabecalhoEstiloInline).toBeNull();

      await page.screenshot({ path: path.join(EVIDENCIA, `02-quadro-rosa-${qual}.png`) });
    }

    // 3. Celular, tema escuro (o da clínica): o seletor cabe e funciona.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/app/settings/tenant/pipelines");
    await page.getByRole("button", { name: `Cor da etapa «${nome}»` }).click();
    const larguraDaPagina = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(larguraDaPagina).toBeLessThanOrEqual(375);
    // A paleta inteira (com o "Sem cor") dentro da tela, não cortada na borda.
    const semCor = await page.getByRole("button", { name: "Sem cor" }).boundingBox();
    const ultimoTom = await page.getByRole("button", { name: "Cinza (perdido)" }).boundingBox();
    const painel = await page.getByRole("dialog").boundingBox();
    for (const caixa of [painel!, semCor!, ultimoTom!]) {
      expect(caixa.x).toBeGreaterThanOrEqual(0);
      expect(caixa.x + caixa.width).toBeLessThanOrEqual(375);
    }
    await page.screenshot({ path: path.join(EVIDENCIA, "03-celular-paleta-escuro.png") });

    // 4. Tirar a cor.
    await page.getByRole("button", { name: "Sem cor" }).click();
    await expect(page.getByText("Etapa atualizada.").first()).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(`/app/pipelines/${pipelineId}`);
    const sem = await medirColuna(page, stageId);
    const ref = await medirColuna(page, vizinhaId);
    expect(sem.corDaEtapa).toBeNull();
    expect(sem.estiloInline).toBeNull();
    expect(sem.cabecalhoEstiloInline).toBeNull();
    // Igual, medida por medida, à coluna que nunca teve cor.
    expect(sem.colunaFundo).toBe(ref.colunaFundo);
    expect(sem.colunaBorda).toBe(ref.colunaBorda);
    expect(sem.cabecalhoFundo).toBe(ref.cabecalhoFundo);
    expect(sem.pontoFundo).toBe(ref.pontoFundo);
    await page.screenshot({ path: path.join(EVIDENCIA, "04-quadro-sem-cor-escuro.png") });
  });

  test("etapa nova já nasce com cor", async ({ page }) => {
    await login(page);
    await page.goto("/app/settings/tenant/pipelines");
    const secao = page.locator('[data-testid^="etapas-"]').first();
    await expect(secao.locator('li[data-testid^="etapa-"]').first()).toBeVisible();
    const pipelineId = (await secao.getAttribute("data-testid"))!.replace(/^etapas-/, "");
    const nome = `${PREFIXO_DA_ETAPA} ${Date.now()}`;

    await secao.getByTestId("nova-etapa").click();
    await secao.getByTestId("nova-etapa-nome").fill(nome);
    await secao.getByRole("button", { name: "Cor da nova etapa" }).click();
    await page.getByRole("button", { name: "Verde-água (acompanhamento)" }).click();
    await secao.getByTestId("nova-etapa-criar").click();
    await expect(page.getByText(`«${nome}» entrou no fim do funil.`)).toBeVisible();

    await page.goto(`/app/pipelines/${pipelineId}`);
    const coluna = page.locator("[data-etapa-do-quadro]").filter({ hasText: nome });
    await expect(coluna).toHaveAttribute("data-cor-da-etapa", "#1D9E75");
    await coluna.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(EVIDENCIA, "05-etapa-nova-verde-agua.png") });
  });
});
