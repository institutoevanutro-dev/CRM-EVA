/**
 * BAIXAR A CONVERSA EM PDF, provado pela tela e lendo o arquivo que desceu.
 *
 * O teste de rota (`app/api/v1/conversations/[id]/export/route.test.ts`) usa um
 * banco falso: ele prova a regra da rota, não a RLS. Aqui o banco é o do
 * baseline, então "conversa de outra organização" e "conversa que este
 * atendente não enxerga" são recusadas pela política de verdade.
 *
 * A nota interna aparece NA TELA (a equipe a vê na conversa) e não pode
 * aparecer NO ARQUIVO. Por isso o caso confere as duas pontas: sem a primeira,
 * a ausência no PDF passaria por vacuidade.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/inbox-conversa-em-pdf.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { extractPdfText } from "../../lib/ai/rag/extractors/pdf";
import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/conversa-em-pdf");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// A limpeza apaga por prefixo, não pelos ids desta execução: o Playwright
// reinicia o worker depois de um vermelho e o módulo é reavaliado.
const PREFIXO = "Conversa em PDF E2E";
const NOME_DO_CONTATO = `${PREFIXO} ${Date.now()}`;
const SLUG_DA_OUTRA_ORG = "e2e-conversa-em-pdf-outra-org";
const NOTA = "NOTA INTERNA SO DA EQUIPE";

let creds: Creds;
let conversaId = "";
let conversaDoColegaId = "";
let conversaDaOutraOrgId = "";

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function limpar(): Promise<void> {
  await admin.from("organizations").delete().eq("slug", SLUG_DA_OUTRA_ORG);
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("display_name", `${PREFIXO}%`);
  const ids = ((data as Array<{ id: string }> | null) ?? []).map((c) => c.id);
  if (ids.length === 0) return;
  await admin.from("messages").delete().in("contact_id", ids);
  await admin.from("conversations").delete().in("contact_id", ids);
  await admin.from("contacts").delete().in("id", ids);
}

async function inserir<T = { id: string }>(tabela: string, linha: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.from(tabela).insert(linha).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return data as T;
}

/** Canal + contato + conversa numa organização. */
async function criarConversa(orgId: string, nome: string, donoId: string | null): Promise<{ conversa: string; contato: string; sessao: string }> {
  const { data: existente } = await admin.from("channel_sessions").select("id").eq("organization_id", orgId).limit(1).maybeSingle();
  const sessao =
    (existente as { id: string } | null)?.id ??
    (await inserir("channel_sessions", {
      organization_id: orgId,
      waha_session_name: `e2e-conversa-pdf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      webhook_secret_encrypted: "e2e",
    })).id;
  const contato = (
    await inserir("contacts", {
      organization_id: orgId,
      display_name: nome,
      phone_number: `+55279${String(Date.now() + Math.floor(Math.random() * 1000)).slice(-8)}`,
    })
  ).id;
  const conversa = (
    await inserir("conversations", {
      organization_id: orgId,
      contact_id: contato,
      channel_session_id: sessao,
      status: "open",
      assigned_to_user_id: donoId,
      last_message_at: new Date().toISOString(),
      last_inbound_at: new Date().toISOString(),
    })
  ).id;
  return { conversa, contato, sessao };
}

test.describe("Inbox: baixar a conversa em PDF", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limpar();

    const principal = await criarConversa(creds.org_id, NOME_DO_CONTATO, null);
    conversaId = principal.conversa;
    const base = {
      organization_id: creds.org_id,
      conversation_id: conversaId,
      channel_session_id: principal.sessao,
      contact_id: principal.contato,
    };
    // 12:00Z de 01/09/2026 = 09:00 no fuso padrão da organização (São Paulo).
    const em = (minuto: number) => new Date(Date.parse("2026-09-01T12:00:00.000Z") + minuto * 60_000).toISOString();
    const linhas: Array<Record<string, unknown>> = [
      { ...base, type: "text", direction: "inbound", status: "delivered", sent_via: "external_device", body: "PACIENTE PERGUNTA DO EXAME", sent_at: em(0) },
      { ...base, type: "text", direction: "outbound", status: "sent", sent_via: "ai", body: "ASSISTENTE RESPONDE", metadata: { ai_actor_id: "e2e-agente", tool_calls: ["DADO_INTERNO_DA_IA"] }, sent_at: em(1) },
      { ...base, type: "text", direction: "outbound", status: "sent", sent_via: "user", sent_by_user_id: creds.users.agent!.id, body: "EQUIPE RESPONDE PELO CRM", sent_at: em(2) },
      { ...base, type: "text", direction: "outbound", status: "sent", sent_via: "external_device", body: "EQUIPE RESPONDE PELO CELULAR", sent_at: em(3) },
      {
        ...base,
        type: "document",
        direction: "inbound",
        status: "delivered",
        sent_via: "external_device",
        body: null,
        media_mime: "application/pdf",
        media_storage_path: `${creds.org_id}/${conversaId}/exame.pdf`,
        metadata: { media_filename: "exame-de-sangue.pdf" },
        sent_at: em(4),
      },
      { ...base, type: "text", direction: "outbound", status: "failed", sent_via: "user", sent_by_user_id: creds.users.agent!.id, body: "ESTA NAO CHEGOU", sent_at: em(5) },
    ];
    // Uma a uma: em lote o PostgREST manda NULL nas chaves que a linha não tem.
    for (const linha of linhas) {
      const { error } = await admin.from("messages").insert(linha);
      if (error) throw new Error(`messages (${String(linha.body)}): ${error.message}`);
    }
    await inserir("conversation_notes", {
      organization_id: creds.org_id,
      conversation_id: conversaId,
      body: NOTA,
      created_by_user_id: creds.users.agent!.id,
      created_by_name: "E2E Agent",
    });

    // Uma conversa do COLEGA: no modo `own_and_unassigned` o agente não a enxerga.
    const doColega = await criarConversa(creds.org_id, `${PREFIXO} do colega ${Date.now()}`, creds.users.manager!.id);
    conversaDoColegaId = doColega.conversa;
    await admin.from("messages").insert({
      organization_id: creds.org_id,
      conversation_id: conversaDoColegaId,
      channel_session_id: doColega.sessao,
      contact_id: doColega.contato,
      type: "text",
      direction: "inbound",
      status: "delivered",
      sent_via: "external_device",
      body: "SEGREDO DA CONVERSA DO COLEGA",
    });

    // OUTRA organização, com a própria conversa.
    const outraOrg = (
      await inserir("organizations", {
        slug: SLUG_DA_OUTRA_ORG,
        display_name: "Outra Clinica E2E",
        legal_name: "Outra Clinica E2E LTDA",
      })
    ).id;
    const daOutra = await criarConversa(outraOrg, "Paciente da outra clinica", null);
    conversaDaOutraOrgId = daOutra.conversa;
    await admin.from("messages").insert({
      organization_id: outraOrg,
      conversation_id: conversaDaOutraOrgId,
      channel_session_id: daOutra.sessao,
      contact_id: daOutra.contato,
      type: "text",
      direction: "inbound",
      status: "delivered",
      sent_via: "external_device",
      body: "SEGREDO DA OUTRA CLINICA",
    });
  });

  test.afterAll(async () => {
    await limpar();
  });

  test("quem atende clica no botão, recebe um PDF de verdade, e a nota interna não está nele", async ({ page }) => {
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto(`/app/inbox/${conversaId}`);
    await expect(page.getByText("PACIENTE PERGUNTA DO EXAME").first()).toBeVisible({ timeout: 60_000 });

    // A nota e o documento ESTÃO na tela. É o que dá sentido às ausências abaixo.
    await expect(page.getByText(NOTA).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("exame-de-sangue.pdf").first()).toBeVisible();

    const botao = page.getByTestId("exportar-conversa-pdf");
    await expect(botao).toBeVisible();
    await expect(botao).toHaveAttribute("aria-label", "Baixar a conversa em PDF");
    await page.screenshot({ path: path.join(EVIDENCIA, "01-conversa-com-o-botao.png") });

    const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), botao.click()]);
    expect(download.suggestedFilename()).toMatch(/^historico-conversa-conversa-em-pdf-e2e-.*\d{4}-\d{2}-\d{2}\.pdf$/);
    const destino = path.join(EVIDENCIA, "conversa.pdf");
    await download.saveAs(destino);
    await expect(page.getByText("PDF da conversa baixado.")).toBeVisible({ timeout: 15_000 });
    await expect(botao).toBeEnabled();
    await page.screenshot({ path: path.join(EVIDENCIA, "02-depois-de-baixar.png") });

    const bytes = fs.readFileSync(destino);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("%PDF");
    const texto = (await extractPdfText(bytes)).replace(/\s+/g, " ");
    fs.writeFileSync(path.join(EVIDENCIA, "conversa.txt"), texto);

    // Cabeçalho: organização, contato, canal, período, quem exportou, aviso.
    expect(texto).toContain("Histórico da conversa");
    expect(texto).toContain(NOME_DO_CONTATO);
    expect(texto).toContain("WhatsApp");
    expect(texto).toContain("Período: 01/09/2026 09:00 a 01/09/2026 09:05");
    expect(texto).toContain("Mensagens: 6");
    expect(texto).toContain("Exportado por: E2E Agent em");
    expect(texto).toContain("contém dados pessoais");

    // Quem falou, na ordem, no fuso da organização.
    const trechos = [
      `${NOME_DO_CONTATO} · 01/09/2026 09:00 · recebida`,
      "PACIENTE PERGUNTA DO EXAME",
      "Assistente virtual (IA) · 01/09/2026 09:01 · enviada",
      "ASSISTENTE RESPONDE",
      "E2E Agent (equipe) · 01/09/2026 09:02 · enviada",
      "EQUIPE RESPONDE PELO CRM",
      "Equipe (pelo celular) · 01/09/2026 09:03 · enviada",
      "EQUIPE RESPONDE PELO CELULAR",
      "[Documento: exame-de-sangue.pdf]",
      "E2E Agent (equipe) · 01/09/2026 09:05 · não enviada: o envio falhou",
      "ESTA NAO CHEGOU",
    ];
    let cursor = -1;
    for (const trecho of trechos) {
      const posicao = texto.indexOf(trecho, cursor + 1);
      expect(posicao, `"${trecho}" devia estar no PDF, depois do trecho anterior`).toBeGreaterThan(cursor);
      cursor = posicao;
    }

    // O que NÃO sai.
    expect(texto).not.toContain(NOTA);
    expect(texto).not.toContain("DADO_INTERNO_DA_IA");
    expect(texto).not.toContain(creds.org_id); // caminho do Storage

    // Auditoria: uma linha, com contagem e sem texto de mensagem.
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("api_audit_log")
            .select("actor_user_id, metadata")
            .eq("organization_id", creds.org_id)
            .eq("action", "conversation.exported")
            .eq("resource_id", conversaId);
          return data ?? [];
        },
        { timeout: 15_000 },
      )
      .toHaveLength(1);
    const { data: linhas } = await admin
      .from("api_audit_log")
      .select("actor_user_id, metadata")
      .eq("action", "conversation.exported")
      .eq("resource_id", conversaId);
    expect(linhas![0]!.actor_user_id).toBe(creds.users.agent!.id);
    expect(linhas![0]!.metadata).toMatchObject({ mensagens: 6, formato: "pdf", truncada: false, acesso: "leitura" });
    expect(JSON.stringify(linhas![0]!.metadata)).not.toContain("PACIENTE");
  });

  test("o botão continua ao alcance na largura estreita", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 720 });
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto(`/app/inbox/${conversaId}`);
    await expect(page.getByText("PACIENTE PERGUNTA DO EXAME").first()).toBeVisible({ timeout: 60_000 });
    const botao = page.getByTestId("exportar-conversa-pdf");
    await expect(botao).toBeVisible();
    const caixa = (await botao.boundingBox())!;
    expect(caixa.x).toBeGreaterThanOrEqual(0);
    expect(caixa.x + caixa.width).toBeLessThanOrEqual(1024);
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await page.screenshot({ path: path.join(EVIDENCIA, "03-largura-1024.png") });
  });

  test("somente leitura não vê o botão e a rota recusa", async ({ page }) => {
    await login(page, creds.users.viewer!.email, creds.password);
    await page.goto(`/app/inbox/${conversaId}`);
    await expect(page.getByText("PACIENTE PERGUNTA DO EXAME").first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("exportar-conversa-pdf")).toHaveCount(0);

    const res = await page.request.get(`/api/v1/conversations/${conversaId}/export?formato=pdf`);
    expect(res.status()).toBe(403);
  });

  test("conversa de outra organização e conversa do colega: 404 pela política do banco", async ({ page }) => {
    // O modo de visibilidade é da organização do seed, que outras specs usam:
    // fixa `own_and_unassigned` só durante o caso e devolve o que estava.
    const { data: org } = await admin.from("organizations").select("settings").eq("id", creds.org_id).single();
    const antes = (org as { settings: Record<string, unknown> | null }).settings ?? {};
    await admin.from("organizations").update({ settings: { ...antes, visibility_mode: "own_and_unassigned" } }).eq("id", creds.org_id);
    try {
      await login(page, creds.users.agent!.email, creds.password);

      const outra = await page.request.get(`/api/v1/conversations/${conversaDaOutraOrgId}/export?formato=pdf`);
      expect(outra.status()).toBe(404);
      expect(await outra.text()).not.toContain("SEGREDO");

      const doColega = await page.request.get(`/api/v1/conversations/${conversaDoColegaId}/export?formato=pdf`);
      expect(doColega.status()).toBe(404);
      expect(await doColega.text()).not.toContain("SEGREDO");

      // Controle: a mesma sessão exporta a conversa que enxerga. Sem isto, um
      // 404 para tudo passaria nos dois casos acima.
      const propria = await page.request.get(`/api/v1/conversations/${conversaId}/export?formato=pdf`);
      expect(propria.status()).toBe(200);
      expect(propria.headers()["content-type"]).toBe("application/pdf");
    } finally {
      await admin.from("organizations").update({ settings: antes }).eq("id", creds.org_id);
    }

    const { count } = await admin
      .from("api_audit_log")
      .select("id", { count: "exact", head: true })
      .eq("action", "conversation.exported")
      .in("resource_id", [conversaDaOutraOrgId, conversaDoColegaId]);
    expect(count).toBe(0);
  });
});
