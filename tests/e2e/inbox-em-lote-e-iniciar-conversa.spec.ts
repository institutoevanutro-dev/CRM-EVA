import * as path from "node:path";

import { expect, test } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

/**
 * Inbox em lote e "Iniciar conversa", pela tela (portes do upstream #2909 e
 * #2838).
 *
 * 1. Marcar duas conversas e Fechar: as DUAS fecham pelo caminho de sempre
 *    (`fn_service_status`), com uma auditoria por conversa, e a terceira, não
 *    marcada, fica aberta. Marcar não abre a conversa.
 * 2. "Iniciar conversa" com um telefone novo: a conversa abre ASSUMIDA por quem
 *    iniciou, e a primeira mensagem vira UMA linha de saída pelo envio de
 *    sempre.
 */
const env = carregarEnvLocal();
const admin: SupabaseClient = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL!,
  env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const EVIDENCE = path.join(process.cwd(), ".superpowers/evidence");

const SESSAO = "aaaaaaaa-e2e0-4000-8000-00000000c901";
const NOMES = ["Lote Alfa Fixture", "Lote Beta Fixture", "Lote Gama Fixture"];
const TELEFONE_NOVO = "+5511987650123";

async function limpar(orgId: string) {
  const { data: contatos } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .or(`display_name.in.(${NOMES.map((n) => `"${n}"`).join(",")}),phone_number.eq.${TELEFONE_NOVO}`);
  const ids = (contatos ?? []).map((c) => (c as { id: string }).id);
  if (ids.length > 0) {
    await admin.from("messages").delete().in("contact_id", ids);
    await admin.from("conversations").delete().in("contact_id", ids);
    await admin.from("contacts").delete().in("id", ids);
  }
  await admin.from("channel_sessions").delete().eq("id", SESSAO);
}

async function semear(orgId: string): Promise<string[]> {
  await limpar(orgId);
  const { error: eSess } = await admin.from("channel_sessions").insert({
    id: SESSAO,
    organization_id: orgId,
    waha_session_name: `lote-c-${Date.now()}`,
    webhook_secret_encrypted: "\\x00",
    status: "WORKING",
  });
  if (eSess) throw new Error(`fixture de canal falhou: ${eSess.message}`);
  const agora = new Date().toISOString();
  const conversas: string[] = [];
  for (const nome of NOMES) {
    const { data: ct, error: eCt } = await admin
      .from("contacts")
      .insert({ organization_id: orgId, display_name: nome })
      .select("id")
      .single();
    if (eCt) throw new Error(`fixture de contato falhou: ${eCt.message}`);
    const { data: cv, error: eConv } = await admin
      .from("conversations")
      .insert({
        organization_id: orgId,
        contact_id: (ct as { id: string }).id,
        channel_session_id: SESSAO,
        status: "open",
        assigned_to_user_id: null,
        bot_silenced_until: "infinity",
        last_inbound_at: agora,
        last_message_at: agora,
        last_message_preview: "mensagem de teste",
      })
      .select("id")
      .single();
    if (eConv) throw new Error(`fixture de conversa falhou: ${eConv.message}`);
    conversas.push((cv as { id: string }).id);
  }
  return conversas;
}

test.describe("Inbox: lote e Iniciar conversa", () => {
  test.describe.configure({ timeout: 180_000 });
  let orgId = "";
  let conversas: string[] = [];

  test.beforeEach(async () => {
    orgId = (lerCreds() as unknown as { org_id: string }).org_id;
    conversas = await semear(orgId);
  });
  test.afterEach(async () => {
    if (orgId) await limpar(orgId);
  });

  test("marcar duas conversas e Fechar fecha as duas, uma auditoria por conversa", async ({ page }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/inbox?filter=all");
    const [a, b, c] = conversas as [string, string, string];
    await expect(page.getByTestId(`selecao-em-lote-${a}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("barra-de-acoes-em-lote")).toHaveCount(0);

    await page.getByTestId(`selecao-em-lote-${a}`).click();
    await page.getByTestId(`selecao-em-lote-${b}`).click();
    // Marcar não abre a conversa.
    await expect(page).not.toHaveURL(new RegExp(a));
    await expect(page.getByTestId("barra-de-acoes-em-lote")).toContainText("2 conversas selecionadas");
    await page.screenshot({ path: path.join(EVIDENCE, "inbox-em-lote-selecao.png") });

    await page.getByTestId("lote-fechar").click();
    await expect(page.getByText("2 conversas fechadas.")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("barra-de-acoes-em-lote")).toHaveCount(0);

    const { data } = await admin.from("conversations").select("id, status").in("id", conversas);
    const status = new Map((data ?? []).map((r) => [r.id as string, r.status as string]));
    expect(status.get(a)).toBe("closed");
    expect(status.get(b)).toBe("closed");
    expect(status.get(c)).toBe("open");

    await expect
      .poll(async () => {
        const { data: linhas } = await admin
          .from("api_audit_log")
          .select("resource_id")
          .eq("organization_id", orgId)
          .eq("action", "conversation.closed")
          .in("resource_id", [a, b, c]);
        return (linhas ?? []).map((l) => l.resource_id as string).sort();
      }, { timeout: 10_000 })
      .toEqual([a, b].sort());
  });

  test("Iniciar conversa abre assumida por quem iniciou e envia UMA primeira mensagem", async ({ page }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/inbox?filter=all");
    await page.getByRole("button", { name: "Iniciar conversa" }).click();
    await page.getByLabel("Para quem").fill("(11) 98765-0123");
    await expect(page.getByText(/Novo contato/)).toContainText(TELEFONE_NOVO);
    await page.getByLabel("Primeira mensagem").fill("Bom dia, aqui é da clínica.");
    await page.screenshot({ path: path.join(EVIDENCE, "inbox-iniciar-conversa.png") });
    await page.getByRole("button", { name: "Criar conversa" }).click();
    await page.waitForURL(/\/app\/inbox\?id=/, { timeout: 30_000 });

    const { data: contato } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("phone_number", TELEFONE_NOVO)
      .single();
    const { data: conversa } = await admin
      .from("conversations")
      .select("id, assigned_to_user_id, assignee_kind")
      .eq("contact_id", (contato as { id: string }).id)
      .single();
    expect(conversa?.assignee_kind).toBe("user");
    expect(conversa?.assigned_to_user_id).toBeTruthy();
    await expect(page).toHaveURL(new RegExp(conversa!.id as string));

    await expect
      .poll(async () => {
        const { data: msgs } = await admin
          .from("messages")
          .select("body, direction")
          .eq("conversation_id", conversa!.id as string)
          .eq("direction", "outbound");
        return msgs ?? [];
      }, { timeout: 15_000 })
      .toEqual([{ body: "Bom dia, aqui é da clínica.", direction: "outbound" }]);
  });
});
