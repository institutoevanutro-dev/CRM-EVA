import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import {
  escolherDiaDesenhado,
  irParaASemanaDoCompromisso,
  irParaASemanaSeguinte,
} from "./helpers/agenda-semana-integra";
import { escolherProfissionalEProcedimento } from "./helpers/marcacao-simples";
import { esperarAgenda } from "./helpers/tela-agenda";

/**
 * NOME COMPLETO DO PACIENTE NA MARCAÇÃO, pela tela.
 *
 * O prontuário abre o atendimento pelo nome do CADASTRO e recusa sem ele. As
 * consultas nasciam para quem só tinha o nome do WhatsApp, e o atendimento não
 * abria no dia. O que esta spec prova, como a recepção faria:
 *
 *   1. no "Novo agendamento", o paciente só com o nome do WhatsApp ganha o
 *      campo "Nome completo do paciente", já preenchido com ele; uma palavra só
 *      não libera o Confirmar; ao confirmar, o nome vai para o cadastro (com a
 *      auditoria da ficha) ANTES de o agendamento nascer;
 *   2. o que a IA marca não passa pelo modal e não é barrado: a grade mostra o
 *      compromisso marcado, e o painel dele completa o nome.
 *
 * Organização própria, criada aqui e apagada no fim, como `cliente-pela-agenda`:
 * os contatos sem nome não podem cair nas contagens de outra spec. Nomes
 * fictícios.
 */
const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const senha = `Local-${randomUUID()}!`;

test.describe.configure({ timeout: 180_000 });

const orgs: string[] = [];
const usuarios: string[] = [];

async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function organizacaoDeTeste() {
  const email = `nome-completo-${randomUUID()}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("usuário não criado");
  const usuario = data.user.id;
  usuarios.push(usuario);
  const org = await inserir("organizations", {
    slug: `nome-completo-${randomUUID()}`,
    display_name: "Clínica Nome Completo",
    legal_name: "Clínica Nome Completo",
    onboarded_at: new Date().toISOString(),
  });
  orgs.push(org);
  await inserir("user_organizations", {
    organization_id: org,
    user_id: usuario,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  const tipo = await inserir("calendar_event_types", {
    organization_id: org,
    name: "Avaliação facial",
    slug: "avaliacao-facial",
    duration_minutes: 30,
    minimum_notice_minutes: 60,
    booking_window_days: 60,
    is_active: true,
    default_owner_user_id: usuario,
  });
  const jornada = await db.from("attendant_availability").upsert(
    {
      organization_id: org,
      user_id: usuario,
      is_available: true,
      schedule: {
        timezone: "America/Sao_Paulo",
        windows: [1, 2, 3, 4, 5].map((dow) => ({ dow, start: "09:00", end: "18:00" })),
      },
    },
    { onConflict: "organization_id,user_id" },
  );
  if (jornada.error) throw jornada.error;
  return { org, email, usuario, tipo };
}

/** Quem chegou pelo WhatsApp: só o nome do perfil, nada no cadastro. */
function soComONomeDoWhatsApp(org: string, nome: string): Promise<string> {
  return inserir("contacts", {
    organization_id: org,
    display_name: nome,
    phone_number: `+55279${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`,
    source: "whatsapp",
  });
}

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

async function nomeNoCadastro(contato: string): Promise<string | null> {
  const { data, error } = await db.from("contacts").select("name").eq("id", contato).single();
  if (error) throw error;
  return (data as { name: string | null }).name;
}

/** Um dia útil da semana que vem, às 10h de São Paulo (13h UTC). */
function diaUtilDaSemanaQueVem(): { inicio: string; fim: string } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 8);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(13, 0, 0, 0);
  return { inicio: d.toISOString(), fim: new Date(d.getTime() + 30 * 60_000).toISOString() };
}

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

test("o Novo agendamento pede o nome completo de quem só tem o do WhatsApp e grava antes de agendar", async ({
  page,
}, info) => {
  const f = await organizacaoDeTeste();
  const contato = await soComONomeDoWhatsApp(f.org, "Carla Fictícia");
  await entrar(page, f.email);

  await page.goto("/app/agenda");
  await esperarAgenda(page, 30_000);
  const dias = await irParaASemanaSeguinte(page);
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("combobox", { name: "Paciente" }).fill("Carla");
  const lista = page.getByRole("listbox");
  await expect(lista).toBeVisible({ timeout: 15_000 });
  await lista.getByRole("option", { name: /Carla Fictícia/ }).click();
  await expect(page.getByTestId("paciente-escolhido")).toHaveAttribute("data-contact-id", contato);

  // O campo nasce com o nome do WhatsApp, para a recepção conferir.
  const campo = page.getByTestId("campo-nome-completo");
  await expect(campo).toHaveValue("Carla Fictícia", { timeout: 15_000 });

  await escolherProfissionalEProcedimento(page, /^Avaliação facial/);
  await escolherDiaDesenhado(page, dias);
  await page.locator('[data-testid^="horario-"]').first().click();

  // Uma palavra só não marca: o botão espera e o rodapé diz por quê.
  await campo.fill("Carla");
  await expect(page.getByTestId("confirmar-marcacao")).toBeDisabled();
  await expect(page.getByTestId("falta-nome-na-marcacao")).toBeVisible();
  await evidencia(page, info, "0-uma-palavra-nao-libera");

  await campo.fill("Carla Fictícia Souza");
  await expect(page.getByTestId("confirmar-marcacao")).toBeEnabled();
  await evidencia(page, info, "1-nome-completo-conferido");

  const pedidos: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (r.method() === "PATCH" && u.pathname === `/api/v1/contacts/${contato}`) pedidos.push("nome");
    if (r.method() === "POST" && u.pathname === "/api/v1/agenda/agendamentos") pedidos.push("agendamento");
  });
  const gravouNome = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/v1/contacts/${contato}` && r.request().method() === "PATCH",
  );
  const marcou = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/v1/agenda/agendamentos" && r.request().method() === "POST",
  );
  await page.getByTestId("confirmar-marcacao").click();
  const respostaDoNome = await gravouNome;
  expect(respostaDoNome.ok(), `o nome foi recusado: ${await respostaDoNome.text()}`).toBe(true);
  const respostaDaMarcacao = await marcou;
  expect(respostaDaMarcacao.ok(), `a marcação foi recusada: ${await respostaDaMarcacao.text()}`).toBe(true);
  await expect(page.getByTestId("ver-na-agenda")).toBeVisible();
  expect(pedidos, "o nome tem de ir para o cadastro ANTES de o agendamento nascer").toEqual(["nome", "agendamento"]);

  expect(await nomeNoCadastro(contato)).toBe("Carla Fictícia Souza");
  const { data: agendamento } = await db
    .from("calendar_appointments")
    .select("contact_id")
    .eq("organization_id", f.org)
    .single();
  expect(agendamento?.contact_id).toBe(contato);
  // Pelo caminho de sempre da ficha: a auditoria guarda o antes e o depois.
  await expect
    .poll(
      async () => {
        const { data } = await db
          .from("api_audit_log")
          .select("metadata")
          .eq("organization_id", f.org)
          .eq("action", "contact.updated")
          .eq("resource_id", contato);
        return (data ?? []).map((l) => (l.metadata as { new_name?: string }).new_name);
      },
      { timeout: 15_000 },
    )
    .toContain("Carla Fictícia Souza");
  await evidencia(page, info, "2-marcado-com-o-nome-no-cadastro");
});

test("o que a IA marca para quem não tem nome completo aparece marcado na grade, e o painel completa", async ({
  page,
}, info) => {
  const f = await organizacaoDeTeste();
  const contato = await soComONomeDoWhatsApp(f.org, "Dora Teste");
  const { inicio, fim } = diaUtilDaSemanaQueVem();
  // Como a ferramenta da IA grava: direto, sem modal, e sem barrar.
  const compromisso = await inserir("calendar_appointments", {
    organization_id: f.org,
    contact_id: contato,
    event_type_id: f.tipo,
    owner_user_id: f.usuario,
    title: "Avaliação facial",
    status: "confirmed",
    starts_at: inicio,
    ends_at: fim,
  });
  await entrar(page, f.email);

  await page.goto("/app/agenda");
  await esperarAgenda(page, 30_000);
  await irParaASemanaDoCompromisso(page, inicio);
  const bloco = page.getByTestId(`agendamento-${compromisso}`);
  await expect(bloco).toHaveAttribute("data-falta-nome", "true", { timeout: 15_000 });
  await expect(bloco).toHaveAttribute("title", "Falta o nome completo");
  await bloco.scrollIntoViewIfNeeded();
  await evidencia(page, info, "0-grade-marca-quem-falta-o-nome");

  await bloco.click();
  const aviso = page.getByTestId("falta-nome-completo");
  await expect(aviso).toBeVisible({ timeout: 15_000 });
  const campo = aviso.getByTestId("campo-nome-completo");
  await expect(campo).toHaveValue("Dora Teste");
  await campo.fill("Dora Teste Lima");
  await evidencia(page, info, "1-painel-completa-o-nome");

  const gravou = page.waitForResponse(
    (r) => new URL(r.url()).pathname === `/api/v1/contacts/${contato}` && r.request().method() === "PATCH",
  );
  await aviso.getByTestId("salvar-nome-completo").click();
  expect((await gravou).ok()).toBe(true);
  await expect(page.getByTestId("falta-nome-completo")).toHaveCount(0, { timeout: 15_000 });
  expect(await nomeNoCadastro(contato)).toBe("Dora Teste Lima");

  // Fechado o painel, a grade relida já não avisa.
  await page.keyboard.press("Escape");
  await expect(bloco).not.toHaveAttribute("data-falta-nome", "true", { timeout: 15_000 });
  await evidencia(page, info, "2-grade-sem-aviso-depois-de-completar");
});
