/**
 * E2E — NEGÓCIO GANHO ABRE O CARD DE PÓS-VENDA, montado pela TELA.
 *
 * Porte do projeto original (PR 2787 de @webtecnica). Quem usa: a clínica que
 * fecha no funil de vendas e acompanha o paciente noutro funil. O caminho que a
 * pessoa percorre, e que esta spec percorre igual:
 *
 *   1. Automações → Nova automação → QUANDO "Quando um negócio for ganho";
 *   2. ENTÃO "Criar/mover lead no funil", escolhendo o funil e a etapa do
 *      pós-venda (nada fixo no código: o funil é desta spec);
 *   3. liga a regra, ganha um negócio, e o card nasce no outro funil, com linha
 *      nas duas linhas do tempo;
 *   4. reabrir e ganhar de novo não abre um segundo card.
 *
 * Os funis e o negócio são semeados pela service key, como as outras specs que
 * precisam de precondição própria; a REGRA é montada só pela tela.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const APP_URL = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "pos-venda-ao-ganhar");

interface Creds {
  org_id: string;
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

function admin() {
  const env = carregarEnvLocal();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL ?? "", env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { persistSession: false },
  });
}

const creds = loadCreds();
const ts = Date.now();
const FUNIL_VENDAS = `Vendas E2E ${ts}`;
const FUNIL_PACIENTES = `Pacientes E2E ${ts}`;
const RULE_NAME = `E2E Pós-venda ${ts}`;
const TITULO = `Protocolo E2E ${ts}`;

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${APP_URL}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function drenar(page: Page): Promise<void> {
  const segredo = carregarEnvLocal().INTERNAL_SECRET?.trim();
  if (!segredo) throw new Error("INTERNAL_SECRET não encontrado no ambiente de teste");
  for (let i = 0; i < 3; i++) {
    const r = await page.request.post(`${APP_URL}/api/v1/cron/event-log-drain`, {
      headers: { Authorization: `Bearer ${segredo}` },
      timeout: 60_000,
    });
    expect(r.ok()).toBeTruthy();
  }
}

test.describe("negócio ganho abre o card de pós-venda", () => {
  test.setTimeout(180_000);
  test.use({ actionTimeout: 15_000 });

  test("regra montada pela tela: ganhou, nasce UM card no funil escolhido", async ({ page }) => {
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    const db = admin();
    const org = creds.org_id;

    // ── Precondição: dois funis e uma venda aberta com contato ─────────────
    const { data: funis, error: funisErr } = await db
      .from("crm_pipelines")
      .insert([
        { organization_id: org, name: FUNIL_VENDAS, slug: `vendas-e2e-${ts}` },
        { organization_id: org, name: FUNIL_PACIENTES, slug: `pacientes-e2e-${ts}` },
      ])
      .select("id, name");
    expect(funisErr).toBeNull();
    const vendasId = funis!.find((f) => f.name === FUNIL_VENDAS)!.id as string;
    const pacientesId = funis!.find((f) => f.name === FUNIL_PACIENTES)!.id as string;
    const { data: etapas, error: etapasErr } = await db
      .from("crm_stages")
      .insert([
        { organization_id: org, pipeline_id: vendasId, name: "Novo", slug: "novo", position: 1000, is_won: false },
        { organization_id: org, pipeline_id: vendasId, name: "Pago", slug: "pago", position: 2000, is_won: true },
        { organization_id: org, pipeline_id: pacientesId, name: "Acompanhamento", slug: "acompanhamento", position: 1000, is_won: false },
      ])
      // Lote com chaves iguais em toda linha: o PostgREST preenche a que falta com NULL.
      .select("id, slug, pipeline_id");
    expect(etapasErr).toBeNull();
    const novo = etapas!.find((e) => e.slug === "novo")!.id as string;
    const { data: contato } = await db
      .from("contacts")
      .insert({ organization_id: org, display_name: `Paciente E2E ${ts}` })
      .select("id")
      .single();
    const { data: venda, error: vendaErr } = await db
      .from("crm_leads")
      .insert({
        organization_id: org,
        pipeline_id: vendasId,
        stage_id: novo,
        title: TITULO,
        contact_id: contato!.id,
        value_cents: 180000,
        source: "manual",
        position_in_stage: 1000,
      })
      .select("id")
      .single();
    expect(vendaErr).toBeNull();
    const vendaId = venda!.id as string;

    let ruleId: string | undefined;
    try {
      await login(page, creds.users.manager!.email);
      await page.goto(`${APP_URL}/app/webhooks`);
      await page.getByRole("tab", { name: "Automações" }).click();
      await page.getByRole("button", { name: /Nova automação/ }).click();
      await page.locator("#rule-name").fill(RULE_NAME);

      const editor = page.getByRole("dialog");
      await editor.getByRole("combobox").first().click();
      await page.getByRole("option", { name: "Quando um negócio for ganho" }).click();

      await editor.getByRole("combobox").filter({ hasText: "Adicionar ação" }).click();
      await page.getByRole("option", { name: "Criar/mover lead no funil" }).click();
      await editor.getByRole("combobox").filter({ hasText: /^Escolha o funil$/ }).click();
      await page.getByRole("option", { name: FUNIL_PACIENTES }).click();
      await editor.getByRole("combobox").filter({ hasText: /Escolha a etapa/ }).click();
      await page.getByRole("option", { name: "Acompanhamento" }).click();
      await page.screenshot({ path: path.join(EVIDENCIA, "1-regra-montada.png") });

      const [salvo] = await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/v1/automation-rules") && r.request().method() === "POST"),
        page.getByRole("button", { name: "Criar automação" }).click(),
      ]);
      expect(salvo.ok()).toBeTruthy();
      ruleId = ((await salvo.json()) as { data: { id: string } }).data.id;
      await page.getByLabel(new RegExp(`Ligar ${RULE_NAME}`)).click();
      await expect(page.getByText("Automação ligada.")).toBeVisible({ timeout: 15_000 });

      // ── Ganha a venda pelo mesmo endpoint do botão Ganhar ────────────────
      const ganhou = await page.request.post(`${APP_URL}/api/v1/leads/${vendaId}/win`);
      expect(ganhou.ok(), await ganhou.text()).toBeTruthy();
      await drenar(page);

      const cards = async () =>
        (await db.from("crm_leads").select("id, stage_id, contact_id, title, status").eq("organization_id", org).eq("pipeline_id", pacientesId)).data ?? [];
      await expect.poll(async () => (await cards()).length, { timeout: 20_000 }).toBe(1);
      const [card] = await cards();
      expect(card).toMatchObject({ contact_id: contato!.id, title: TITULO, status: "open" });
      const { data: origem } = await db.from("crm_leads").select("status, pipeline_id").eq("id", vendaId).single();
      expect(origem).toMatchObject({ status: "won", pipeline_id: vendasId });

      // ── A tela: a aba Atividade diz Sucesso; o card conta de onde veio ───
      await page.getByRole("tab", { name: "Atividade" }).click();
      await expect(page.getByText(RULE_NAME, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: path.join(EVIDENCIA, "2-atividade.png"), fullPage: true });

      await page.goto(`${APP_URL}/app/leads/${card!.id}`);
      await expect(page.getByText(`Pós-venda da venda ganha no funil ${FUNIL_VENDAS}`).first()).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: path.join(EVIDENCIA, "3-card-de-pos-venda.png"), fullPage: true });
      await page.goto(`${APP_URL}/app/leads/${vendaId}`);
      await expect(page.getByText(`Card de pós-venda aberto no funil ${FUNIL_PACIENTES}`).first()).toBeVisible({ timeout: 20_000 });
      await page.screenshot({ path: path.join(EVIDENCIA, "4-venda.png"), fullPage: true });

      // ── Reabrir e ganhar de novo: continua UM card ───────────────────────
      // O mesmo corpo que o arrasto do kanban manda.
      const { data: atual } = await db.from("crm_leads").select("updated_at").eq("id", vendaId).single();
      const reabriu = await page.request.post(`${APP_URL}/api/v1/leads/${vendaId}/move`, {
        data: { stage_id: novo, position_in_stage: 5000, expected_updated_at: atual!.updated_at },
      });
      expect(reabriu.ok(), await reabriu.text()).toBeTruthy();
      const ganhouDeNovo = await page.request.post(`${APP_URL}/api/v1/leads/${vendaId}/win`);
      expect(ganhouDeNovo.ok(), await ganhouDeNovo.text()).toBeTruthy();
      const { count: ganhos } = await db
        .from("event_log")
        .select("id", { count: "exact", head: true })
        .eq("event_type", "lead.won")
        .eq("entity_id", vendaId);
      expect(ganhos, "o segundo ganho tem de existir para a prova valer").toBe(2);
      await drenar(page);
      expect(await cards()).toHaveLength(1);
    } finally {
      if (ruleId) await page.request.delete(`${APP_URL}/api/v1/automation-rules/${ruleId}`).catch(() => undefined);
    }
  });
});
