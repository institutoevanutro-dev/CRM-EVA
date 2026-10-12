/**
 * O PEDIDO DO TITULAR ENTRA PELA TELA, ANDA E FECHA.
 *
 * A clínica não tem loja: o paciente pede os dados pelo WhatsApp, por e-mail, por
 * telefone ou no balcão. Até aqui não havia por onde registrar isso (o pedido só
 * nascia pelo webhook da Nuvemshop). Esta spec é a jornada inteira, sem insert:
 *
 *   "Registrar pedido" (recebido há 3 dias) → Recebido, com o prazo contado do
 *   dia em que a pessoa pediu → "Aprovar export" → Processando → (dreno) →
 *   Revisão pendente, com o PDF → "Marcar como entregue" → Concluído.
 *
 * O ambiente não tem envio de e-mail (`.env.e2e` sem `RESEND_API_KEY`), que é o
 * estado de um primeiro deploy: por isso o pedido termina em revisão pendente.
 *
 * Evidência visual em `.superpowers/evidence/lgpd-registrar/`.
 */
import * as fs from "node:fs";

import { expect, test } from "@playwright/test";

import { hojeNoBrasil, instanteDoRecebimento } from "../../lib/lgpd/pedido-manual";
import { computeDueAt, prazoEmBr } from "../../lib/lgpd/sla";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { baixarPdfDaTela, drenarAteSairDeProcessando, servico } from "./helpers/lgpd-pedido";

const PASTA = ".superpowers/evidence/lgpd-registrar";

/** `YYYY-MM-DD` de N dias antes de hoje, no calendário do Brasil. */
function diasAtras(n: number): string {
  const hoje = new Date(`${hojeNoBrasil()}T12:00:00Z`);
  hoje.setUTCDate(hoje.getUTCDate() - n);
  return hoje.toISOString().slice(0, 10);
}

test("registrar o pedido pela tela, aprovar, e marcar o relatório como entregue", async ({ page }) => {
  test.setTimeout(300_000);
  fs.mkdirSync(PASTA, { recursive: true });
  const creds = lerCreds() as ReturnType<typeof lerCreds> & { org_id: string };
  const banco = servico();

  // O titular já é um contato da clínica, sem e-mail cadastrado.
  const nome = `Titular Balcão ${Date.now().toString().slice(-6)}`;
  const contato = await banco
    .from("contacts")
    .insert({ organization_id: creds.org_id, name: nome, phone_number: `+55119${Date.now().toString().slice(-8)}` })
    .select("id")
    .single();
  if (contato.error) throw contato.error;
  const contatoId = contato.data.id as string;

  const recebidoEm = diasAtras(3);
  const prazo = computeDueAt(instanteDoRecebimento(recebidoEm), 7);

  await loginComoAdmin(page, creds);
  await page.goto("/app/lgpd/requests");

  // 1. Registrar.
  await page.getByRole("button", { name: "Registrar pedido" }).click();
  const dialogo = page.getByRole("dialog");
  await dialogo.getByLabel("De quem é o pedido").fill(nome);
  await dialogo.getByRole("button", { name: new RegExp(nome) }).click();
  await dialogo.getByLabel("Como o pedido chegou").selectOption("presencial");
  await dialogo.getByLabel("Dia em que a pessoa pediu").fill(recebidoEm);
  await dialogo.getByLabel(/Observação/).fill("Pediu no balcão, com documento.");
  await page.screenshot({ path: `${PASTA}/1-formulario.png`, fullPage: true });
  await dialogo.getByRole("button", { name: "Registrar pedido" }).click();
  await expect(page.getByText(`Pedido registrado. Prazo: ${prazoEmBr(prazo)}`)).toBeVisible({ timeout: 30_000 });

  const criado = await banco
    .from("lgpd_requests")
    .select("id, source, status, received_at, due_at, request_payload")
    .eq("organization_id", creds.org_id)
    .eq("contact_id", contatoId)
    .single();
  if (criado.error) throw criado.error;
  const pedidoId = criado.data.id as string;
  expect(criado.data).toMatchObject({
    source: "manual",
    status: "received",
    request_payload: { channel: "presencial", note: "Pediu no balcão, com documento.", delivery: null },
  });
  // O prazo conta do dia em que a pessoa pediu, não de hoje.
  expect(new Date(criado.data.received_at as string).toISOString()).toBe(`${recebidoEm}T12:00:00.000Z`);
  expect(new Date(criado.data.due_at as string).toISOString()).toBe(prazo.toISOString());

  // Registrar não põe nada para andar: nenhum evento para o worker.
  const eventos = await banco.from("event_log").select("id").eq("entity_id", pedidoId);
  expect(eventos.data ?? []).toHaveLength(0);

  // 2. Aparece na lista, Recebido; a página do pedido mostra o prazo e por onde chegou.
  const linha = page.getByRole("row").filter({ hasText: pedidoId.slice(0, 8) });
  await expect(linha).toContainText("Recebido", { timeout: 30_000 });
  await page.screenshot({ path: `${PASTA}/2-lista-recebido.png`, fullPage: true });
  await linha.getByRole("link", { name: "Ver" }).click();
  await page.waitForURL(new RegExp(`/app/lgpd/requests/${pedidoId}`));
  await expect(page.getByText(`Vence em ${prazoEmBr(prazo)}`)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Pessoalmente", { exact: true })).toBeVisible();
  await expect(page.getByText("lgpd.data_request_received")).toBeVisible();
  await expect(page.getByRole("button", { name: "Marcar como entregue" })).toHaveCount(0);

  // 3. Registrar de novo o mesmo pedido é recusado, com a ligação para o que existe.
  await page.goto("/app/lgpd/requests");
  await page.getByRole("button", { name: "Registrar pedido" }).click();
  await dialogo.getByLabel("De quem é o pedido").fill(nome);
  await dialogo.getByRole("button", { name: new RegExp(nome) }).click();
  await dialogo.getByRole("button", { name: "Registrar pedido" }).click();
  await expect(dialogo.getByRole("alert")).toContainText("já tem um pedido igual em aberto");
  await page.screenshot({ path: `${PASTA}/3-duplicata-recusada.png`, fullPage: true });
  await dialogo.getByRole("link", { name: "Abrir o pedido em aberto" }).click();
  await page.waitForURL(new RegExp(`/app/lgpd/requests/${pedidoId}`));

  // 4. Aprovar, e o dreno gera o relatório: sem e-mail, vira revisão pendente.
  await page.getByRole("button", { name: "Aprovar export" }).click();
  await page.locator("#approved_reason").fill("Titular confirmou a identidade no balcão da clínica.");
  await page.getByRole("button", { name: "Confirmar aprovação" }).click();
  await expect(page.getByText("Processando", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  expect(await drenarAteSairDeProcessando(page, banco, pedidoId)).toBe("pending_review");
  await page.reload();
  await expect(page.getByText("Revisão pendente", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  expect((await baixarPdfDaTela(page)).length).toBeGreaterThan(1000);
  await page.screenshot({ path: `${PASTA}/4-revisao-pendente.png`, fullPage: true });

  // 5. Marcar como entregue: pede confirmação, e fecha o pedido.
  await page.getByRole("button", { name: "Marcar como entregue" }).click();
  const confirmacao = page.getByRole("alertdialog");
  await confirmacao.getByLabel("Como foi entregue").selectOption("presencial");
  await confirmacao.getByLabel(/Observação/).fill("Retirou na recepção.");
  await page.screenshot({ path: `${PASTA}/5-confirmar-entrega.png`, fullPage: true });
  await confirmacao.getByRole("button", { name: "Confirmar entrega" }).click();
  await expect(page.getByText("Concluído", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Em mãos, pessoalmente")).toBeVisible();
  await expect(page.getByText("lgpd.export_delivered")).toBeVisible();
  await expect(page.getByRole("button", { name: "Marcar como entregue" })).toHaveCount(0);
  await page.screenshot({ path: `${PASTA}/6-concluido.png`, fullPage: true });

  const fechado = await banco
    .from("lgpd_requests")
    .select("status, completed_at, error_message, result")
    .eq("id", pedidoId)
    .single();
  expect(fechado.data).toMatchObject({
    status: "completed",
    error_message: null,
    result: {
      pdf_path: `${creds.org_id}/${pedidoId}/report.pdf`,
      manual_delivery: { method: "presencial", note: "Retirou na recepção." },
    },
  });
  expect(fechado.data?.completed_at).toBeTruthy();

  const trilha = await banco
    .from("api_audit_log")
    .select("action, actor_user_id, metadata")
    .eq("organization_id", creds.org_id)
    .eq("resource_id", pedidoId)
    .in("action", ["lgpd.data_request_received", "lgpd.export_delivered"]);
  expect((trilha.data ?? []).map((l) => l.action).sort()).toEqual([
    "lgpd.data_request_received",
    "lgpd.export_delivered",
  ]);
  for (const l of trilha.data ?? []) expect(l.actor_user_id).toBeTruthy();

  await page.goto("/app/lgpd/requests");
  await expect(page.getByRole("row").filter({ hasText: pedidoId.slice(0, 8) })).toContainText("Concluído", {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${PASTA}/7-lista-concluido.png`, fullPage: true });
});

test("pedido de apagamento registrado pela tela fica parado até alguém aprovar", async ({ page }) => {
  test.setTimeout(240_000);
  fs.mkdirSync(PASTA, { recursive: true });
  const creds = lerCreds() as ReturnType<typeof lerCreds> & { org_id: string };
  const banco = servico();
  const nome = `Titular Apagar ${Date.now().toString().slice(-6)}`;
  const contato = await banco
    .from("contacts")
    .insert({ organization_id: creds.org_id, name: nome, phone_number: `+55118${Date.now().toString().slice(-8)}` })
    .select("id")
    .single();
  if (contato.error) throw contato.error;

  await loginComoAdmin(page, creds);
  await page.goto("/app/lgpd/requests");
  await page.getByRole("button", { name: "Registrar pedido" }).click();
  const dialogo = page.getByRole("dialog");
  await dialogo.getByLabel("De quem é o pedido").fill(nome);
  await dialogo.getByRole("button", { name: new RegExp(nome) }).click();
  await dialogo.getByLabel("O que a pessoa pediu").selectOption("redact");
  await expect(dialogo.getByRole("note")).toContainText("Registrar não apaga nada");
  await page.screenshot({ path: `${PASTA}/8-apagamento-aviso.png`, fullPage: true });
  await dialogo.getByRole("button", { name: "Registrar pedido" }).click();
  await expect(page.getByText(/Pedido registrado\. Prazo:/)).toBeVisible({ timeout: 30_000 });

  // O dreno roda (é o que o scheduler faz a cada minuto) e NADA acontece com o contato.
  const segredo = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  const dreno = await page.request.post("/api/v1/cron/event-log-drain", {
    headers: { authorization: `Bearer ${segredo}` },
    timeout: 120_000,
  });
  expect(dreno.status()).toBe(200);

  const pedido = await banco
    .from("lgpd_requests")
    .select("id, status, attempts")
    .eq("contact_id", contato.data.id)
    .single();
  expect(pedido.data).toMatchObject({ status: "received", attempts: 0 });
  const titular = await banco.from("contacts").select("name, is_anonymized").eq("id", contato.data.id).single();
  expect(titular.data).toMatchObject({ name: nome, is_anonymized: false });
  const eventos = await banco.from("event_log").select("id").eq("entity_id", pedido.data!.id);
  expect(eventos.data ?? []).toHaveLength(0);

  // E a página do pedido oferece a aprovação, com o aviso de que não tem volta.
  await page.goto(`/app/lgpd/requests/${pedido.data!.id}`);
  await page.getByRole("button", { name: "Aprovar anonimização" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("irreversível");
  await page.screenshot({ path: `${PASTA}/9-apagamento-espera-aprovacao.png`, fullPage: true });
  await page.getByRole("button", { name: "Cancelar" }).click();
});

/**
 * O EVENTO NÃO AUTORIZA: A APROVAÇÃO, GRAVADA NO PEDIDO, AUTORIZA (migration 0357).
 *
 * "Ninguém emite o evento antes da hora" era a única proteção do pedido acima.
 * Aqui o evento É emitido antes da hora, do jeito que qualquer peça do servidor
 * conseguiria (uma automação, um reprocessamento, o webhook de uma loja), com
 * uma "aprovação" escrita no payload. O dreno roda e o paciente continua lá.
 * Depois o administrador aprova pela tela, e só então o contato é anonimizado.
 */
test("apagamento: evento emitido sem aprovação não anonimiza; aprovado pela tela, anonimiza", async ({ page }) => {
  test.setTimeout(300_000);
  const PASTA_DO_PORTAO = ".superpowers/evidence/lgpd-exclusao-exige-aprovacao";
  fs.mkdirSync(PASTA_DO_PORTAO, { recursive: true });
  const creds = lerCreds() as ReturnType<typeof lerCreds> & { org_id: string };
  const banco = servico();
  const nome = `Titular Portão ${Date.now().toString().slice(-6)}`;
  const contato = await banco
    .from("contacts")
    .insert({ organization_id: creds.org_id, name: nome, phone_number: `+55117${Date.now().toString().slice(-8)}` })
    .select("id")
    .single();
  if (contato.error) throw contato.error;
  const contatoId = contato.data.id as string;

  await loginComoAdmin(page, creds);
  await page.goto("/app/lgpd/requests");
  await page.getByRole("button", { name: "Registrar pedido" }).click();
  const dialogo = page.getByRole("dialog");
  await dialogo.getByLabel("De quem é o pedido").fill(nome);
  await dialogo.getByRole("button", { name: new RegExp(nome) }).click();
  await dialogo.getByLabel("O que a pessoa pediu").selectOption("redact");
  await dialogo.getByRole("button", { name: "Registrar pedido" }).click();
  await expect(page.getByText(/Pedido registrado\. Prazo:/)).toBeVisible({ timeout: 30_000 });

  const registrado = await banco.from("lgpd_requests").select("id").eq("contact_id", contatoId).single();
  if (registrado.error) throw registrado.error;
  const pedidoId = registrado.data.id as string;

  // 1. Alguém emite o evento sem passar pela tela, dizendo que está aprovado.
  const emitido = await banco.rpc("emit_event", {
    p_event_type: "lgpd.redact_received",
    p_entity_kind: "lgpd_request",
    p_entity_id: pedidoId,
    p_payload: { request_id: pedidoId, manually_approved: true, approved_by: contatoId, approved_reason: "escrito no evento, sem tela" },
    p_metadata: { manually_approved: true },
    p_organization_id: creds.org_id,
  });
  if (emitido.error) throw emitido.error;

  const segredo = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  const drenar = async () => {
    const r = await page.request.post("/api/v1/cron/event-log-drain", {
      headers: { authorization: `Bearer ${segredo}` },
      timeout: 120_000,
    });
    expect(r.status()).toBe(200);
  };
  // O dreno é global: repete até ESTE evento ter sido consumido.
  let evento: { status: string; last_error: string | null } | null = null;
  for (let volta = 0; volta < 5; volta++) {
    await drenar();
    const linha = await banco
      .from("event_log")
      .select("status, last_error")
      .eq("entity_id", pedidoId)
      .eq("event_type", "lgpd.redact_received")
      .single();
    if (linha.error) throw linha.error;
    evento = linha.data as { status: string; last_error: string | null };
    if (evento.status !== "pending" && evento.status !== "processing") break;
  }
  // Consumido (não fica tentando para sempre), e o motivo fica escrito.
  expect(evento!.status).not.toBe("pending");
  expect(evento!.last_error ?? "").toContain("not_approved:not_approved");

  const depoisDoEvento = await banco.from("lgpd_requests").select("status, attempts").eq("id", pedidoId).single();
  expect(depoisDoEvento.data).toMatchObject({ status: "received", attempts: 0 });
  const intacto = await banco.from("contacts").select("name, is_anonymized").eq("id", contatoId).single();
  expect(intacto.data).toMatchObject({ name: nome, is_anonymized: false });

  await page.goto("/app/lgpd/requests");
  const linhaDaLista = page.getByRole("row").filter({ hasText: pedidoId.slice(0, 8) });
  await expect(linhaDaLista).toContainText("Recebido", { timeout: 30_000 });
  await page.screenshot({ path: `${PASTA_DO_PORTAO}/1-evento-sem-aprovacao-continua-recebido.png`, fullPage: true });

  // 2. O administrador aprova pela tela, com justificativa.
  await page.goto(`/app/lgpd/requests/${pedidoId}`);
  await page.getByRole("button", { name: "Aprovar anonimização" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("irreversível");
  await page.locator("#approved_reason").fill("Paciente pediu o apagamento por escrito no balcão.");
  await page.screenshot({ path: `${PASTA_DO_PORTAO}/2-aprovar-com-justificativa.png`, fullPage: true });
  await page.getByRole("button", { name: "Confirmar aprovação" }).click();
  await expect(page.getByText("Processando", { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  const aprovado = await banco.from("lgpd_requests").select("request_payload").eq("id", pedidoId).single();
  const prova = (aprovado.data!.request_payload as { approval: Record<string, string> }).approval;
  expect(prova).toMatchObject({
    request_id: pedidoId,
    organization_id: creds.org_id,
    contact_id: contatoId,
    approved_reason: "Paciente pediu o apagamento por escrito no balcão.",
  });
  // Quem ficou gravado como aprovador é administrador desta organização.
  const papel = await banco
    .from("user_organizations")
    .select("role")
    .eq("organization_id", creds.org_id)
    .eq("user_id", prova.approved_by)
    .single();
  expect(papel.data).toMatchObject({ role: "admin" });

  // 3. O dreno roda e agora, sim, o contato é anonimizado e o pedido conclui.
  expect(await drenarAteSairDeProcessando(page, banco, pedidoId)).toBe("completed");
  const anonimizado = await banco.from("contacts").select("name, display_name, is_anonymized").eq("id", contatoId).single();
  expect(anonimizado.data).toMatchObject({
    name: `Cliente Anonimizado #${contatoId.slice(0, 8)}`,
    is_anonymized: true,
  });

  await page.reload();
  await expect(page.getByText("Concluído", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${PASTA_DO_PORTAO}/3-pedido-concluido.png`, fullPage: true });

  await page.goto("/app/lgpd/requests");
  await expect(page.getByRole("row").filter({ hasText: pedidoId.slice(0, 8) })).toContainText("Concluído", {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${PASTA_DO_PORTAO}/4-lista-concluido.png`, fullPage: true });

  await page.goto(`/app/contacts/${contatoId}`);
  await expect(page.getByText(`Cliente Anonimizado #${contatoId.slice(0, 8)}`).first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: `${PASTA_DO_PORTAO}/5-contato-anonimizado.png`, fullPage: true });
});
