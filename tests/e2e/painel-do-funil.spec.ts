/**
 * Prova de tela do Painel do funil (passo 13 do plano
 * `docs/superpowers/plans/2026-10-06-painel-do-funil.md`).
 *
 * O gestor abre Análise, entra no Painel do funil e lê os números de um funil
 * que ele mesmo montou: 3 leads, 2 que interagiram, 1 ganho com valor, 1
 * consulta realizada e 1 falta — e o investimento diz "não conectado", porque
 * a instalação fresca não tem conta de anúncios.
 *
 * Setup: organização e usuário pelo service role (como as specs da Agenda);
 * funil, mapeamento do passo "Primeiro contato", contatos, cards e movimentos
 * pela API real. Os compromissos nascem pelo service role com início no
 * PASSADO — o handler recusa realizado/faltou em compromisso que ainda não
 * começou — e o desfecho é marcado pela API. O campo de lista do card não tem
 * rota (é server action de Configurações), então ele e o valor dos cards vão
 * pelo service role.
 */
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { persistSession: false },
});
const senha = `Local-${randomUUID()}!`;
const FUSO = "America/Sao_Paulo";
const ESPERA = 30_000;

test.describe.configure({ timeout: 240_000 });

let orgId = "";
let userId = "";
let email = "";

async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw error;
  return data.id as string;
}

async function entrar(page: Page, endereco: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(endereco);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}

const valorDo = (page: Page, id: string) => page.locator(`[data-numero="${id}"] [data-valor]`);

test.beforeAll(async () => {
  email = `painel-funil-${randomUUID()}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
  });
  if (error || !data.user) throw error;
  userId = data.user.id;
  orgId = await inserir("organizations", {
    slug: `painel-funil-${randomUUID()}`.slice(0, 40),
    display_name: "Painel do funil",
    legal_name: "Painel do funil",
    timezone: FUSO,
    onboarded_at: new Date().toISOString(),
  });
  await inserir("user_organizations", {
    organization_id: orgId,
    user_id: userId,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
});

test.afterAll(async () => {
  if (orgId) await db.from("organizations").delete().eq("id", orgId);
  if (userId) await db.auth.admin.deleteUser(userId);
});

test("o gestor lê o funil do período com a régua de cada número", async ({ page }, info) => {
  await entrar(page, email);
  const marca = Date.now();

  // ---- funil novo (Novo, Em andamento, Ganho, Perdido) ----
  const funilRes = await page.request.post("/api/v1/pipelines", {
    data: { name: `Funil Painel ${marca}` },
  });
  expect(funilRes.status()).toBe(201);
  const funis = (
    (await funilRes.json()) as { data: { pipelines: Array<{ id: string; name: string }> } }
  ).data.pipelines;
  const funil = funis.find((p) => p.name === `Funil Painel ${marca}`)!;
  const mapaRes = await page.request.get(`/api/v1/pipelines/${funil.id}/agent-mapping`);
  const etapas = (
    (await mapaRes.json()) as {
      data: { etapas: Array<{ id: string; name: string; is_won: boolean }> };
    }
  ).data.etapas;
  const novo = etapas[0]!;
  const andamento = etapas[1]!;
  const ganho = etapas.find((e) => e.is_won)!;

  // "Em andamento" passa a ser a etapa do passo Primeiro contato.
  const mapeamento = {
    new: null,
    contacted: andamento.id,
    qualifying: null,
    qualified: null,
    negotiating: null,
    won: null,
    lost: null,
  };
  expect(
    (
      await page.request.put(`/api/v1/pipelines/${funil.id}/agent-mapping`, {
        data: { mapeamento },
      })
    ).status(),
  ).toBe(200);

  // Campo de lista do card (sem rota: é server action de Configurações).
  const campo = {
    key: "modalidade",
    label: "Modalidade",
    type: "select",
    options: [
      { value: "online", label: "Online" },
      { value: "presencial", label: "Presencial" },
    ],
  };
  const { data: funilLinha } = await db
    .from("crm_pipelines")
    .select("settings")
    .eq("id", funil.id)
    .single();
  await db
    .from("crm_pipelines")
    .update({ settings: { ...(funilLinha!.settings as Record<string, unknown>), fields: [campo] } })
    .eq("id", funil.id);

  // ---- 3 contatos, 3 cards ----
  const contatos: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await page.request.post("/api/v1/contacts", {
      data: {
        display_name: `Pessoa Painel ${i} ${marca}`,
        phone_number: `+55119${String(marca + i).slice(-8)}`,
      },
    });
    expect(r.status()).toBe(201);
    contatos.push(((await r.json()) as { data: { contact: { id: string } } }).data.contact.id);
  }
  const cards: Array<{ id: string; updated_at: string }> = [];
  for (let i = 0; i < 3; i++) {
    const r = await page.request.post("/api/v1/leads", {
      data: {
        pipeline_id: funil.id,
        stage_id: novo.id,
        contact_id: contatos[i],
        title: `Card Painel ${i} ${marca}`,
        value_cents: i === 2 ? 49000 : null,
      },
    });
    expect(r.status()).toBe(201);
    cards.push(((await r.json()) as { data: { id: string; updated_at: string } }).data);
  }
  // A escrita direta muda o updated_at do card; o /move compara essa versão
  // (expected_updated_at) e recusa com 409 se o teste mandar a da criação.
  for (const [i, modalidade] of [
    [0, "online"],
    [2, "presencial"],
  ] as const) {
    const { data, error } = await db
      .from("crm_leads")
      .update({ custom_fields: { modalidade } })
      .eq("id", cards[i]!.id)
      .select("updated_at")
      .single();
    expect(error).toBeNull();
    cards[i]!.updated_at = (data as { updated_at: string }).updated_at;
  }

  // Card 1 interage; card 2 interage e é ganho.
  const mover = async (card: { id: string; updated_at: string }, stageId: string) => {
    const r = await page.request.post(`/api/v1/leads/${card.id}/move`, {
      data: { stage_id: stageId, position_in_stage: 1000, expected_updated_at: card.updated_at },
    });
    expect(r.status(), await r.text()).toBe(200);
    card.updated_at = ((await r.json()) as { data: { updated_at: string } }).data.updated_at;
  };
  await mover(cards[1]!, andamento.id);
  await mover(cards[2]!, andamento.id);
  await mover(cards[2]!, ganho.id);

  // ---- 2 compromissos no passado; desfecho pela API ----
  const inicio = new Date(Date.now() - 2 * 3600_000);
  const fim = new Date(inicio.getTime() + 30 * 60_000);
  for (const [i, status] of [
    [0, "completed"],
    [1, "no_show"],
  ] as const) {
    const id = await inserir("calendar_appointments", {
      organization_id: orgId,
      title: `Consulta Painel ${i}`,
      starts_at: inicio.toISOString(),
      ends_at: fim.toISOString(),
      time_zone: FUSO,
      status: "confirmed",
      owner_user_id: userId,
      contact_id: contatos[i],
    });
    const r = await page.request.patch("/api/v1/agenda/agendamentos", { data: { id, status } });
    expect(r.status(), await r.text()).toBe(200);
  }

  // ---- a tela: Análise → Painel do funil ----
  await page.goto("/app/analise");
  // Menu por área (07/10/2026): o Painel do funil é aba de Análise (o card do hub também existe).
  await page.getByRole("navigation", { name: "Telas de Análise" }).getByRole("link", { name: "Painel do funil" }).click();
  await page.waitForURL(/\/app\/painel-do-funil/);
  await expect(page.getByTestId("painel-do-funil")).toBeVisible({ timeout: ESPERA });

  // O padrão termina ONTEM; os dados nasceram hoje — o gestor estende até hoje.
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: FUSO });
  await page.getByLabel("Até", { exact: true }).fill(hoje);
  await page.getByRole("combobox", { name: "Funil" }).click();
  await page.getByRole("option", { name: `Funil Painel ${marca}` }).click();
  await page.getByRole("button", { name: "Aplicar" }).click();

  await expect(valorDo(page, "leads")).toHaveText("3", { timeout: ESPERA });
  await expect(valorDo(page, "interagiram")).toHaveText("2");
  await expect(page.locator('[data-numero="interagiram"]')).toContainText("67%");
  await expect(valorDo(page, "ganhos")).toHaveText("1");
  await expect(valorDo(page, "realizados")).toHaveText("1");
  await expect(valorDo(page, "faltas")).toHaveText("1");
  await expect(valorDo(page, "comparecimento")).toHaveText("50%");
  await expect(page.locator('[data-numero="investimento"]')).toContainText(
    "Nenhuma conta de anúncios conectada",
  );
  // Cada número diz a régua.
  await expect(page.locator('[data-numero="leads"]')).toContainText(
    "Cards criados neste funil no período.",
  );

  // O número não se esconde atrás do cartão: medido, não a olho.
  const caixa = await valorDo(page, "leads").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { largura: r.width, altura: r.height };
  });
  expect(caixa.largura).toBeGreaterThan(0);
  expect(caixa.altura).toBeGreaterThan(0);

  // ---- recorte por campo do card: as opções cadastradas aparecem ----
  await page.getByRole("combobox", { name: "Recorte" }).click();
  await page.getByRole("option", { name: "Campo do card" }).click();
  await page.getByRole("combobox", { name: "Campo" }).click();
  await page.getByRole("option", { name: "Modalidade" }).click();
  await page.getByRole("button", { name: "Aplicar" }).click();
  const tabela = page.getByTestId("tabela-do-recorte");
  await expect(tabela).toBeVisible({ timeout: ESPERA });
  await expect(tabela.locator('[data-valor="online"]')).toContainText("Online");
  await expect(tabela.locator('[data-valor="presencial"]')).toContainText("Presencial");

  await page.screenshot({ path: info.outputPath("painel-do-funil.png"), fullPage: true });
});
