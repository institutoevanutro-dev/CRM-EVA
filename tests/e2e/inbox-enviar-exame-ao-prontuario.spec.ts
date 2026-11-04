/**
 * EXAMES DO WHATSAPP → PRONTUÁRIO, PELA TELA, COM O PRONTUÁRIO FALSO DE VERDADE.
 *
 * Jornada J42 (`docs/testing/user-journey-map.md`). A recepção clica "Enviar ao
 * prontuário" num PDF ou foto que o paciente mandou; o CRM chama o Prontuário,
 * que busca a lista e o arquivo de volta no CRM com a chave
 * `prontuario:media:read`, e a mensagem ganha o selo "No prontuário".
 *
 * O Prontuário é um receptor HTTP REAL na porta fixa 47814 (`PRONTUARIO_URL`
 * do `.env.e2e`, ver `scripts/gerar-env-e2e.sh`). Ele confere o Bearer, a
 * `Idempotency-Key` e o corpo, e no caminho "vinculado" faz o que o Prontuário
 * faz: lista com `dias=60`, VALIDA cada item com as regras de `itemDoCrm` do
 * Prontuário (item reprovado → responde 500 com o motivo, em vez de o achar
 * pelo id), baixa o arquivo e confere tipo, tamanho e SHA-256 contra o semeado.
 *
 * Organização PRÓPRIA da spec, com id fixo (`PRONTUARIO_ORGANIZATION_ID`): só
 * nela a integração está acesa. O seed compartilhado fica intocado — e é nele
 * que o caso 12 prova a instalação sem a integração. Nomes fictícios.
 *
 * A chave é criada PELA TELA pelo admin da organização da spec.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { test, expect, type Browser, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { CODIGO_DO_PRONTUARIO_VINCULO_NAO_CONFIRMADO } from "../../lib/integrations/prontuario/cliente";
import { lerCreds } from "./helpers/login-admin";

const ORG = process.env.PRONTUARIO_ORGANIZATION_ID ?? "";
const SEGREDO = process.env.PRONTUARIO_EXAMES_SEGREDO ?? "";
const URL_DO_FALSO = process.env.PRONTUARIO_URL ?? "";
// O mesmo endereço do `playwright.config.ts` (o falso chama o CRM de volta).
const BASE = `http://localhost:${process.env.E2E_PORT ?? "3001"}`;
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "exames-whatsapp");
const EXAME_FIXO = "e2e0e2e0-0000-4000-8000-0000000e2a11";
const SENHA = `Local-${randomBytes(9).toString("base64url")}!`;
const PREFIXO = `e2e-exames-${Date.now()}`;

const c = credenciaisSupabaseDeTeste();
const db = createClient(c.url, c.serviceRole, { auth: { persistSession: false } });

type Comportamento = "vinculado" | "clinico" | "nao_vinculado" | "oscilante" | "recusado" | "nao_confirmado";
type Pedido = { contact_id: string; message_id: string; enviado_por: string; chave: string | null; comportamento: Comportamento };

const pessoas: Record<string, { id: string; email: string; nome: string }> = {};
const comportamentoDoContato = new Map<string, Comportamento>();
const bytesDaMensagem = new Map<string, { bytes: Buffer; mime: string }>();
const pedidos: Pedido[] = [];
const listagens: string[] = [];
const reprovacoes: string[] = [];
const jaGravados = new Set<string>();
let chaveDeLeitura = "";
let falso: http.Server;
let sessao = "";

const conv: Record<string, { conversa: string; contato: string }> = {};
const msg: Record<string, string> = {};
const msgDoSeed = { id: "", conversa: "" };

/** As regras de `itemDoCrm` e `marcar` do Prontuário (PR106:lib/exames-whatsapp.ts). */
function motivoDeReprovacao(i: Record<string, unknown>): string | null {
  if (typeof i.message_id !== "string" || !/^[A-Za-z0-9._@:-]{1,200}$/.test(i.message_id)) return "message_id";
  if (typeof i.received_at !== "string" || i.received_at.length < 1 || i.received_at.length > 40) return "received_at";
  if (typeof i.mime !== "string" || i.mime.length > 100) return "mime";
  if (typeof i.size_bytes !== "number" || !Number.isInteger(i.size_bytes) || i.size_bytes < 0) return "size_bytes";
  if (i.filename !== null && (typeof i.filename !== "string" || i.filename.length > 500)) return "filename";
  if (i.kind !== "documento" && i.kind !== "imagem") return "kind";
  return null;
}

function responder(res: http.ServerResponse, status: number, corpo: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(corpo));
}

async function buscarNoCrm(p: Pedido): Promise<{ status: number; corpo: unknown }> {
  const auth = { authorization: `Bearer ${chaveDeLeitura}` };
  const lista = await fetch(`${BASE}/api/v1/prontuario/contacts/${p.contact_id}/midias?dias=60`, { headers: auth });
  listagens.push(new URL(lista.url).search);
  if (!lista.ok) return { status: 503, corpo: { error: { code: "crm_indisponivel", message: `lista ${lista.status}` } } };
  const itens = ((await lista.json()) as { data: Record<string, unknown>[] }).data;
  for (const i of itens) {
    const motivo = motivoDeReprovacao(i);
    if (motivo) {
      reprovacoes.push(motivo);
      return { status: 500, corpo: { error: { code: "item_reprovado", message: motivo } } };
    }
  }
  const item = itens.find((i) => i.message_id === p.message_id);
  if (!item) return { status: 404, corpo: { error: { code: "midia_nao_encontrada", message: "x" } } };
  const arq = await fetch(`${BASE}/api/v1/prontuario/midias/${p.message_id}`, { headers: auth });
  const bytes = Buffer.from(await arq.arrayBuffer());
  const esperado = bytesDaMensagem.get(p.message_id)!;
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  if (
    arq.status !== 200 ||
    arq.headers.get("content-type") !== esperado.mime ||
    arq.headers.get("content-length") !== String(esperado.bytes.length) ||
    sha(bytes) !== sha(esperado.bytes)
  ) {
    reprovacoes.push(`arquivo:${arq.status}:${arq.headers.get("content-type")}:${arq.headers.get("content-length")}`);
    return { status: 500, corpo: { error: { code: "arquivo_diferente", message: "x" } } };
  }
  return { status: 0, corpo: null };
}

async function prontuarioFalso(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.method !== "POST" || req.url !== "/api/integracoes/crm/exames") return responder(res, 404, { error: "rota" });
  const pedacos: Buffer[] = [];
  for await (const p of req) pedacos.push(p as Buffer);
  if (req.headers.authorization !== `Bearer ${SEGREDO}`) return responder(res, 401, { error: { code: "nao_autorizado", message: "x" } });
  const corpo = JSON.parse(Buffer.concat(pedacos).toString("utf8")) as Omit<Pedido, "chave" | "comportamento">;
  const comportamento = comportamentoDoContato.get(corpo.contact_id) ?? "nao_vinculado";
  const chave = (req.headers["idempotency-key"] as string | undefined) ?? null;
  const tentativa = pedidos.filter((p) => p.message_id === corpo.message_id).length + 1;
  const pedido = { ...corpo, chave, comportamento };
  pedidos.push(pedido);
  if (chave !== corpo.message_id) return responder(res, 400, { error: { code: "pedido_invalido", message: "chave" } });

  if (comportamento === "recusado") return responder(res, 401, { error: { code: "nao_autorizado", message: "x" } });
  if (comportamento === "nao_vinculado") return responder(res, 404, { error: { code: "paciente_nao_vinculado", message: "x" } });
  if (comportamento === "nao_confirmado")
    return responder(res, 409, { error: { code: CODIGO_DO_PRONTUARIO_VINCULO_NAO_CONFIRMADO, message: "x" } });
  if (comportamento === "clinico") return responder(res, 200, { exam_id: EXAME_FIXO, ja_existia: true });
  if (comportamento === "oscilante" && tentativa === 1)
    return responder(res, 503, { error: { code: "crm_indisponivel", message: "x" } });

  if (jaGravados.has(corpo.message_id)) return responder(res, 200, { exam_id: EXAME_FIXO, ja_existia: true });
  const falha = await buscarNoCrm(pedido);
  if (falha.status) return responder(res, falha.status, falha.corpo);
  // Atraso de 1 s: dá tempo de a tela mostrar o "Enviando…".
  await new Promise((r) => setTimeout(r, 1_000));
  jaGravados.add(corpo.message_id);
  return responder(res, 201, { exam_id: EXAME_FIXO, ja_existia: false });
}

async function pessoa(chave: string, role: "admin" | "agent" | "viewer", nome: string) {
  const email = `${PREFIXO}-${chave}@exames.test`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: SENHA,
    email_confirm: true,
    user_metadata: { full_name: nome },
  });
  if (error || !data.user) throw new Error(`usuário ${chave}: ${error?.message}`);
  const v = await db.from("user_organizations").insert({
    organization_id: ORG,
    user_id: data.user.id,
    role,
    accepted_at: new Date().toISOString(),
  });
  if (v.error) throw new Error(`vínculo ${chave}: ${v.error.message}`);
  pessoas[chave] = { id: data.user.id, email, nome };
}

async function inserir(tabela: string, linha: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(linha).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return (data as { id: string }).id;
}

async function conversa(org: string, sessaoId: string, nome: string, comportamento: Comportamento | null) {
  const contato = await inserir("contacts", {
    organization_id: org,
    display_name: nome,
    phone_number: `+55279${String(Date.now() + Math.floor(Math.random() * 100000)).slice(-8)}`,
  });
  const id = await inserir("conversations", {
    organization_id: org,
    contact_id: contato,
    channel_session_id: sessaoId,
    status: "open",
    last_message_at: new Date().toISOString(),
    last_inbound_at: new Date().toISOString(),
  });
  if (comportamento) comportamentoDoContato.set(contato, comportamento);
  return { conversa: id, contato };
}

const PDF = Buffer.from("%PDF-1.4\n% exame ficticio\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(512), Buffer.from([0xff, 0xd9])]);

async function midia(
  org: string,
  sessaoId: string,
  c2: { conversa: string; contato: string },
  m: { type: string; mime: string; bytes?: Buffer; ext: string; direction?: "inbound" | "outbound"; falhou?: boolean; minutos?: number },
): Promise<string> {
  const id = randomUUID();
  const caminho = `${org}/${c2.conversa}/${id}.${m.ext}`;
  if (m.bytes && !m.falhou) {
    const up = await db.storage.from("whatsapp-media").upload(caminho, m.bytes, { contentType: m.mime, upsert: true });
    if (up.error) throw new Error(`upload: ${up.error.message}`);
    bytesDaMensagem.set(id, { bytes: m.bytes, mime: m.mime });
  }
  const { error } = await db.from("messages").insert({
    id,
    organization_id: org,
    conversation_id: c2.conversa,
    channel_session_id: sessaoId,
    contact_id: c2.contato,
    type: m.type,
    direction: m.direction ?? "inbound",
    status: "delivered",
    sent_via: "external_device",
    body: null,
    media_mime: m.mime,
    media_size_bytes: m.bytes?.length ?? 4096,
    media_url: m.falhou ? "https://midia.exemplo.invalid/expirada" : null,
    media_storage_path: m.falhou ? null : caminho,
    metadata: m.falhou ? { media_status: "failed" } : { media_filename: `exame-ficticio.${m.ext}` },
    sent_at: new Date(Date.now() - (m.minutos ?? 10) * 60_000).toISOString(),
  });
  if (error) throw new Error(`messages: ${error.message}`);
  return id;
}

async function entrar(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(SENHA);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

const bolha = (page: Page, messageId: string) => page.locator(`[data-message-id="${messageId}"]`);

test.describe.serial("Inbox: enviar exame ao Prontuário", () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(async () => {
    expect(["127.0.0.1", "localhost"]).toContain(new URL(c.url).hostname);
    expect(ORG, "PRONTUARIO_ORGANIZATION_ID ausente: rode `pnpm e2e:env`").toMatch(/^[0-9a-f-]{36}$/);
    expect(SEGREDO.length).toBeGreaterThanOrEqual(32);
    fs.mkdirSync(EVIDENCIA, { recursive: true });

    const org = await db.from("organizations").upsert(
      {
        id: ORG,
        slug: "e2e-exames-prontuario",
        display_name: "E2E Exames Prontuário",
        legal_name: "E2E Exames Prontuário",
        timezone: "America/Sao_Paulo",
        locale: "pt-BR",
        status: "active",
        onboarded_at: new Date().toISOString(),
      } as never,
      { onConflict: "id" },
    );
    if (org.error) throw new Error(`organização: ${org.error.message}`);

    await pessoa("admin", "admin", "Administradora Fictícia");
    await pessoa("agent", "agent", "Recepcionista Fictícia");
    await pessoa("viewer", "viewer", "Observador Fictício");

    sessao = await inserir("channel_sessions", {
      organization_id: ORG,
      waha_session_name: `${PREFIXO}-sessao`,
      webhook_secret_encrypted: "e2e",
    });
    conv.vinculado = await conversa(ORG, sessao, "Paciente Fictícia Aurora", "vinculado");
    conv.clinico = await conversa(ORG, sessao, "Paciente Fictício Bento", "clinico");
    conv.naoVinculado = await conversa(ORG, sessao, "Paciente Fictícia Celeste", "nao_vinculado");
    conv.oscilante = await conversa(ORG, sessao, "Paciente Fictício Davi", "oscilante");
    conv.recusado = await conversa(ORG, sessao, "Paciente Fictícia Elisa", "recusado");
    conv.naoConfirmado = await conversa(ORG, sessao, "Paciente Fictício Fábio", "nao_confirmado");

    const v = conv.vinculado;
    msg.pdf = await midia(ORG, sessao, v, { type: "document", mime: "application/pdf", bytes: PDF, ext: "pdf", minutos: 50 });
    msg.jpeg = await midia(ORG, sessao, v, { type: "image", mime: "image/jpeg", bytes: JPEG, ext: "jpg", minutos: 40 });
    msg.heic = await midia(ORG, sessao, v, { type: "document", mime: "image/heic", bytes: randomBytes(256), ext: "heic", minutos: 30 });
    msg.saida = await midia(ORG, sessao, v, { type: "document", mime: "application/pdf", bytes: PDF, ext: "pdf", direction: "outbound", minutos: 20 });
    msg.falhou = await midia(ORG, sessao, v, { type: "document", mime: "application/pdf", ext: "pdf", falhou: true, minutos: 10 });
    for (const [k, c2] of Object.entries(conv)) {
      if (k === "vinculado") continue;
      msg[k] = await midia(ORG, sessao, c2, { type: "document", mime: "application/pdf", bytes: PDF, ext: "pdf" });
    }

    falso = http.createServer((req, res) => {
      prontuarioFalso(req, res).catch((e: unknown) => responder(res, 500, { error: { code: "falso", message: String(e) } }));
    });
    const u = new URL(URL_DO_FALSO);
    await new Promise<void>((resolve) => falso.listen(Number(u.port), u.hostname, resolve));
  });

  test.afterAll(async () => {
    await new Promise<void>((r) => (falso ? falso.close(() => r()) : r()));
    const caminhos = [...bytesDaMensagem.keys()].map((id) => id);
    const { data: linhas } = await db.from("messages").select("media_storage_path").in("id", caminhos);
    const objetos = ((linhas ?? []) as { media_storage_path: string | null }[]).map((l) => l.media_storage_path).filter(Boolean) as string[];
    if (objetos.length) await db.storage.from("whatsapp-media").remove(objetos);
    if (msgDoSeed.id) {
      await db.from("messages").delete().eq("id", msgDoSeed.id);
      await db.from("conversations").delete().eq("id", msgDoSeed.conversa);
    }
    await db.from("api_tokens").update({ revoked_at: new Date().toISOString() }).ilike("name", `${PREFIXO}%`);
    // A organização da spec leva tudo dela em cascata; as pessoas saem do GoTrue.
    await db.from("organizations").delete().eq("id", ORG);
    for (const p of Object.values(pessoas)) await db.auth.admin.deleteUser(p.id);
  });

  test("o admin cria pela tela a chave só de mídia do Prontuário", async ({ page }) => {
    await entrar(page, pessoas.admin!.email);
    await page.goto("/app/settings/api-tokens");
    await page.getByRole("button", { name: "Criar token" }).click();
    const novo = page.getByRole("dialog", { name: "Criar novo token" });
    await novo.getByLabel("Nome", { exact: true }).fill(`${PREFIXO} Prontuário VPS exames WhatsApp`);
    const opcao = novo.getByRole("button", { name: /^prontuario:media:read —/ });
    await expect(opcao).toHaveAttribute("title", "Prontuário: baixar PDF e fotos que o paciente mandou pelo WhatsApp");
    await opcao.click();
    await novo.screenshot({ path: path.join(EVIDENCIA, "0-criar-chave.png") });
    await novo.getByRole("button", { name: "Criar", exact: true }).click();
    const criado = page.getByRole("dialog", { name: "Token criado" });
    chaveDeLeitura = (await criado.locator("code").innerText()).trim();
    expect(chaveDeLeitura).toMatch(/^dsk_/);
    await page.keyboard.press("Escape");
  });

  test("1 e 13: a recepção vê botão e dicas no lugar certo, com as medidas", async ({ page }) => {
    await entrar(page, pessoas.agent!.email);
    await page.goto(`/app/inbox/${conv.vinculado!.conversa}`);
    await expect(bolha(page, msg.pdf!).getByTestId("enviar-ao-prontuario")).toBeVisible({ timeout: 20_000 });
    await expect(bolha(page, msg.jpeg!).getByTestId("enviar-ao-prontuario")).toBeVisible();
    await expect(bolha(page, msg.heic!).getByText("Peça ao paciente um PDF ou foto comum")).toBeVisible();
    await expect(
      bolha(page, msg.falhou!).getByText("O arquivo não chegou inteiro ao CRM. Peça ao paciente para enviar de novo."),
    ).toBeVisible();
    await expect(bolha(page, msg.saida!).getByTestId("enviar-ao-prontuario")).toHaveCount(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "1-botao-e-dicas.png"), fullPage: true });

    for (const [largura, altura, minimo] of [[1366, 768, 36], [390, 844, 44]] as const) {
      for (const tema of ["light", "dark"] as const) {
        await page.setViewportSize({ width: largura, height: altura });
        await page.emulateMedia({ colorScheme: tema });
        const botao = bolha(page, msg.pdf!).getByTestId("enviar-ao-prontuario");
        await botao.scrollIntoViewIfNeeded();
        const h = await botao.evaluate((el) => el.getBoundingClientRect().height);
        expect(h, `${largura}px ${tema}`).toBeGreaterThanOrEqual(minimo);
        const transborda = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        expect(transborda, `scroll horizontal a ${largura}px`).toBe(false);
        await page.screenshot({ path: path.join(EVIDENCIA, `13-botao-${largura}-${tema}.png`) });
      }
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.emulateMedia({ colorScheme: "light" });
  });

  test("2: clicar no PDF mostra Enviando… e depois o selo com quem e quando", async ({ page }) => {
    await entrar(page, pessoas.agent!.email);
    await page.goto(`/app/inbox/${conv.vinculado!.conversa}`);
    const b = bolha(page, msg.pdf!);
    await b.getByTestId("enviar-ao-prontuario").click();
    await expect(b.getByRole("button", { name: /Enviando…/ })).toHaveAttribute("aria-busy", "true");
    await expect(b.getByText("No prontuário")).toBeVisible({ timeout: 45_000 });
    await expect(b.getByText(/^por Recepcionista Fictícia · /)).toBeVisible();
    const fonte = await b.getByText(/^por Recepcionista Fictícia · /).evaluate((el) => getComputedStyle(el).fontSize);
    expect(fonte).toBe("12px");

    const doPdf = pedidos.filter((p) => p.message_id === msg.pdf);
    expect(doPdf).toHaveLength(1);
    expect(doPdf[0]).toMatchObject({ contact_id: conv.vinculado!.contato, enviado_por: "Recepcionista Fictícia", chave: msg.pdf });
    expect(listagens).toContain("?dias=60");
    expect(reprovacoes).toEqual([]);
    await page.screenshot({ path: path.join(EVIDENCIA, "2-selo.png"), fullPage: true });

    await page.reload();
    await expect(bolha(page, msg.pdf!).getByText("No prontuário")).toBeVisible({ timeout: 20_000 });
  });

  test("3: POST repetido pela sessão → 200 sem pedido novo ao Prontuário", async ({ page }) => {
    await entrar(page, pessoas.agent!.email);
    const antes = pedidos.length;
    const r = await page.request.post(`/api/v1/messages/${msg.pdf}/prontuario`);
    expect(r.status()).toBe(200);
    expect(JSON.stringify(await r.json())).not.toContain(EXAME_FIXO);
    expect(pedidos.length).toBe(antes);
  });

  test("4, 6 e vínculo não confirmado: a frase fica escrita no balão, além do toast", async ({ page }) => {
    await entrar(page, pessoas.agent!.email);
    const casos: Array<[keyof typeof conv, string, number]> = [
      ["naoVinculado", "Este contato ainda não está ligado a um paciente no Prontuário.", 1],
      ["recusado", "A integração com o Prontuário não está configurada. Avise o administrador.", 1],
      ["naoConfirmado", "Este contato ainda não está confirmado no Prontuário. Peça para confirmar o vínculo lá.", 1],
    ];
    for (const [k, frase, nPedidos] of casos) {
      await page.goto(`/app/inbox/${conv[k]!.conversa}`);
      const b = bolha(page, msg[k]!);
      await b.getByTestId("enviar-ao-prontuario").click();
      await expect(page.getByText(frase).first()).toBeVisible({ timeout: 45_000 });
      await expect(b.getByTestId("erro-ao-prontuario")).toHaveText(frase);
      await page.waitForTimeout(5_000);
      await expect(b.getByTestId("erro-ao-prontuario")).toBeVisible();
      await expect(b.getByText("No prontuário")).toHaveCount(0);
      expect(pedidos.filter((p) => p.message_id === msg[k])).toHaveLength(nPedidos);
      await page.screenshot({ path: path.join(EVIDENCIA, `4-erro-${k}.png`), fullPage: true });
    }
  });

  test("5: o Prontuário oscila e a segunda tentativa leva a mesma chave", async ({ page }) => {
    await entrar(page, pessoas.agent!.email);
    await page.goto(`/app/inbox/${conv.oscilante!.conversa}`);
    const b = bolha(page, msg.oscilante!);
    await b.getByTestId("enviar-ao-prontuario").click();
    await expect(b.getByText("No prontuário")).toBeVisible({ timeout: 45_000 });
    const doOscilante = pedidos.filter((p) => p.message_id === msg.oscilante);
    expect(doOscilante).toHaveLength(2);
    expect(doOscilante.map((p) => p.chave)).toEqual([msg.oscilante, msg.oscilante]);
  });

  test("7: exame que o clínico já trouxe mostra 'já estava lá'", async ({ page }) => {
    await entrar(page, pessoas.agent!.email);
    await page.goto(`/app/inbox/${conv.clinico!.conversa}`);
    const b = bolha(page, msg.clinico!);
    await b.getByTestId("enviar-ao-prontuario").click();
    await expect(b.getByText(/^já estava lá · conferido por Recepcionista Fictícia · /)).toBeVisible({ timeout: 45_000 });
    await expect(b.getByText(/^por Recepcionista Fictícia · /)).toHaveCount(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "7-ja-estava.png"), fullPage: true });
  });

  test("8: o colega vê o selo em menos de 10 s, sem recarregar", async ({ browser }: { browser: Browser }) => {
    const ctxAdmin = await browser.newContext();
    const ctxAgent = await browser.newContext();
    try {
      const admin = await ctxAdmin.newPage();
      const agent = await ctxAgent.newPage();
      await entrar(admin, pessoas.admin!.email);
      await entrar(agent, pessoas.agent!.email);
      await admin.goto(`/app/inbox/${conv.vinculado!.conversa}`);
      await agent.goto(`/app/inbox/${conv.vinculado!.conversa}`);
      await expect(bolha(admin, msg.jpeg!).getByTestId("enviar-ao-prontuario")).toBeVisible({ timeout: 20_000 });
      await bolha(agent, msg.jpeg!).getByTestId("enviar-ao-prontuario").click();
      await expect(bolha(agent, msg.jpeg!).getByText("No prontuário")).toBeVisible({ timeout: 45_000 });
      await expect(bolha(admin, msg.jpeg!).getByText("No prontuário")).toBeVisible({ timeout: 10_000 });
      await admin.screenshot({ path: path.join(EVIDENCIA, "8-selo-do-colega.png"), fullPage: true });
    } finally {
      await ctxAdmin.close();
      await ctxAgent.close();
    }
  });

  test("9: quem só lê vê o selo e nenhum botão", async ({ page }) => {
    await entrar(page, pessoas.viewer!.email);
    await page.goto(`/app/inbox/${conv.vinculado!.conversa}`);
    await expect(bolha(page, msg.pdf!).getByText("No prontuário")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("enviar-ao-prontuario")).toHaveCount(0);
  });

  test("10: auditoria com o id da mensagem e a lista sem exam_id", async ({ page }) => {
    await entrar(page, pessoas.admin!.email);
    await page.goto("/app/audit");
    await page.getByPlaceholder("ex: lead.created").fill("prontuario.exam_s");
    await expect(page.getByText("prontuario.exam_sent").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("prontuario.exam_send_failed").first()).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCIA, "10-auditoria.png"), fullPage: true });
    const lista = await page.request.get(`/api/v1/conversations/${conv.vinculado!.conversa}/messages`);
    const texto = await lista.text();
    expect(texto).toContain("prontuario_exame");
    expect(texto).not.toContain(EXAME_FIXO);
    expect(texto).not.toContain("exam_id");
  });

  test("11: a chave de outra organização não lê nada desta", async ({ request }) => {
    const creds = lerCreds() as unknown as { org_id: string; users: Record<string, { id: string }> };
    const prefix = `dsk_e2eex_${randomBytes(3).toString("hex")}`;
    const outra = `${prefix}_${randomBytes(32).toString("base64url")}`;
    const ins = await db.from("api_tokens").insert({
      organization_id: creds.org_id,
      created_by: creds.users.admin!.id,
      name: `${PREFIXO} isolamento`,
      prefix,
      token_hash: `\\x${createHash("sha256").update(outra).digest("hex")}`,
      scopes: ["prontuario:media:read"],
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(ins.error).toBeNull();
    const h = { headers: { authorization: `Bearer ${outra}` } };
    const l = await request.get(`/api/v1/prontuario/contacts/${conv.vinculado!.contato}/midias`, h);
    expect(l.status()).toBe(200);
    expect((await l.json()).data).toEqual([]);
    const a = await request.get(`/api/v1/prontuario/midias/${msg.pdf}`, h);
    const b = await request.get(`/api/v1/prontuario/midias/${randomUUID()}`, h);
    expect(a.status()).toBe(404);
    expect(b.status()).toBe(404);
    expect((await a.json()).error).toEqual((await b.json()).error);
  });

  test("12: na organização sem a integração, o PDF não tem botão nem dica", async ({ page }) => {
    const creds = lerCreds() as unknown as { org_id: string; password: string; users: Record<string, { email: string }> };
    const { data: s } = await db.from("channel_sessions").select("id").eq("organization_id", creds.org_id).limit(1).maybeSingle();
    const sessaoDoSeed =
      (s as { id: string } | null)?.id ??
      (await inserir("channel_sessions", { organization_id: creds.org_id, waha_session_name: `${PREFIXO}-seed`, webhook_secret_encrypted: "e2e" }));
    const c2 = await conversa(creds.org_id, sessaoDoSeed, "Paciente Fictício Gil", null);
    msgDoSeed.conversa = c2.conversa;
    msgDoSeed.id = await midia(creds.org_id, sessaoDoSeed, c2, { type: "document", mime: "application/pdf", bytes: PDF, ext: "pdf" });

    await page.context().clearCookies();
    await page.goto("/login");
    await page.locator("#email").fill(creds.users.agent!.email);
    await page.locator("#password").fill(creds.password);
    await page.getByRole("button", { name: /entrar/i }).click();
    await page.waitForURL(/\/app(\/|$)/);
    await page.goto(`/app/inbox/${c2.conversa}`);
    await expect(bolha(page, msgDoSeed.id)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("enviar-ao-prontuario")).toHaveCount(0);
    await expect(page.getByText("Peça ao paciente um PDF ou foto comum")).toHaveCount(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "12-sem-integracao.png"), fullPage: true });
  });
});
