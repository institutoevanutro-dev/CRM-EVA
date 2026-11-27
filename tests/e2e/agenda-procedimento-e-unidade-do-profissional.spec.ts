import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { escolherDiaDesenhado, irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";
import { esperarAgenda } from "./helpers/tela-agenda";

/**
 * O "Novo agendamento" pela tela, como a recepção usa — o pedido do dono da
 * clínica em 20/11/2026:
 *
 *   1. Escolhido o profissional, SÓ os procedimentos cadastrados para ele (o tipo
 *      é dele, ou não tem dono). O grupo "Procedimentos de outros profissionais"
 *      saiu.
 *   2. SÓ as unidades onde ele atende (as janelas da jornada com `unit_id`); a
 *      única já vem escolhida; com duas, o Confirmar espera a escolha.
 *   3. Ao escolher o paciente, um cartão com os dados que temos dele — telefone,
 *      e-mail, nascimento e idade, CPF MASCARADO, última consulta — e a lista da
 *      busca separa homônimos pela idade.
 *   4. A rota recusa o que a tela não oferece (procedimento de outro, unidade
 *      fora da jornada), com o código nomeado.
 *
 * Organização própria, criada e apagada aqui: nada do que este arquivo grava
 * encosta nas outras specs. Nomes fictícios, de propósito.
 *
 * E o pedido de 21/11/2026, em cima do mesmo modal e da grade:
 *
 *   5. Só aparece no "Profissional" quem tem procedimento; "Marcada por" já vem
 *      em Mensagem; escolhido o paciente, a busca some e um X o desfaz.
 *   6. "Quem converteu" (padrão: quem marca) e "Origem do lead" (a regra do
 *      funil; mudar grava o "Como chegou" da ficha) vão junto com a marcação.
 *   7. A grade desenha só as horas das jornadas, com a meia hora marcada; o
 *      bloqueio de várias pessoas no mesmo trecho vira UMA faixa; a legenda diz
 *      de quem é cada cor.
 *
 * As fotos vão para `.superpowers/evidence/agenda-visual/` (claro e escuro,
 * computador e celular), como a doutrina de QA visual pede.
 */

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const senha = `Local-${randomUUID()}!`;
const EVIDENCIA = path.resolve(__dirname, "../../.superpowers/evidence/agenda-visual");

test.describe.configure({ timeout: 240_000, mode: "serial" });

const orgs: string[] = [];
const usuarios: string[] = [];

async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function pessoa(org: string, nome: string, role: string): Promise<{ id: string; email: string }> {
  const email = `agenda-visual-${randomUUID()}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
    user_metadata: { full_name: nome },
  });
  if (error || !data.user) throw error ?? new Error("usuário não criado");
  usuarios.push(data.user.id);
  await inserir("user_organizations", {
    organization_id: org,
    user_id: data.user.id,
    role,
    accepted_at: new Date().toISOString(),
  });
  return { id: data.user.id, email };
}

function jornada(org: string, usuario: string, janelas: Array<{ unit_id?: string }>) {
  return db.from("attendant_availability").upsert(
    {
      organization_id: org,
      user_id: usuario,
      is_available: true,
      schedule: {
        timezone: "America/Sao_Paulo",
        windows: [1, 2, 3, 4, 5].flatMap((dow) =>
          janelas.map((j, i) => ({
            dow,
            start: i === 0 ? "08:00" : "13:00",
            end: i === 0 ? "12:00" : "18:00",
            ...j,
          })),
        ),
      },
    },
    { onConflict: "organization_id,user_id" },
  );
}

async function clinica() {
  const org = await inserir("organizations", {
    slug: `agenda-visual-${randomUUID()}`,
    display_name: "Clínica Fictícia Agenda",
    legal_name: "Clínica Fictícia Agenda",
    onboarded_at: new Date().toISOString(),
  });
  orgs.push(org);
  const ana = await pessoa(org, "Dra. Ana Fictícia", "admin");
  const bruno = await pessoa(org, "Dr. Bruno Fictício", "agent");
  // Carla: nenhum procedimento dela e jornada que não diz unidade nenhuma.
  const carla = await pessoa(org, "Dra. Carla Fictícia", "agent");
  const centro = await inserir("calendar_units", { organization_id: org, name: "Unidade Centro" });
  const praia = await inserir("calendar_units", { organization_id: org, name: "Unidade Praia" });
  const tipo = (name: string, slug: string, dono: string | null, duracao: number) =>
    inserir("calendar_event_types", {
      organization_id: org,
      name,
      slug,
      duration_minutes: duracao,
      minimum_notice_minutes: 60,
      booking_window_days: 60,
      is_active: true,
      ...(dono ? { default_owner_user_id: dono } : {}),
    });
  // A org nova nasce com três tipos SEM dono (`fn_semear_tipos_de_agendamento`),
  // que aparecem para todo profissional. Aqui a clínica já os deu à Ana.
  const semeados = await db
    .from("calendar_event_types")
    .update({ default_owner_user_id: ana.id })
    .eq("organization_id", org)
    .is("default_owner_user_id", null);
  if (semeados.error) throw semeados.error;
  const avaliacao = await tipo("Avaliação facial", "avaliacao-facial", ana.id, 30);
  const retorno = await tipo("Retorno", "retorno", bruno.id, 20);
  const aplicacao = await tipo("Aplicação", "aplicacao", null, 15);
  // Ana atende só no Centro; Bruno, no Centro e na Praia (sem janela sem unidade).
  for (const r of [
    await jornada(org, ana.id, [{ unit_id: centro }]),
    await jornada(org, bruno.id, [{ unit_id: centro }, { unit_id: praia }]),
  ])
    if (r.error) throw r.error;
  // Dois homônimos: a lista da busca tem de separá-los.
  const ano = new Date().getFullYear();
  const helena = await inserir("contacts", {
    organization_id: org,
    name: "Helena Fictícia Prado",
    phone_number: "+5527999990101",
    email: "helena.prado@exemplo.test",
    birthdate: `${ano - 34}-03-12`,
    source: "manual",
  });
  await inserir("contacts", {
    organization_id: org,
    name: "Helena Fictícia Souza",
    phone_number: "+5527999990202",
    birthdate: `${ano - 61}-07-30`,
    source: "manual",
  });
  // Uma consulta que já passou: o cartão mostra a "Última consulta".
  const passada = new Date(Date.now() - 40 * 86_400_000);
  passada.setUTCHours(13, 0, 0, 0);
  await inserir("calendar_appointments", {
    organization_id: org,
    contact_id: helena,
    event_type_id: avaliacao,
    owner_user_id: ana.id,
    title: "Avaliação facial",
    status: "completed",
    starts_at: passada.toISOString(),
    ends_at: new Date(passada.getTime() + 30 * 60_000).toISOString(),
    time_zone: "America/Sao_Paulo",
  });
  return { org, ana, bruno, carla, centro, praia, avaliacao, retorno, aplicacao, helena };
}

async function entrar(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
  // No WebKit (o Safari do dono da clínica) o `/app` ainda redireciona para o
  // Início quando o `goto` seguinte sai, e a navegação é interrompida. Esperar o
  // destino final tira a corrida sem mudar o que se prova.
  await page.waitForURL(/\/app\/inicio/, { timeout: 60_000 }).catch(() => undefined);
}

async function foto(page: Page, nome: string) {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  // O nome do navegador vai no arquivo: o Safari (WebKit) é o do dono da clínica.
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}-${test.info().project.name}.png`) });
}

const opcoes = (page: Page, testid: string) =>
  page.getByTestId(testid).locator("option").allTextContents();

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

let f: Awaited<ReturnType<typeof clinica>>;

test("procedimento, unidade e paciente: a tela oferece só o que é do profissional e confere o paciente", async ({
  page,
}) => {
  f = await clinica();
  // Sem transição de cor no meio da foto (e o caminho de movimento reduzido exercitado).
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await entrar(page, f.ana.email);
  await page.goto("/app/agenda");
  await esperarAgenda(page, 30_000);
  const dias = await irParaASemanaSeguinte(page);
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 15_000 });
  await foto(page, "1-modal-aberto-1280x800-claro");

  // ── Bruno: só os procedimentos dele e os sem dono; duas unidades, nenhuma escolhida.
  const profissional = page.getByTestId("profissional-da-marcacao");
  await expect.poll(async () => (await opcoes(page, "profissional-da-marcacao")).length).toBeGreaterThan(2);
  await profissional.selectOption(f.bruno.id);
  expect(await opcoes(page, "procedimento-da-marcacao")).toEqual([
    "Escolha o procedimento",
    "Aplicação · 15 min",
    "Retorno · 20 min",
  ]);
  await expect.poll(() => opcoes(page, "unidade-do-agendamento")).toEqual([
    "Escolha a unidade",
    "Unidade Centro",
    "Unidade Praia",
  ]);
  await expect(page.getByTestId("unidade-do-agendamento")).toHaveValue("");

  // ── Ana: o "Retorno" do Bruno some; a única unidade dela já vem escolhida.
  await profissional.selectOption(f.ana.id);
  const daAna = await opcoes(page, "procedimento-da-marcacao");
  expect(daAna).toContain("Avaliação facial · 30 min");
  expect(daAna).toContain("Aplicação · 15 min");
  expect(daAna, "o procedimento do Bruno apareceu para a Ana").not.toContain("Retorno · 20 min");
  await expect(page.getByTestId("unidade-do-agendamento")).toHaveValue(f.centro);
  expect(await opcoes(page, "unidade-do-agendamento")).toEqual(["Escolha a unidade", "Unidade Centro"]);
  await page.getByTestId("procedimento-da-marcacao").selectOption({ label: "Avaliação facial · 30 min" });

  // ── Paciente: a lista separa as duas Helenas pela idade; o cartão confere a escolhida.
  await page.getByRole("combobox", { name: "Paciente" }).fill("Helena");
  const lista = page.getByRole("listbox");
  await expect(lista.getByRole("option")).toHaveCount(2, { timeout: 15_000 });
  const ano = new Date().getFullYear();
  const idadePrado = new Date() >= new Date(ano, 2, 12) ? 34 : 33;
  await expect(lista.getByRole("option", { name: /Helena Fictícia Prado/ })).toContainText(`${idadePrado} anos`);
  await expect(lista.getByRole("option", { name: /Helena Fictícia Prado/ })).toContainText("(27) 99999-0101");
  await foto(page, "2-busca-com-homonimos-1280x800-claro");
  await lista.getByRole("option", { name: /Helena Fictícia Prado/ }).click();

  const cartao = page.getByTestId("paciente-escolhido");
  await expect(cartao).toHaveAttribute("data-contact-id", f.helena);
  // Escolhido o paciente, a busca SAI da tela; o X o desfaz e a devolve.
  await expect(page.getByRole("combobox", { name: "Paciente" })).toHaveCount(0);
  await page.getByTestId("tirar-paciente").click();
  await expect(page.getByTestId("paciente-escolhido")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Paciente" })).toBeFocused();
  await page.getByRole("combobox", { name: "Paciente" }).fill("Helena Fictícia Prado");
  await page.getByRole("listbox").getByRole("option", { name: /Helena Fictícia Prado/ }).click();
  await expect(cartao).toHaveAttribute("data-contact-id", f.helena);
  await expect(cartao).toContainText("(27) 99999-0101");
  await expect(cartao).toContainText("helena.prado@exemplo.test");
  await expect(cartao).toContainText(`12/03/${ano - 34}`);
  await expect(cartao.locator('[data-dado="ultima"]')).toContainText("Avaliação facial", { timeout: 15_000 });

  // ── Dia, horário, canal: confirma na unidade do Centro.
  await escolherDiaDesenhado(page, dias);
  const horario = page.locator('[data-testid^="horario-"]').first();
  await expect(horario).toBeVisible({ timeout: 15_000 });
  await horario.click();
  // "Marcada por" já vem em Mensagem; ninguém precisa tocar nele.
  await expect(page.getByTestId("canal-mensagem")).toHaveAttribute("aria-pressed", "true");
  // Quem converteu vem com quem marca (a Ana); aqui foi o Bruno. A origem sai da
  // ficha pela regra do funil (cadastro manual, sem etiqueta: Orgânico), e a
  // recepção corrige para Indicação.
  // "Avaliação facial" não é "Primeira…": a marcação abre em Paciente antigo, e
  // "Quem converteu"/"Origem" só existem em Paciente novo (27/11/2026).
  await page.getByTestId("paciente-novo").click();
  await expect(page.getByTestId("quem-converteu")).toHaveValue(`user:${f.ana.id}`);
  await page.getByTestId("quem-converteu").selectOption(`user:${f.bruno.id}`);
  await expect(page.getByTestId("origem-do-lead")).toHaveValue("organico", { timeout: 15_000 });
  await page.getByTestId("origem-do-lead").selectOption("indicacao");
  await expect(page.getByTestId("resumo-da-marcacao")).toContainText(
    "Avaliação facial · Dra. Ana Fictícia · Unidade Centro · Helena Fictícia Prado",
  );
  await foto(page, "3-pronto-para-confirmar-1280x800-claro");

  // Cabe sem rolar no notebook, com o cartão do paciente aberto.
  const medida = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]') as HTMLElement;
    const c = document.querySelector('[data-testid="confirmar-marcacao"]') as HTMLElement;
    return {
      sobra: d.scrollHeight - d.clientHeight,
      fimDoConfirmar: c.getBoundingClientRect().bottom,
      janela: window.innerHeight,
    };
  });
  expect(medida.fimDoConfirmar, JSON.stringify(medida)).toBeLessThanOrEqual(medida.janela);
  expect(medida.sobra, `com o cartão do paciente o modal pede rolagem: ${JSON.stringify(medida)}`).toBeLessThanOrEqual(1);

  const marcou = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/v1/agenda/agendamentos" && r.request().method() === "POST",
  );
  await page.getByTestId("confirmar-marcacao").click();
  const resposta = await marcou;
  expect(resposta.ok(), await resposta.text()).toBe(true);
  await expect(page.getByTestId("ver-na-agenda")).toBeVisible();
  await foto(page, "4-marcado-1280x800-claro");

  const { data: criado } = await db
    .from("calendar_appointments")
    .select("owner_user_id, event_type_id, unit_id, contact_id, booking_channel, converted_by_kind, converted_by_user_id")
    .eq("organization_id", f.org)
    .neq("status", "completed")
    .single();
  expect(criado).toEqual({
    owner_user_id: f.ana.id,
    event_type_id: f.avaliacao,
    unit_id: f.centro,
    contact_id: f.helena,
    booking_channel: "mensagem",
    converted_by_kind: "user",
    converted_by_user_id: f.bruno.id,
  });
  const { data: ficha } = await db.from("contacts").select("source_metadata").eq("id", f.helena).single();
  expect((ficha?.source_metadata as Record<string, unknown> | null)?.origem_informada).toBe("indicacao");
});

test("profissional sem procedimento não aparece; jornada sem unidade mostra todas, com aviso", async ({ page }) => {
  // O único tipo "de todos" passa a ser do Bruno: a Carla fica sem nenhum.
  const r = await db.from("calendar_event_types").update({ default_owner_user_id: f.bruno.id }).eq("id", f.aplicacao);
  if (r.error) throw r.error;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await entrar(page, f.ana.email);
  await page.goto("/app/agenda");
  await esperarAgenda(page, 30_000);
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect.poll(async () => (await opcoes(page, "profissional-da-marcacao")).length).toBeGreaterThan(2);
  const semCarla = await opcoes(page, "profissional-da-marcacao");
  expect(semCarla.some((o) => o.includes("Carla")), "quem não tem procedimento apareceu na lista").toBe(false);
  await foto(page, "1b-profissional-sem-procedimento-1280x800-claro");

  // Com um procedimento dela, a Carla entra na lista; a jornada dela não diz
  // unidade nenhuma: todas aparecem, e a tela diz por quê.
  await inserir("calendar_event_types", {
    organization_id: f.org,
    name: "Consulta da Carla",
    slug: "consulta-da-carla",
    duration_minutes: 30,
    minimum_notice_minutes: 60,
    booking_window_days: 60,
    is_active: true,
    default_owner_user_id: f.carla.id,
  });
  await page.reload();
  await esperarAgenda(page, 30_000);
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect.poll(async () => (await opcoes(page, "profissional-da-marcacao")).some((o) => o.includes("Carla"))).toBe(
    true,
  );
  await page.getByTestId("profissional-da-marcacao").selectOption(f.carla.id);
  await expect(page.getByTestId("unidades-sem-jornada")).toBeVisible();
  expect(await opcoes(page, "unidade-do-agendamento")).toEqual([
    "Teleconsulta ou sem unidade",
    "Unidade Centro",
    "Unidade Praia",
  ]);
});

test("a rota recusa o que a tela não oferece: procedimento de outro e unidade fora da jornada", async ({ page }) => {
  await entrar(page, f.ana.email);
  const amanha = new Date(Date.now() + 7 * 86_400_000);
  while ([0, 6].includes(amanha.getUTCDay())) amanha.setUTCDate(amanha.getUTCDate() + 1);
  amanha.setUTCHours(14, 0, 0, 0);
  const marcar = (corpo: Record<string, unknown>) =>
    page.request.post("/api/v1/agenda/agendamentos", {
      data: { starts_at: amanha.toISOString(), booking_channel: "mensagem", contact_id: f.helena, ...corpo },
    });

  const deOutro = await marcar({ event_type_id: f.retorno, owner_user_id: f.ana.id });
  expect(deOutro.status()).toBe(422);
  expect((await deOutro.json()).error.code).toBe("agenda_procedimento_de_outro_profissional");

  const foraDaJornada = await marcar({ event_type_id: f.avaliacao, owner_user_id: f.ana.id, unit_id: f.praia });
  expect(foraDaJornada.status()).toBe(422);
  expect((await foraDaJornada.json()).error.code).toBe("agenda_unidade_fora_da_jornada");
});

for (const tema of ["claro", "escuro"] as const) {
  for (const tela of [
    { nome: "375x812", width: 375, height: 812 },
    { nome: "1440x900", width: 1440, height: 900 },
  ]) {
    test(`fotos do modal com o paciente escolhido — ${tela.nome}, ${tema}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: tema === "escuro" ? "dark" : "light", reducedMotion: "reduce" });
      // O tema do produto é escolha guardada no navegador (padrão claro), não o do sistema.
      await page.addInitScript((t) => window.localStorage.setItem("deskcomm-theme", t), tema === "escuro" ? "dark" : "light");
      await page.setViewportSize({ width: tela.width, height: tela.height });
      await entrar(page, f.ana.email);
      await page.goto("/app/agenda");
      await esperarAgenda(page, 30_000);
      await page.getByRole("button", { name: /novo agendamento/i }).click();
      await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await opcoes(page, "profissional-da-marcacao")).length).toBeGreaterThan(2);
      await page.getByTestId("profissional-da-marcacao").selectOption(f.ana.id);
      await page.getByTestId("procedimento-da-marcacao").selectOption({ label: "Avaliação facial · 30 min" });
      await page.getByRole("combobox", { name: "Paciente" }).fill("Helena Fictícia Prado");
      await page.getByRole("listbox").getByRole("option", { name: /Helena Fictícia Prado/ }).click({ timeout: 15_000 });
      await expect(page.getByTestId("paciente-escolhido")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("paciente-escolhido").locator('[data-dado="ultima"]')).toBeVisible({
        timeout: 15_000,
      });

      // Sem rolagem para o lado em nenhuma largura; o tema chegou ao modal.
      const m = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]') as HTMLElement;
        return {
          sobraHorizontal: d.scrollWidth - d.clientWidth,
          pagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          tema: document.documentElement.getAttribute("data-theme"),
          fundo: getComputedStyle(d).backgroundColor,
        };
      });
      expect(m.sobraHorizontal, JSON.stringify(m)).toBeLessThanOrEqual(1);
      expect(m.pagina, JSON.stringify(m)).toBeLessThanOrEqual(1);
      expect(m.tema).toBe(tema === "escuro" ? "dark" : "light");
      await foto(page, `5-paciente-escolhido-${tela.nome}-${tema}`);
      if (tela.width < 768) {
        // No celular a coluna é uma só: rola até o calendário e o rodapé fica alcançável.
        await page.getByTestId("lista-de-horarios").scrollIntoViewIfNeeded();
        await foto(page, `6-calendario-${tela.nome}-${tema}`);
        await expect(page.getByTestId("confirmar-marcacao")).toBeInViewport();
      }
    });
  }
}

test("a grade: só as horas das jornadas, meia hora marcada, cor por profissional e o bloqueio uma vez só", async ({
  page,
}) => {
  // Semana seguinte: uma consulta de cada profissional e um bloqueio do dia
  // inteiro para os dois na quarta (feriado). Antes, o feriado desenhava a grade
  // da meia-noite às 23h, em colunas estreitas e por cima de outra faixa.
  // A segunda da semana SEGUINTE à de hoje, no calendário de São Paulo (UTC-3):
  // é a semana que `irParaASemanaSeguinte` desenha (domingo a sábado).
  const agoraSP = new Date(Date.now() - 3 * 3_600_000);
  const segunda = Date.UTC(agoraSP.getUTCFullYear(), agoraSP.getUTCMonth(), agoraSP.getUTCDate() - agoraSP.getUTCDay() + 8);
  const dia = (n: number, hora: number) => new Date(segunda + n * 86_400_000 + (hora + 3) * 3_600_000);
  for (const [dono, tipo, d] of [
    [f.ana.id, f.avaliacao, dia(0, 9)],
    [f.bruno.id, f.retorno, dia(1, 14)],
  ] as const) {
    await inserir("calendar_appointments", {
      organization_id: f.org,
      contact_id: f.helena,
      event_type_id: tipo,
      owner_user_id: dono,
      title: "Consulta fictícia",
      status: "confirmed",
      starts_at: d.toISOString(),
      ends_at: new Date(d.getTime() + 30 * 60_000).toISOString(),
      time_zone: "America/Sao_Paulo",
      unit_id: f.centro,
    });
  }
  const quarta = dia(2, 0).toISOString().slice(0, 10);
  for (const dono of [f.ana.id, f.bruno.id]) {
    await inserir("calendar_availability_exceptions", {
      organization_id: f.org,
      user_id: dono,
      exception_date: quarta,
      is_unavailable: true,
      start_minute: 0,
      end_minute: 1440,
      reason: "Feriado fictício",
    });
  }

  for (const tema of ["claro", "escuro"] as const) {
    await page.emulateMedia({ colorScheme: tema === "escuro" ? "dark" : "light", reducedMotion: "reduce" });
    await page.addInitScript((t) => window.localStorage.setItem("deskcomm-theme", t), tema === "escuro" ? "dark" : "light");
    await page.setViewportSize({ width: 1280, height: 800 });
    await entrar(page, f.ana.email);
    await page.goto("/app/agenda");
    await esperarAgenda(page, 30_000);
    await irParaASemanaSeguinte(page);

    const grade = page.getByTestId("grade-da-agenda");
    // Jornadas das 08:00 às 18:00: a primeira hora é 08:00, a última 17:30 — sem madrugada.
    await expect(grade).toContainText("08:00");
    await expect(grade).toContainText("17:30");
    await expect(grade).not.toContainText("00:00");
    await expect(grade).not.toContainText("18:00");

    // O feriado dos dois é UMA faixa, com os dois nomes.
    const colunaDaQuarta = page.getByTestId(`coluna-dia-${quarta}`);
    const faixas = colunaDaQuarta.locator('[data-testid^="fechamento-"]');
    await expect(faixas).toHaveCount(1);
    await expect(faixas.first()).toHaveAttribute("data-fechamentos", "2");
    await expect(faixas.first()).toContainText("Bloqueado");
    // E não há cartão "Horário bloqueado" desenhado por cima dela.
    await expect(colunaDaQuarta.locator('[data-testid^="agendamento-bloqueio:"]')).toHaveCount(0);

    // A fileira em cima diz de quem é cada cor (a legenda de pessoas do rodapé saiu em 27/11/2026).
    await expect(page.getByTestId(`botao-pessoa-${f.ana.id}`)).toBeVisible();
    await expect(page.getByTestId(`botao-pessoa-${f.bruno.id}`)).toBeVisible();
    const fundos = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid^="agendamento-"][data-trilha]')].map(
        (el) => getComputedStyle(el).backgroundColor,
      ),
    );
    expect(new Set(fundos).size, JSON.stringify(fundos)).toBeGreaterThan(1);
    await foto(page, `7-grade-semana-1280x800-${tema}`);
  }
});

