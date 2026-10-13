import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

/**
 * PACIENTES PELO CADASTRO: a jornada de quem liga a regra (migration 0360).
 *
 * O que a tela precisa provar, e nenhum invariante prova:
 *
 *   1. a regra se alcança pela porta (Configurações › Tipos de agendamento), e
 *      ligar mostra QUANTOS contatos têm cadastro ANTES de confirmar, com o
 *      aviso de que não há funil de clientes marcado;
 *   2. ligada, quem tem cadastro (CPF ou vínculo com o prontuário) aparece com
 *      o selo "Cliente" na lista, sem ganhar a etiqueta, e a ficha diz de onde
 *      o selo vem;
 *   3. a tela de Funis deixa marcar o funil de clientes só com esta regra;
 *   4. a mensagem que chega pelo CAMINHO DE PRODUÇÃO (o webhook do WhatsApp)
 *      abre o card do paciente no funil de clientes e o de quem é novo no
 *      funil de entrada;
 *   5. desligar volta ao que era para quem escrever depois, e o card que já
 *      nasceu fica onde está.
 *
 * ⚠️ ORGANIZAÇÃO PRÓPRIA, criada aqui e apagada no fim, como
 * `cliente-pela-agenda.spec.ts`: a regra é da organização, e ligá-la na
 * compartilhada do CI mudaria o funil dos contatos das outras specs.
 */
const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const senha = `Local-${randomUUID()}!`;

test.describe.configure({ timeout: 240_000 });

const orgs: string[] = [];
const usuarios: string[] = [];

/** Sufixo de telefone único por execução (o índice de telefone é por organização, mas o webhook não). */
const sufixo = String(Date.now()).slice(-6);
const telefone = (n: number) => `55279${sufixo}0${n}`;

async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return (data as { id: string }).id;
}

async function contato(org: string, nome: string, n: number, cadastro: { cpf?: boolean; vinculo?: boolean }) {
  const id = await inserir("contacts", {
    organization_id: org,
    name: nome,
    display_name: nome,
    phone_number: `+${telefone(n)}`,
    source: "import_csv",
    // O par do CPF (`contacts_cpf_consistency`). O valor não é um CPF: a regra
    // lê a PRESENÇA, e a spec não tem a chave de cifra da instalação.
    ...(cadastro.cpf ? { cpf_hash: `e2e-${randomUUID()}`, cpf_encrypted: "\\x00" } : {}),
  });
  if (cadastro.vinculo) {
    await inserir("prontuario_contact_links", {
      organization_id: org,
      source_patient_id: randomUUID(),
      contact_id: id,
    });
  }
  return id;
}

async function organizacaoDeTeste() {
  const email = `paciente-cadastro-${randomUUID()}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("usuário não criado");
  usuarios.push(data.user.id);
  const org = await inserir("organizations", {
    slug: `paciente-cadastro-${randomUUID()}`,
    display_name: "Clínica Paciente pelo Cadastro",
    legal_name: "Clínica Paciente pelo Cadastro",
    onboarded_at: new Date().toISOString(),
  });
  orgs.push(org);
  await inserir("user_organizations", {
    organization_id: org,
    user_id: data.user.id,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });

  const webhookToken = `e2e-paciente-${randomUUID()}`;
  const sessao = `e2e-paciente-${sufixo}`;
  await inserir("channel_sessions", {
    organization_id: org,
    waha_session_name: sessao,
    display_name: "Número da clínica E2E",
    webhook_secret_encrypted: "\\x00",
    webhook_path_token: webhookToken,
  });

  const { data: padrao, error: erroPadrao } = await db
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", org)
    .eq("is_default", true)
    .single();
  if (erroPadrao) throw erroPadrao;
  const funilDePacientes = await inserir("crm_pipelines", {
    organization_id: org,
    name: "Pacientes da clínica",
    slug: "pacientes-da-clinica",
    position: 9000,
  });
  await inserir("crm_stages", {
    organization_id: org,
    pipeline_id: funilDePacientes,
    name: "Voltou a falar",
    slug: "voltou-a-falar",
    position: 1000,
  });

  return {
    org,
    email,
    webhookToken,
    sessao,
    funilPadrao: (padrao as { id: string }).id,
    funilDePacientes,
    paula: await contato(org, "Paula Com CPF", 1, { cpf: true }),
    lia: await contato(org, "Lia Do Prontuario", 2, { vinculo: true }),
    nina: await contato(org, "Nina Sem Cadastro", 3, {}),
    otto: await contato(org, "Otto Depois De Desligar", 4, { cpf: true }),
  };
}

type Fixture = Awaited<ReturnType<typeof organizacaoDeTeste>>;

async function entrar(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}

async function evidencia(page: Page, info: TestInfo, nome: string) {
  await page.screenshot({ path: info.outputPath(`${nome}.png`), fullPage: true });
}

/** Um inbound de texto, como o WAHA o entrega (o caminho de `conversa-vira-lead.spec.ts`). */
async function mandarMensagem(page: Page, f: Fixture, n: number, nome: string) {
  const r = await page.request.post(`/api/v1/webhooks/waha/${f.webhookToken}`, {
    data: {
      event: "message",
      session: f.sessao,
      payload: {
        id: `e2e-paciente-${sufixo}-${n}-${randomUUID()}`,
        from: `${telefone(n)}@c.us`,
        fromMe: false,
        body: "Oi, queria marcar um retorno.",
        timestamp: Math.floor(Date.now() / 1000),
        _data: { notifyName: nome },
      },
    },
  });
  expect(r.status(), `o webhook precisa ACEITAR: ${await r.text()}`).toBe(200);
}

/** Em que funil está o card aberto do contato. Espera o card nascer. */
async function funilDoCard(org: string, contactId: string): Promise<string> {
  let funil = "";
  await expect
    .poll(
      async () => {
        const { data } = await db
          .from("crm_leads")
          .select("pipeline_id")
          .eq("organization_id", org)
          .eq("contact_id", contactId)
          .eq("status", "open");
        funil = ((data ?? []) as Array<{ pipeline_id: string }>)[0]?.pipeline_id ?? "";
        return (data ?? []).length;
      },
      { timeout: 30_000, message: "o card do contato não nasceu" },
    )
    .toBe(1);
  return funil;
}

/**
 * O elemento VISÍVEL com este `data-testid`. A tela de Funis tem `loading.tsx`:
 * o conteúdo chega por streaming dentro de um `<div hidden>` antes de substituir
 * o esqueleto, e por um instante o mesmo `data-testid` existe duas vezes.
 */
const visivel = (page: Page, testid: string) => page.locator(`[data-testid="${testid}"]:visible`);

const linha = (page: Page, nome: string) => page.getByRole("row").filter({ hasText: nome });

test.afterAll(async () => {
  test.setTimeout(120_000);
  for (const org of orgs) {
    const r = await db.from("organizations").delete().eq("id", org);
    if (r.error) throw r.error;
  }
  for (const usuario of usuarios) {
    const r = await db.auth.admin.deleteUser(usuario);
    if (r.error) throw r.error;
  }
});

test("ligar 'Pacientes pelo cadastro' manda quem tem cadastro para o funil de clientes, e só depois de ligar", async ({
  page,
}, info) => {
  const f = await organizacaoDeTeste();
  await entrar(page, f.email);

  // ── 1 · desligada: ninguém aparece como cliente ─────────────────────────
  await page.goto("/app/contacts");
  await expect(linha(page, "Paula Com CPF")).toBeVisible({ timeout: 30_000 });
  for (const nome of ["Paula Com CPF", "Lia Do Prontuario", "Nina Sem Cadastro"]) {
    await expect(linha(page, nome).getByText("Cliente", { exact: true })).toHaveCount(0);
  }

  // ── 2 · a porta, e o número ANTES de confirmar ──────────────────────────
  await page.goto("/app/settings");
  await page.getByRole("link", { name: /Tipos de agendamento/ }).first().click();
  await expect(page).toHaveURL(/\/app\/settings\/tenant\/agenda/, { timeout: 30_000 });
  const secao = page.getByTestId("paciente-pelo-cadastro");
  await expect(secao).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("paciente-pelo-cadastro-estado")).toContainText("Desligado:");
  await expect(secao).toContainText("Esta opção não põe a etiqueta “cliente” em ninguém");
  await secao.scrollIntoViewIfNeeded();
  await evidencia(page, info, "1-regra-desligada");

  const interruptor = page.getByTestId("paciente-pelo-cadastro-interruptor");
  await interruptor.click();
  const dialogo = page.getByRole("alertdialog");
  await expect(dialogo).toContainText("Ligar pacientes pelo cadastro?", { timeout: 30_000 });
  // Paula, Lia e Otto. Nina não tem cadastro.
  await expect(dialogo).toContainText("3 contatos têm cadastro de paciente");
  await expect(dialogo).toContainText("Nenhum contato é alterado");
  await expect(dialogo).toContainText("Nenhum funil está marcado como funil de clientes.");
  // Medido: o diálogo tem altura de verdade e o botão está dentro da janela.
  const caixa = await dialogo.boundingBox();
  expect(caixa?.height ?? 0, "diálogo de altura zero").toBeGreaterThan(120);
  await expect(page.getByTestId("paciente-pelo-cadastro-confirmar")).toBeInViewport();
  await evidencia(page, info, "2-previa-antes-de-confirmar");

  // A prévia NÃO gravou: a chave ainda não existe.
  const antes = await db.from("organizations").select("settings").eq("id", f.org).single();
  expect((antes.data as { settings: { crm?: unknown } }).settings.crm ?? null).toBeNull();

  await page.getByTestId("paciente-pelo-cadastro-confirmar").click();
  await expect(page.getByTestId("paciente-pelo-cadastro-estado")).toContainText("Ligado:", { timeout: 30_000 });
  await expect(interruptor).toHaveAttribute("aria-checked", "true");
  await expect(interruptor).toBeEnabled();
  await expect(page.getByTestId("paciente-pelo-cadastro-sem-funil")).toBeVisible();
  await evidencia(page, info, "3-regra-ligada-sem-funil");

  // O banco: só a chave, nenhuma etiqueta, e a linha de auditoria.
  const depois = await db.from("organizations").select("settings").eq("id", f.org).single();
  expect((depois.data as { settings: { crm: unknown } }).settings.crm).toEqual({ paciente_pelo_cadastro: true });
  const { data: etiquetas } = await db
    .from("contacts")
    .select("tags, first_service_at")
    .eq("organization_id", f.org);
  for (const c of (etiquetas ?? []) as Array<{ tags: string[]; first_service_at: string | null }>) {
    expect(c.tags).toEqual([]);
    expect(c.first_service_at).toBeNull();
  }
  await expect
    .poll(
      async () => {
        const { data } = await db
          .from("api_audit_log")
          .select("metadata")
          .eq("organization_id", f.org)
          .eq("action", "crm.paciente_pelo_cadastro_alterado");
        return ((data ?? []) as Array<{ metadata: Record<string, unknown> }>).map((l) => l.metadata);
      },
      { timeout: 20_000 },
    )
    .toEqual([expect.objectContaining({ ligado: true, mudou: true, pacientes: 3 })]);

  // ── 3 · ligada: o selo na lista e a origem na ficha ─────────────────────
  await page.goto("/app/contacts");
  await expect(linha(page, "Paula Com CPF").getByText("Cliente", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(linha(page, "Lia Do Prontuario").getByText("Cliente", { exact: true })).toBeVisible();
  await expect(linha(page, "Nina Sem Cadastro")).toBeVisible();
  await expect(linha(page, "Nina Sem Cadastro").getByText("Cliente", { exact: true })).toHaveCount(0);
  await evidencia(page, info, "4-contatos-com-selo");

  await page.goto(`/app/contacts/${f.lia}`);
  await expect(page.getByTestId("cliente-pelo-cadastro")).toContainText("Pelo cadastro de paciente", {
    timeout: 30_000,
  });
  await expect(page.getByText("Cliente desde")).toHaveCount(0);
  await evidencia(page, info, "5-ficha-pelo-cadastro");

  // ── 4 · Funis: marcar o funil de clientes só com esta regra ─────────────
  await page.goto("/app/kanban");
  const gatilho = visivel(page, `acoes-${f.funilDePacientes}`);
  await expect(gatilho).toBeVisible({ timeout: 60_000 });
  await expect(visivel(page, "funis-rodape-clientes")).toContainText(
    "Quem já tem cadastro de paciente entra pelo funil de clientes.",
  );
  await gatilho.click();
  const marcou = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/pipelines/${f.funilDePacientes}`) && r.request().method() === "PATCH",
  );
  await page.getByTestId(`clientes-${f.funilDePacientes}`).click();
  expect((await marcou).ok(), "marcar o funil de clientes foi recusado").toBe(true);
  await page.reload();
  await expect(
    visivel(page, `abrir-${f.funilDePacientes}`).getByText("Clientes", { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await evidencia(page, info, "6-funil-de-clientes-marcado");

  // ── 5 · a mensagem chega: cada um no seu funil ──────────────────────────
  await mandarMensagem(page, f, 1, "Paula");
  await mandarMensagem(page, f, 2, "Lia");
  await mandarMensagem(page, f, 3, "Nina");
  expect(await funilDoCard(f.org, f.paula), "paciente com CPF").toBe(f.funilDePacientes);
  expect(await funilDoCard(f.org, f.lia), "paciente do prontuário").toBe(f.funilDePacientes);
  expect(await funilDoCard(f.org, f.nina), "quem não tem cadastro").toBe(f.funilPadrao);

  await page.goto(`/app/pipelines/${f.funilDePacientes}`);
  await expect(page.getByText("Paula Com CPF").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Lia Do Prontuario").first()).toBeVisible();
  await expect(page.getByText("Nina Sem Cadastro")).toHaveCount(0);
  await evidencia(page, info, "7-quadro-de-pacientes");

  await page.goto(`/app/pipelines/${f.funilPadrao}`);
  await expect(page.getByText("Nina Sem Cadastro").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Paula Com CPF")).toHaveCount(0);
  await evidencia(page, info, "8-quadro-de-entrada");

  // ── 6 · desligar: sem confirmação, e vale para quem escrever depois ─────
  await page.goto("/app/settings/tenant/agenda");
  await expect(page.getByTestId("paciente-pelo-cadastro-estado")).toContainText("Ligado:", { timeout: 30_000 });
  await page.getByTestId("paciente-pelo-cadastro-interruptor").click();
  await expect(page.getByTestId("paciente-pelo-cadastro-estado")).toContainText("Desligado:", {
    timeout: 30_000,
  });
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await evidencia(page, info, "9-regra-desligada-de-novo");

  await mandarMensagem(page, f, 4, "Otto");
  expect(await funilDoCard(f.org, f.otto), "paciente que escreveu depois de desligar").toBe(f.funilPadrao);
  // O card que já tinha nascido não se move.
  expect(await funilDoCard(f.org, f.paula)).toBe(f.funilDePacientes);

  await page.goto("/app/contacts");
  await expect(linha(page, "Paula Com CPF")).toBeVisible({ timeout: 30_000 });
  await expect(linha(page, "Paula Com CPF").getByText("Cliente", { exact: true })).toHaveCount(0);
});
