/**
 * ETIQUETAS E COMPOSITOR — o lote de portes de 15/10, provado pela tela.
 *
 * Porta de melgarafael/DeskcommCRM #2901, #2784, #2810 e #2844 para o fork. Os
 * testes de unidade e o invariante provam a regra; aqui se prova o que quem
 * atende VÊ e clica:
 *
 *  1. resposta com `{{primeiro_nome}}` para contato sem nome de gente: a faixa
 *     aparece, o botão Enviar trava e o campo continua editável; apagar o
 *     curinga destrava (#2844);
 *  2. a paleta abre ao lado da etiqueta que JÁ está no contato e grava a cor
 *     (#2784); depois, excluir OUTRA etiqueta em Configurações › Etiquetas tira
 *     só ela: a primeira continua no contato, na conversa e com a cor (#2901);
 *  3. no celular (390 px) a barra de ações da conversa é uma fileira só, que
 *     rola, e não várias fileiras empilhadas (#2810);
 *  4. arrastar um arquivo para a caixa abre a MESMA prévia do "+", dizendo para
 *     quem vai; na nota interna ele vira anexo da nota e nenhuma mensagem; solto
 *     fora da caixa (fio, fundo da prévia) é recusado; a conversa encerrada não
 *     aceita (#3713, adicionado em 03/11). É o ÚLTIMO teste porque encerra a
 *     conversa. Eventos sintéticos: o gesto real do Finder para o Safari fica
 *     para a conferência manual.
 *
 * Gestor (`manager`) e não `admin`: o admin do seed tem fator TOTP e a rota do
 * vocabulário exige MFA provado de quem tem fator. O gestor não tem fator, e é
 * o papel mínimo que a rota aceita.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   pnpm exec playwright test tests/e2e/etiquetas-e-composer-pela-tela.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type JSHandle, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { abrirAcoesDaConversa } from "./helpers/acoes-da-conversa";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/etiquetas-e-composer");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Prefixo do telefone: a limpeza apaga por ele (o worker reavalia o módulo após um vermelho). */
const PREFIXO_FONE = "+5511777151";
const FICA = "fica-1510";
const SAI = "sai-1510";

let creds: Creds;
let conversaId = "";
let contatoId = "";

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: false });
}

async function limpar(): Promise<void> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("phone_number", `${PREFIXO_FONE}%`);
  const ids = ((data as Array<{ id: string }> | null) ?? []).map((c) => c.id);
  if (ids.length > 0) {
    // O anexo da nota (teste 4) mora no bucket `internal-media`, que não cai em
    // cascata com a conversa: sai antes dela, também depois de um vermelho.
    const { data: conversas } = await admin.from("conversations").select("id").in("contact_id", ids);
    for (const { id } of (conversas as Array<{ id: string }> | null) ?? []) {
      const pasta = `${creds.org_id}/${id}`;
      const { data: objetos } = await admin.storage.from("internal-media").list(pasta);
      const caminhos = (objetos ?? []).map((o) => `${pasta}/${o.name}`);
      if (caminhos.length > 0) await admin.storage.from("internal-media").remove(caminhos);
    }
    await admin.from("messages").delete().in("contact_id", ids);
    await admin.from("conversations").delete().in("contact_id", ids);
    await admin.from("contacts").delete().in("id", ids);
  }
  // O vocabulário da organização: só as duas etiquetas desta spec saem.
  const { data: org } = await admin.from("organizations").select("settings").eq("id", creds.org_id).single();
  const settings = ((org as { settings: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
  const tags = Array.isArray(settings.tags) ? (settings.tags as Array<{ tag?: string } | string>) : [];
  const nomeDe = (e: { tag?: string } | string) => (typeof e === "string" ? e : (e.tag ?? ""));
  const restantes = tags.filter((e) => ![FICA, SAI].includes(nomeDe(e).toLowerCase()));
  if (restantes.length !== tags.length) {
    await admin
      .from("organizations")
      .update({ settings: { ...settings, tags: restantes } })
      .eq("id", creds.org_id);
  }
}

async function tagsDe(tabela: "contacts" | "conversations", id: string): Promise<string[]> {
  const { data } = await admin.from(tabela).select("tags").eq("id", id).single();
  return ((data as { tags: string[] | null } | null)?.tags ?? []) as string[];
}

async function vocabulario(): Promise<Array<{ tag: string; cor?: string }>> {
  const { data } = await admin.from("organizations").select("settings").eq("id", creds.org_id).single();
  const tags = ((data as { settings: { tags?: unknown } }).settings?.tags ?? []) as Array<
    { tag: string; cor?: string } | string
  >;
  return tags.map((e) => (typeof e === "string" ? { tag: e } : e));
}

async function mensagensDaConversa(): Promise<number> {
  const { count, error } = await admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversaId);
  if (error) throw new Error(`messages: ${error.message}`);
  return count ?? 0;
}

async function anexosDeNota(): Promise<number> {
  const { data, error } = await admin
    .from("conversation_notes")
    .select("id")
    .eq("conversation_id", conversaId)
    .like("media_storage_path", `${creds.org_id}/${conversaId}/%`);
  if (error) throw new Error(`conversation_notes: ${error.message}`);
  return (data ?? []).length;
}

/** Um arraste com UM arquivo, montado na página; o Playwright o entrega vivo ao evento. */
function arrasteCom(page: Page, nome: string, tipo: string): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(
    ([n, t]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([`conteudo ficticio de ${n}`], n, { type: t }));
      return dt;
    },
    [nome, tipo] as const,
  );
}

/**
 * Um dragover de ARQUIVO no elemento, medido pelo próprio evento (roda NA
 * página). O `dropEffect` parte de "copy": voltar "none" prova que alguém o
 * escreveu — a guarda da janela ou a caixa travada.
 */
const dragoverDeArquivo = (el: Element | null): { prevented: boolean; dropEffect: string } => {
  if (!el) throw new Error("nenhum elemento no alvo do arraste");
  const dt = new DataTransfer();
  dt.items.add(new File(["x"], "perdido-ficticio.pdf", { type: "application/pdf" }));
  dt.dropEffect = "copy";
  const ev = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
  el.dispatchEvent(ev);
  return { prevented: ev.defaultPrevented, dropEffect: dt.dropEffect };
};

test.describe("Etiquetas e compositor (portes de 15/10)", () => {
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limpar();

    const { data: sessaoExistente } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", creds.org_id)
      .limit(1)
      .maybeSingle();
    let sessaoId = (sessaoExistente as { id: string } | null)?.id ?? null;
    if (!sessaoId) {
      const { data, error } = await admin
        .from("channel_sessions")
        .insert({
          organization_id: creds.org_id,
          waha_session_name: `e2e-portes-1510-${Date.now()}`,
          webhook_secret_encrypted: "e2e",
        })
        .select("id")
        .single();
      if (error) throw new Error(`channel_sessions: ${error.message}`);
      sessaoId = (data as { id: string }).id;
    }

    // Contato SEM nome de gente: só o telefone. É o caso em que `{{primeiro_nome}}`
    // ficaria literal.
    const fone = `${PREFIXO_FONE}${String(Date.now()).slice(-4)}`;
    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .insert({ organization_id: creds.org_id, phone_number: fone, tags: [FICA, SAI] })
      .select("id")
      .single();
    if (erroContato) throw new Error(`contacts: ${erroContato.message}`);
    contatoId = (contato as { id: string }).id;

    const { data: conversa, error: erroConversa } = await admin
      .from("conversations")
      .insert({
        organization_id: creds.org_id,
        contact_id: contatoId,
        channel_session_id: sessaoId,
        status: "open",
        tags: [FICA, SAI],
        last_message_at: new Date().toISOString(),
        last_inbound_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (erroConversa) throw new Error(`conversations: ${erroConversa.message}`);
    conversaId = (conversa as { id: string }).id;

    const { error: erroMsg } = await admin.from("messages").insert({
      organization_id: creds.org_id,
      conversation_id: conversaId,
      channel_session_id: sessaoId,
      contact_id: contatoId,
      type: "text",
      direction: "inbound",
      status: "delivered",
      sent_via: "external_device",
      body: "MENSAGEM DO PACIENTE 1510",
      sent_at: new Date().toISOString(),
    });
    if (erroMsg) throw new Error(`messages: ${erroMsg.message}`);
  });

  test.afterAll(async () => {
    await limpar();
  });

  test("curinga de nome literal: a resposta trava com aviso e destrava ao apagar", async ({ page }) => {
    await login(page, creds.users.manager!.email);
    await page.goto(`/app/inbox/${conversaId}`);
    await expect(page.getByText("MENSAGEM DO PACIENTE 1510").first()).toBeVisible({ timeout: 60_000 });

    const campo = page.getByLabel("Mensagem", { exact: true });
    await campo.fill("Oi {{primeiro_nome}}, tudo bem?");
    const aviso = page.getByTestId("aviso-curinga-literal");
    await expect(aviso).toBeVisible();
    await expect(page.getByRole("button", { name: "Enviar", exact: true })).toBeDisabled();
    await expect(campo, "o campo precisa continuar editável").toBeEnabled();
    await captura(page, "curinga-literal-barrado");

    await campo.fill("Oi, tudo bem?");
    await expect(aviso).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Enviar", exact: true })).toBeEnabled();
  });

  test("paleta ao lado da etiqueta, e excluir uma etiqueta não apaga a outra", async ({ page }) => {
    await login(page, creds.users.manager!.email);
    await page.goto(`/app/inbox/${conversaId}`);
    await expect(page.getByText("MENSAGEM DO PACIENTE 1510").first()).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: /Tags do contato/ }).click();
    const gatilho = page.getByRole("button", { name: `Cor da etiqueta ${FICA}` }).first();
    await expect(gatilho, "a paleta não apareceu ao lado da etiqueta do contato").toBeVisible();
    await gatilho.click();
    await page.getByRole("button", { name: "Roxo", exact: true }).click();
    await expect
      .poll(async () => (await vocabulario()).find((e) => e.tag.toLowerCase() === FICA)?.cor ?? null, {
        timeout: 15_000,
      })
      .toBe("#ab4aba");
    await captura(page, "paleta-ao-lado-da-etiqueta");

    await page.goto("/app/settings/tags");
    const linhaSai = page.locator("tr", { has: page.getByText(SAI, { exact: true }) });
    await expect(linhaSai).toBeVisible({ timeout: 30_000 });
    await linhaSai.getByRole("button", { name: "Excluir", exact: true }).click();
    await page.getByRole("button", { name: "Confirmar", exact: true }).click();
    await expect(linhaSai).toHaveCount(0, { timeout: 15_000 });

    expect(await tagsDe("contacts", contatoId)).toEqual([FICA]);
    expect(await tagsDe("conversations", conversaId)).toEqual([FICA]);
    const fica = (await vocabulario()).find((e) => e.tag.toLowerCase() === FICA);
    expect(fica?.cor, "a cor da etiqueta que ficou sumiu junto").toBe("#ab4aba");
    await expect(page.locator("tr", { has: page.getByText(FICA, { exact: true }) })).toBeVisible();
    await captura(page, "excluir-uma-etiqueta-preserva-a-outra");
  });

  test("no celular a barra de ações é uma fileira que rola", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, creds.users.manager!.email);
    await page.goto(`/app/inbox/${conversaId}`);
    await expect(page.getByText("MENSAGEM DO PACIENTE 1510").first()).toBeVisible({ timeout: 60_000 });

    await abrirAcoesDaConversa(page);
    const transferir = page.getByRole("button", { name: /Transferir/ }).first();
    await expect(transferir).toBeAttached();
    const medida = await transferir.evaluate((botao) => {
      const barra = botao.parentElement as HTMLElement;
      const estilo = getComputedStyle(barra);
      const tops = new Set(
        [...barra.children].map((filho) => Math.round((filho as HTMLElement).getBoundingClientRect().top)),
      );
      return {
        flexWrap: estilo.flexWrap,
        overflowX: estilo.overflowX,
        fileiras: tops.size,
        cabeNaTela: barra.getBoundingClientRect().right <= window.innerWidth + 1,
      };
    });
    expect(medida.flexWrap).toBe("nowrap");
    expect(medida.overflowX).toBe("auto");
    expect(medida.fileiras, "a barra voltou a empilhar fileiras").toBe(1);
    expect(medida.cabeNaTela, "a barra vazou da largura da tela").toBe(true);
    await captura(page, "barra-de-acoes-no-celular");
  });

  // ÚLTIMO de propósito: termina encerrando a conversa.
  test("arrastar arquivo para a caixa abre a prévia do +; fora da caixa e com a conversa encerrada, nada", async ({
    page,
  }) => {
    await login(page, creds.users.manager!.email);
    await page.goto(`/app/inbox/${conversaId}`);
    const doPaciente = page.getByText("MENSAGEM DO PACIENTE 1510").first();
    await expect(doPaciente).toBeVisible({ timeout: 60_000 });

    const caixa = page.getByTestId("composer");
    const realce = page.getByTestId("arraste-de-arquivo");
    const previa = page.getByRole("dialog");
    const mensagensAntes = await mensagensDaConversa();

    // Por cima da caixa, o realce acende do tamanho dela.
    const pdf = await arrasteCom(page, "exame-ficticio.pdf", "application/pdf");
    await caixa.dispatchEvent("dragenter", { dataTransfer: pdf });
    await caixa.dispatchEvent("dragover", { dataTransfer: pdf });
    await expect(realce).toBeVisible();
    const [r, c] = await Promise.all([realce.boundingBox(), caixa.boundingBox()]);
    for (const k of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(r![k] - c![k]), `o realce não cobre a caixa (${k})`).toBeLessThanOrEqual(1);
    }
    await captura(page, "arrastar-arquivo-realce");

    // Por cima do fio da conversa: recusado, e a aba não vira o arquivo.
    expect(await doPaciente.evaluate(dragoverDeArquivo)).toEqual({ prevented: true, dropEffect: "none" });

    // Soltar na caixa abre a MESMA prévia do "+", dizendo para quem vai.
    await caixa.dispatchEvent("drop", { dataTransfer: pdf });
    await expect(previa.getByText("Enviar anexo")).toBeVisible();
    await expect(previa.getByText("exame-ficticio.pdf")).toBeVisible();
    await expect(previa).toHaveAccessibleDescription(/^Para: /);
    expect((await previa.boundingBox())?.height ?? 0, "prévia de altura zero").toBeGreaterThan(100);
    await expect(realce).toHaveCount(0);
    await captura(page, "arrastar-arquivo-previa");

    // Com a prévia aberta, o fundo escuro dela também recusa.
    const fundo = await page.evaluateHandle(() => document.elementFromPoint(5, 5));
    expect(await fundo.evaluate(dragoverDeArquivo)).toEqual({ prevented: true, dropEffect: "none" });

    await previa.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(previa).toHaveCount(0);
    expect(await mensagensDaConversa(), "cancelar criou mensagem").toBe(mensagensAntes);

    // Em Nota interna, o arquivo vira anexo da nota e nada vai ao paciente.
    await page.getByRole("button", { name: "Opções de resposta" }).click();
    await page.getByRole("button", { name: "Nota interna", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Mensagem", exact: true })).toHaveAttribute(
      "placeholder",
      /nota/i,
    );
    const txt = await arrasteCom(page, "anotacao-ficticia.txt", "text/plain");
    await caixa.dispatchEvent("dragenter", { dataTransfer: txt });
    await caixa.dispatchEvent("dragover", { dataTransfer: txt });
    await caixa.dispatchEvent("drop", { dataTransfer: txt });
    // Só dentro da prévia: depois do envio, o card da nota repete a frase no fio.
    await expect(previa.getByText("Nota interna · só o time vê")).toBeVisible();
    await previa.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect(previa).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(anexosDeNota, { timeout: 15_000 }).toBe(1);
    expect(await mensagensDaConversa(), "a nota virou mensagem").toBe(mensagensAntes);

    // O realce no tema escuro (evidência).
    await page.evaluate(() => localStorage.setItem("deskcomm-theme", "dark"));
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await expect(doPaciente).toBeVisible({ timeout: 60_000 });
    const noEscuro = await arrasteCom(page, "exame-ficticio.pdf", "application/pdf");
    await caixa.dispatchEvent("dragenter", { dataTransfer: noEscuro });
    await caixa.dispatchEvent("dragover", { dataTransfer: noEscuro });
    await expect(realce).toBeVisible();
    await captura(page, "arrastar-arquivo-realce-escuro");

    // Conversa encerrada: a caixa recusa (cursor "proibido"), sem realce nem prévia.
    const fechada = await page.request.patch(`/api/v1/conversations/${conversaId}`, {
      data: { status: "closed" },
    });
    expect(fechada.ok(), await fechada.text()).toBe(true);
    await page.reload();
    await expect(doPaciente).toBeVisible({ timeout: 60_000 });
    expect(await caixa.evaluate(dragoverDeArquivo)).toEqual({ prevented: true, dropEffect: "none" });
    const recusado = await arrasteCom(page, "exame-ficticio.pdf", "application/pdf");
    await caixa.dispatchEvent("dragenter", { dataTransfer: recusado });
    await caixa.dispatchEvent("dragover", { dataTransfer: recusado });
    await caixa.dispatchEvent("drop", { dataTransfer: recusado });
    await expect(realce).toHaveCount(0);
    await expect(previa).toHaveCount(0);
  });
});
