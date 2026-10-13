/**
 * TAREFAS DENTRO DO CARD DO NEGÓCIO, pela tela, como a recepção faz.
 * (porte do PR #2760 de melgarafael/DeskcommCRM, de @profpeque)
 *
 * A tarefa só nascia na tela de Tarefas, que não pergunta de qual negócio ela
 * é. Aqui ela nasce de dentro do card: abre o negócio no quadro, anota o
 * próximo passo, e o card passa a mostrar o selo de pendências. Concluída a
 * tarefa, o selo some. E a tela de Tarefas mostra a MESMA tarefa, com o atalho
 * para o negócio (uma fonte só).
 *
 * `manager` em vez de `admin`: o `admin` do seed tem TOTP, e a tela de 2FA não
 * é o assunto (mesma razão das specs de agenda).
 *
 * Funil PRÓPRIO: o funil padrão é de outros specs, e um selo num card deles
 * mudaria o que eles veem.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const RAIZ = path.resolve(__dirname, "../..");
const CREDS_PATH = path.join(RAIZ, ".e2e-creds.json");
const EVIDENCIA = path.join(RAIZ, ".superpowers/evidence/tarefas-no-card");

test.describe.configure({ timeout: 240_000, mode: "serial" });

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string } | undefined>;
}

function lerCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = lerCreds();
const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SUFIXO = `${Date.now()}`.slice(-7);
const NEGOCIO = `Avaliação E2E ${SUFIXO}`;
const SEM_PRAZO = `Enviar o orçamento ${SUFIXO}`;
const VENCIDA = `Ligar de volta ${SUFIXO}`;
let funilId = "";
let leadId = "";
let contatoId = "";

async function limpar(): Promise<void> {
  const { data } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("name", "Tarefas E2E %");
  const ids = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (ids.length === 0) return;
  const { data: leads } = await admin.from("crm_leads").select("id").in("pipeline_id", ids);
  const leadIds = ((leads ?? []) as { id: string }[]).map((l) => l.id);
  if (leadIds.length > 0) await admin.from("crm_tasks").delete().in("lead_id", leadIds);
  await admin.from("crm_lead_activities").delete().in("pipeline_id", ids);
  await admin.from("crm_leads").delete().in("pipeline_id", ids);
  await admin.from("crm_stages").delete().in("pipeline_id", ids);
  await admin.from("crm_pipelines").delete().in("id", ids);
}

async function entrar(page: Page) {
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

async function abrirQuadro(page: Page) {
  const [quadro] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === `/api/v1/pipelines/${funilId}/board` && r.request().method() === "GET",
    ),
    page.goto(`/app/pipelines/${funilId}`),
  ]);
  expect(quadro.status()).toBe(200);
}

const cardDoNegocio = (page: Page) => page.getByRole("group", { name: `Lead: ${NEGOCIO}` });

async function abrirDossie(page: Page) {
  await cardDoNegocio(page).getByRole("button", { name: NEGOCIO }).click();
  const secao = page.getByTestId("tarefas-do-negocio");
  await expect(secao).toBeVisible({ timeout: 20_000 });
  return secao;
}

/** `YYYY-MM-DD` de ontem, no fuso de quem usa a tela. */
function ontem(): string {
  const d = new Date(Date.now() - 86_400_000);
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())}`;
}

test.beforeAll(async () => {
  await limpar();
  const { data: funil, error } = await admin
    .from("crm_pipelines")
    .insert({ organization_id: creds.org_id, name: `Tarefas E2E ${SUFIXO}`, slug: `tarefas-e2e-${SUFIXO}` })
    .select("id")
    .single();
  if (error) throw new Error(`funil: ${error.message}`);
  funilId = (funil as { id: string }).id;
  const { data: etapa, error: eErr } = await admin
    .from("crm_stages")
    .insert({ organization_id: creds.org_id, pipeline_id: funilId, name: "Novo", slug: "novo", position: 1000 })
    .select("id")
    .single();
  if (eErr) throw new Error(`etapa: ${eErr.message}`);
  const { data: contato, error: cErr } = await admin
    .from("contacts")
    .insert({ organization_id: creds.org_id, display_name: `Paciente E2E ${SUFIXO}` })
    .select("id")
    .single();
  if (cErr) throw new Error(`contato: ${cErr.message}`);
  contatoId = (contato as { id: string }).id;
  const { data: lead, error: lErr } = await admin
    .from("crm_leads")
    .insert({
      organization_id: creds.org_id,
      pipeline_id: funilId,
      stage_id: (etapa as { id: string }).id,
      contact_id: contatoId,
      title: NEGOCIO,
      position_in_stage: 1000,
      source: "manual",
    } as never)
    .select("id")
    .single();
  if (lErr) throw new Error(`negócio: ${lErr.message}`);
  leadId = (lead as { id: string }).id;
  fs.mkdirSync(EVIDENCIA, { recursive: true });
});

test("criar tarefa pelo card, ver o selo no quadro, concluir e ver o selo sumir", async ({ page }) => {
  await entrar(page);
  await abrirQuadro(page);

  const card = cardDoNegocio(page);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId("selo-de-tarefas")).toHaveCount(0);
  const alturaSemSelo = (await card.boundingBox())!.height;

  // ── 1. Tarefa sem prazo, criada de dentro do card ─────────────────────────
  let secao = await abrirDossie(page);
  await expect(secao).toContainText("Nenhuma tarefa neste negócio");
  await page.screenshot({ path: path.join(EVIDENCIA, "01-dossie-sem-tarefas.png") });

  await secao.getByRole("button", { name: "Nova tarefa" }).click();
  await page.getByLabel("O que precisa ser feito").fill(SEM_PRAZO);
  await page.getByRole("button", { name: "Salvar" }).click();

  const linhaSemPrazo = secao.getByTestId("linha-da-tarefa").filter({ hasText: SEM_PRAZO });
  await expect(linhaSemPrazo).toBeVisible({ timeout: 20_000 });
  await expect(secao.getByRole("heading", { name: /Tarefas/ })).toContainText("1 aberta");
  // A linha do tempo do negócio ganha a tarefa combinada, ao vivo ou no refetch.
  await expect(page.getByText("Tarefa combinada").first()).toBeVisible({ timeout: 30_000 });

  await page.keyboard.press("Escape");
  await expect(secao).toBeHidden();

  // ── 2. O selo de "em aberto" no card, sem crescer o card ──────────────────
  const selo = card.getByTestId("selo-de-tarefas");
  await expect(selo).toBeVisible({ timeout: 20_000 });
  await expect(selo).toHaveAccessibleName("1 tarefa aberta");
  await expect(selo).toHaveAttribute("data-atrasadas", "0");
  expect((await card.boundingBox())!.height).toBe(alturaSemSelo);
  const corAberta = await selo.evaluate((el) => getComputedStyle(el).color);
  await page.screenshot({ path: path.join(EVIDENCIA, "02-quadro-selo-em-aberto.png") });

  // ── 3. Tarefa vencida, criada SÓ pelo teclado ─────────────────────────────
  secao = await abrirDossie(page);
  await secao.getByRole("button", { name: "Nova tarefa" }).focus();
  await page.keyboard.press("Enter");
  const titulo = page.getByLabel("O que precisa ser feito");
  await expect(titulo).toBeFocused();
  await page.keyboard.type(VENCIDA);
  await page.getByLabel("Prazo").fill(ontem());
  await titulo.focus();
  await page.keyboard.press("Enter");

  const linhaVencida = secao.getByTestId("linha-da-tarefa").filter({ hasText: VENCIDA });
  await expect(linhaVencida).toBeVisible({ timeout: 20_000 });
  const cabecalho = secao.getByRole("heading", { name: /Tarefas/ });
  await expect(cabecalho).toContainText("2 abertas");
  await expect(cabecalho).toContainText("1 atrasada");
  await page.screenshot({ path: path.join(EVIDENCIA, "03-dossie-com-tarefas.png") });

  // No banco: presa ao negócio e ao contato, com quem criou como responsável.
  const { data: gravadas } = await admin
    .from("crm_tasks")
    .select("title, lead_id, contact_id, assigned_to, organization_id")
    .eq("lead_id", leadId)
    .order("created_at");
  expect(gravadas).toEqual([
    { title: SEM_PRAZO, lead_id: leadId, contact_id: contatoId, assigned_to: creds.users.manager!.id, organization_id: creds.org_id },
    { title: VENCIDA, lead_id: leadId, contact_id: contatoId, assigned_to: creds.users.manager!.id, organization_id: creds.org_id },
  ]);

  await page.keyboard.press("Escape");
  await expect(secao).toBeHidden();

  // ── 4. O selo de atraso: vermelho, com o número das vencidas ──────────────
  await expect(selo).toHaveAccessibleName("2 tarefas abertas · 1 atrasada", { timeout: 20_000 });
  await expect(selo).toHaveAttribute("data-atrasadas", "1");
  const corAtrasada = await selo.evaluate((el) => getComputedStyle(el).color);
  expect(corAtrasada).not.toBe(corAberta);
  expect((await card.boundingBox())!.height).toBe(alturaSemSelo);
  await page.screenshot({ path: path.join(EVIDENCIA, "04-quadro-selo-atrasada.png") });

  // ── 5. A tela de Tarefas mostra as MESMAS tarefas, com o atalho do negócio ─
  await page.goto("/app/tasks");
  const naTela = page.getByTestId("linha-da-tarefa").filter({ hasText: VENCIDA });
  await expect(naTela).toBeVisible({ timeout: 20_000 });
  await expect(naTela.getByTestId("negocio-da-tarefa")).toHaveText(NEGOCIO);
  await expect(naTela.getByTestId("negocio-da-tarefa")).toHaveAttribute("href", `/app/leads/${leadId}`);
  await expect(page.getByTestId("linha-da-tarefa").filter({ hasText: SEM_PRAZO })).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "05-tela-de-tarefas.png") });

  // ── 6. Concluir as duas pelo card (uma com o teclado): o selo some ────────
  await abrirQuadro(page);
  secao = await abrirDossie(page);
  await secao
    .getByTestId("linha-da-tarefa")
    .filter({ hasText: VENCIDA })
    .getByRole("checkbox", { name: "Marcar como concluída" })
    .click();
  await expect(cabecalho).toContainText("1 aberta");
  await expect(cabecalho).not.toContainText("atrasada");
  const caixa = secao
    .getByTestId("linha-da-tarefa")
    .filter({ hasText: SEM_PRAZO })
    .getByRole("checkbox", { name: "Marcar como concluída" });
  await caixa.focus();
  await page.keyboard.press("Space");
  await expect(cabecalho).not.toContainText("aberta");
  await expect(page.getByText("Tarefa concluída").first()).toBeVisible({ timeout: 30_000 });

  await page.keyboard.press("Escape");
  await expect(secao).toBeHidden();
  await expect(cardDoNegocio(page).getByTestId("selo-de-tarefas")).toHaveCount(0, { timeout: 20_000 });
  await page.screenshot({ path: path.join(EVIDENCIA, "06-quadro-selo-sumiu.png") });

  // Cada mutação auditada, e a linha do tempo com o que foi combinado e feito.
  const { data: auditoria } = await admin
    .from("api_audit_log")
    .select("action")
    .eq("organization_id", creds.org_id)
    .eq("resource_type", "crm_tasks")
    .gte("created_at", new Date(Date.now() - 240_000).toISOString());
  const acoes = ((auditoria ?? []) as { action: string }[]).map((a) => a.action);
  expect(acoes.filter((a) => a === "crm_task.created").length).toBeGreaterThanOrEqual(2);
  expect(acoes.filter((a) => a === "crm_task.updated").length).toBeGreaterThanOrEqual(2);
  const { data: atividades } = await admin.from("crm_lead_activities").select("type").eq("lead_id", leadId);
  const tipos = ((atividades ?? []) as { type: string }[]).map((a) => a.type).sort();
  expect(tipos.filter((t) => t.startsWith("task_"))).toEqual([
    "task_completed",
    "task_completed",
    "task_created",
    "task_created",
  ]);
});

test("no celular (390 px) a seção de tarefas cabe na tela e os botões da linha ficam à vista", async ({ page }) => {
  // Uma tarefa vencida já no banco, para a tela ter o que mostrar.
  await admin.from("crm_tasks").delete().eq("lead_id", leadId);
  const { error } = await admin.from("crm_tasks").insert({
    organization_id: creds.org_id,
    title: `Confirmar o retorno ${SUFIXO}`,
    lead_id: leadId,
    contact_id: contatoId,
    due_date: new Date(Date.now() - 86_400_000).toISOString(),
    assigned_to: creds.users.manager!.id,
  } as never);
  if (error) throw new Error(`tarefa: ${error.message}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await entrar(page);
  await abrirQuadro(page);
  const card = cardDoNegocio(page);
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByTestId("selo-de-tarefas")).toHaveAccessibleName("1 tarefa aberta · 1 atrasada", {
    timeout: 20_000,
  });
  await page.screenshot({ path: path.join(EVIDENCIA, "07-celular-quadro.png") });

  const secao = await abrirDossie(page);
  const linha = secao.getByTestId("linha-da-tarefa").first();
  await expect(linha).toBeVisible({ timeout: 20_000 });

  // Medido por ferramenta: nada estoura a largura, o alvo de "Nova tarefa" tem
  // altura de toque, e a linha inteira cabe na tela.
  const caixaDaSecao = (await secao.boundingBox())!;
  expect(caixaDaSecao.x).toBeGreaterThanOrEqual(0);
  expect(caixaDaSecao.x + caixaDaSecao.width).toBeLessThanOrEqual(390);
  const caixaDaLinha = (await linha.boundingBox())!;
  expect(caixaDaLinha.x).toBeGreaterThanOrEqual(0);
  expect(caixaDaLinha.x + caixaDaLinha.width).toBeLessThanOrEqual(390);
  const nova = (await secao.getByRole("button", { name: "Nova tarefa" }).boundingBox())!;
  expect(nova.height).toBeGreaterThanOrEqual(32);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: path.join(EVIDENCIA, "08-celular-dossie.png") });

  // O formulário abre e cabe.
  await secao.getByRole("button", { name: "Nova tarefa" }).click();
  const dialogo = page.getByRole("dialog").filter({ hasText: "O que precisa ser feito" });
  await expect(dialogo).toBeVisible();
  const caixaDoDialogo = (await dialogo.boundingBox())!;
  expect(caixaDoDialogo.x).toBeGreaterThanOrEqual(0);
  expect(caixaDoDialogo.x + caixaDoDialogo.width).toBeLessThanOrEqual(390);
  await expect(page.getByLabel("Responsável")).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "09-celular-formulario.png") });
});
