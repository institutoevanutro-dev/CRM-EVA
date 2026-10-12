/**
 * Fixture e passos comuns das duas provas pela tela do pedido de dados do
 * titular (`lgpd-pedido-sem-email-vira-revisao-pendente` e
 * `lgpd-pedido-entregue-por-email`).
 *
 * ⚠️ O PEDIDO NASCE POR INSERT, e isso é o retrato do produto, não atalho: hoje
 * a única porta que CRIA um pedido é o webhook da Nuvemshop
 * (`createLgpdRequest`). Não existe botão "nova solicitação" na tela. O insert
 * abaixo grava o que o webhook grava (pedido `received`, prazo, payload), sem
 * emitir o evento, para que quem ponha o pedido para andar seja o operador,
 * pelo botão "Aprovar export" da tela.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, type Page } from "@playwright/test";

export function servico(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) {
    throw new Error("sem NEXT_PUBLIC_SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY no processo de teste (.env.e2e)");
  }
  return createClient(url, chave, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Cria o titular e o pedido `received`. `emailDeEntrega` nulo = titular sem endereço. */
export async function criarPedido(
  banco: SupabaseClient,
  orgId: string,
  nome: string,
  emailDeEntrega: string | null,
): Promise<string> {
  const contato = await banco
    .from("contacts")
    .insert({ organization_id: orgId, name: nome, phone_number: `+55119${Date.now().toString().slice(-8)}` })
    .select("id")
    .single();
  if (contato.error) throw contato.error;

  const pedido = await banco
    .from("lgpd_requests")
    .insert({
      organization_id: orgId,
      request_type: "data_request",
      source: "manual",
      contact_id: contato.data.id,
      status: "received",
      due_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      request_payload: emailDeEntrega ? { delivery: { method: "email", address: emailDeEntrega } } : {},
    })
    .select("id")
    .single();
  if (pedido.error) throw pedido.error;
  return pedido.data.id as string;
}

/** O operador abre o pedido pela lista e aprova pela tela. */
export async function aprovarPelaTela(page: Page, pedidoId: string, pasta: string): Promise<void> {
  await page.goto("/app/lgpd/requests");
  const linha = page.getByRole("row").filter({ hasText: pedidoId.slice(0, 8) });
  await expect(linha).toContainText("Recebido", { timeout: 30_000 });
  await page.screenshot({ path: `${pasta}/1-lista-recebido.png`, fullPage: true });

  await linha.getByRole("link", { name: "Ver" }).click();
  await page.waitForURL(new RegExp(`/app/lgpd/requests/${pedidoId}`));
  await page.getByRole("button", { name: "Aprovar export" }).click();
  await page.locator("#approved_reason").fill("Titular confirmou a identidade no balcão da clínica.");
  await page.screenshot({ path: `${pasta}/2-aprovar.png`, fullPage: true });
  await page.getByRole("button", { name: "Confirmar aprovação" }).click();
  await expect(page.getByText("Processando", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${pasta}/3-processando.png`, fullPage: true });
}

/**
 * O que o `scheduler` faz a cada minuto: drena o `event_log`. Repete até o
 * pedido sair de `processing` (o dreno é global e o evento pode não caber no
 * primeiro lote).
 */
export async function drenarAteSairDeProcessando(
  page: Page,
  banco: SupabaseClient,
  pedidoId: string,
): Promise<string> {
  const segredo = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  if (!segredo) throw new Error("sem INTERNAL_SECRET no processo de teste (.env.e2e)");
  let status = "processing";
  for (let volta = 0; volta < 5 && status === "processing"; volta++) {
    const r = await page.request.post("/api/v1/cron/event-log-drain", {
      headers: { authorization: `Bearer ${segredo}` },
      timeout: 120_000,
    });
    expect(r.status()).toBe(200);
    const linha = await banco.from("lgpd_requests").select("status").eq("id", pedidoId).single();
    if (linha.error) throw linha.error;
    status = linha.data.status as string;
  }
  return status;
}

/** O link "Baixar PDF" da página do pedido devolve um PDF de verdade. */
export async function baixarPdfDaTela(page: Page): Promise<Buffer> {
  const link = page.getByRole("link", { name: "Baixar PDF" });
  await expect(link).toBeVisible({ timeout: 30_000 });
  const href = await link.getAttribute("href");
  expect(href, "o botão Baixar PDF não tem endereço").toBeTruthy();
  const resposta = await page.request.get(href!);
  expect(resposta.status()).toBe(200);
  const corpo = await resposta.body();
  expect(corpo.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  return corpo;
}
