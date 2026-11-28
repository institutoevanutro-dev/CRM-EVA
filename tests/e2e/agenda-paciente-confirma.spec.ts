import { randomInt, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { FRASE_PEDIDO_DE_CONFIRMACAO } from "../../lib/agenda/texto-do-lembrete";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { esperarAgenda, esperarTela } from "./helpers/tela-agenda";

/**
 * O PACIENTE CONFIRMA A PRESENÇA RESPONDENDO AO LEMBRETE — pela tela (0441).
 *
 * A jornada inteira, como a clínica a vive:
 *
 *   1. em Configurações › Tipos de agendamento, liga o lembrete do tipo e a
 *      chave "Pedir confirmação no lembrete" (a prévia já termina pedindo SIM);
 *   2. o cron do lembrete, chamado pelo endpoint com o segredo do e2e, manda a
 *      mensagem — e o RECEPTOR (o "WAHA" desta spec) prova que o texto que saiu
 *      termina com a frase;
 *   3. a grade mostra "Lembrete sem resposta" no cartão;
 *   4. o paciente responde "SIM" pelo CAMINHO DE PRODUÇÃO
 *      (`POST /api/v1/webhooks/waha/[token]`, o de `conversa-vira-lead`);
 *   5. o cartão troca o sino pelo check de "Presença confirmada", e o painel diz
 *      "pelo WhatsApp";
 *   6. noutro compromisso, a recepção marca "Paciente confirmou" pelo painel.
 *
 * ─── Por que há um receptor na porta do WAHA ────────────────────────────────
 *
 * O `.env.e2e` aponta `WAHA_API_BASE_URL` para `127.0.0.1:3999`, onde não há
 * ninguém (`automacao-diz-a-verdade` conta com isso). Sem receptor o lembrete
 * sai `failed`, e o leitor do SIM, de propósito, não lê lembrete que não saiu:
 * o paciente não o viu. O receptor faz o papel do WAHA — aceita o envio,
 * devolve o id — e guarda o que chegou, que é a prova do texto. Mesmo recurso
 * de `roteamento-por-canal`.
 *
 * ⚠️ ORGANIZAÇÃO PRÓPRIA, criada aqui e apagada no fim (`paciente-pelo-cadastro`,
 * `agenda-presenca-recuperacao`): ligar o lembrete num tipo da organização
 * compartilhada faria o cron das specs seguintes mandar lembrete dos
 * compromissos delas. O cron é GLOBAL, então um compromisso vencido de outra
 * organização também passa por este receptor — inofensivo, e as asserções
 * filtram pelo número desta spec.
 */
// O `.env.e2e` chega ao `process.env` pelo `playwright.config.ts` (`publicarNoProcesso`).
const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const senha = `Local-${randomUUID()}!`;

// Uma jornada só, com dois logins evitados: fixture, configuração, cron,
// mensagem e duas leituras da grade.
test.describe.configure({ timeout: 240_000 });

const orgs: string[] = [];
const usuarios: string[] = [];

async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return (data as { id: string }).id;
}

/** Telefone móvel de SP com o nono dígito: 13 dígitos, como o WhatsApp o manda. */
const telefone = () => `55119${randomInt(10_000_000, 99_999_999)}`;

async function organizacaoDeTeste() {
  const email = `paciente-confirma-${randomUUID()}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
    user_metadata: { full_name: "Recepção Confirma Teste" },
  });
  if (error || !data.user) throw error ?? new Error("usuário não criado");
  const usuario = data.user.id;
  usuarios.push(usuario);
  const org = await inserir("organizations", {
    slug: `paciente-confirma-${randomUUID()}`,
    display_name: "Clínica Confirma pelo Lembrete",
    legal_name: "Clínica Confirma pelo Lembrete",
    onboarded_at: new Date().toISOString(),
  });
  orgs.push(org);
  await inserir("user_organizations", {
    organization_id: org,
    user_id: usuario,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });

  // O número da clínica: WORKING (o cron só escolhe número conectado) e com o
  // token do webhook (é por ele que a resposta do paciente acha a organização).
  const webhookToken = `e2e-confirma-${randomUUID()}`;
  const sessao = `e2e-confirma-${randomUUID()}`;
  const canal = await inserir("channel_sessions", {
    organization_id: org,
    waha_session_name: sessao,
    display_name: "Número da clínica E2E",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
    webhook_path_token: webhookToken,
  });
  // Janela anti-ban 0h–24h: o lembrete respeita a janela do número, e a hora do
  // CI não pode decidir a spec (ver `utils/janela-de-envio.ts`).
  const janela = await db
    .from("channel_knobs")
    .upsert(
      { organization_id: org, channel_session_id: canal, window_start_hour: 0, window_end_hour: 24, allow_sunday: true },
      { onConflict: "organization_id,channel_session_id" },
    );
  if (janela.error) throw janela.error;
  const disponibilidade = await db.from("attendant_availability").upsert(
    {
      organization_id: org,
      user_id: usuario,
      is_available: true,
      schedule: {
        timezone: "America/Sao_Paulo",
        windows: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, start: "07:00", end: "21:00" })),
      },
    },
    { onConflict: "organization_id,user_id" },
  );
  if (disponibilidade.error) throw disponibilidade.error;

  // O tipo nasce com o lembrete DESLIGADO (o padrão): quem liga é a tela.
  const nomeDoTipo = `Consulta Confirma ${randomUUID().slice(0, 6)}`;
  const tipo = await inserir("calendar_event_types", {
    organization_id: org,
    name: nomeDoTipo,
    slug: `consulta-confirma-${randomUUID().slice(0, 8)}`,
    duration_minutes: 30,
    minimum_notice_minutes: 60,
    booking_window_days: 60,
    is_active: true,
    default_owner_user_id: usuario,
  });

  async function paciente(nome: string) {
    const digitos = telefone();
    const contato = await inserir("contacts", {
      organization_id: org,
      name: nome,
      display_name: nome,
      phone_number: `+${digitos}`,
    });
    const conversa = await inserir("conversations", {
      organization_id: org,
      contact_id: contato,
      channel_session_id: canal,
      status: "open",
      assigned_to_user_id: usuario,
    });
    return { contato, conversa, digitos };
  }

  /**
   * Compromisso Agendado que começa daqui a `minutos`. `created_at` vai três
   * horas para trás: o degrau do lembrete (60 min antes) tem de ter vencido
   * DEPOIS da marcação, senão o cron o descarta como "vencido na marcação"
   * (#2223) — e é assim que um compromisso marcado com antecedência real chega
   * à hora do lembrete.
   */
  async function compromisso(p: Awaited<ReturnType<typeof paciente>>, titulo: string, minutos: number) {
    const inicio = Date.now() + minutos * 60_000;
    return inserir("calendar_appointments", {
      organization_id: org,
      contact_id: p.contato,
      conversation_id: p.conversa,
      event_type_id: tipo,
      owner_user_id: usuario,
      title: titulo,
      status: "confirmed",
      starts_at: new Date(inicio).toISOString(),
      ends_at: new Date(inicio + 30 * 60_000).toISOString(),
      created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    });
  }

  const ana = await paciente("Ana Confirma Teste");
  const bruno = await paciente("Bruno Telefone Teste");
  return {
    org,
    usuario,
    email,
    webhookToken,
    sessao,
    tipo,
    nomeDoTipo,
    ana,
    bruno,
    // 45 min: o degrau de 60 min já venceu. 3 h: o dele ainda não.
    lembrado: await compromisso(ana, "Consulta da Ana", 45),
    porTelefone: await compromisso(bruno, "Consulta do Bruno", 180),
  };
}

type Fixture = Awaited<ReturnType<typeof organizacaoDeTeste>>;

/** O "WAHA": aceita qualquer chamada, devolve id no envio e só reconhece os números desta spec. */
interface Receptor {
  envios: Array<{ chatId: string; text: string }>;
  fechar: () => Promise<void>;
}

async function subirReceptor(numeros: string[]): Promise<Receptor> {
  const base = new URL(process.env.WAHA_API_BASE_URL ?? "");
  expect(["127.0.0.1", "localhost"], "o receptor só sobe em loopback").toContain(base.hostname);
  const envios: Receptor["envios"] = [];
  const server: Server = createServer((req, res) => {
    let corpo = "";
    req.on("data", (c: Buffer) => (corpo += c.toString("utf8")));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      let resposta: unknown = {};
      if (url.pathname === "/api/contacts/check-exists") {
        const fone = url.searchParams.get("phone") ?? "";
        resposta = numeros.includes(fone) ? { numberExists: true, chatId: `${fone}@c.us` } : { numberExists: false };
      } else if (url.pathname === "/api/sendText" && req.method === "POST") {
        const { chatId, text } = JSON.parse(corpo || "{}") as { chatId?: string; text?: string };
        envios.push({ chatId: chatId ?? "", text: text ?? "" });
        resposta = { id: `3EB0E2E${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}` };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(resposta));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(base.port), base.hostname, resolve);
  });
  return { envios, fechar: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function segredoDoCron(): string {
  const s = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  if (!s) throw new Error("O e2e precisa da credencial local do cron (INTERNAL_SECRET).");
  return s;
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

/**
 * O cartão na grade. A semana desenhada é a de hoje; um compromisso daqui a
 * 45 min que cai na segunda-feira seguinte (domingo à noite) está na próxima.
 */
async function cartaoNaGrade(page: Page, id: string) {
  await page.goto("/app/agenda");
  await esperarAgenda(page, 30_000);
  const cartao = page.getByTestId(`agendamento-${id}`);
  const nestaSemana = await cartao.waitFor({ state: "visible", timeout: 15_000 }).then(
    () => true,
    () => false,
  );
  if (!nestaSemana) {
    await page.getByTestId("periodo-seguinte").click();
    await expect(cartao, "o compromisso não apareceu nem na semana seguinte").toBeVisible({ timeout: 20_000 });
  }
  return cartao;
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

test("o paciente responde SIM ao lembrete e a Agenda mostra a presença confirmada; a recepção marca a de quem ligou", async ({
  page,
}, info) => {
  const f: Fixture = await organizacaoDeTeste();
  const receptor = await subirReceptor([f.ana.digitos, f.bruno.digitos]);
  try {
    await entrar(page, f.email);

    await test.step("1 · liga o lembrete e a chave 'Pedir confirmação no lembrete' pela tela", async () => {
      await page.goto("/app/settings/tenant/agenda");
      await esperarTela(page, "tipos-de-agendamento-config", 30_000);
      const linha = page.getByTestId("lista-de-tipos").getByRole("listitem").filter({ hasText: f.nomeDoTipo });
      await expect(linha).toBeVisible({ timeout: 20_000 });
      await expect(linha.getByTestId(`lembrete-ligado-${f.tipo}`), "o tipo nasceu com o lembrete ligado").toHaveCount(0);

      await linha.getByTestId(`editar-${f.tipo}`).click();
      const chave = linha.getByTestId(`editar-lembrete-confirmacao-${f.tipo}`);
      await expect(chave, "a chave vale só com o lembrete ligado").toBeDisabled({ timeout: 15_000 });
      await linha.getByTestId(`editar-lembrete-${f.tipo}`).check();
      await linha.getByTestId(`editar-lembrete-minutos-${f.tipo}`).fill("60");
      await chave.check();
      await expect(
        linha.getByTestId(`previa-lembrete-${f.tipo}`),
        "a prévia não termina pedindo SIM — o paciente não saberia o que responder",
      ).toContainText(FRASE_PEDIDO_DE_CONFIRMACAO);
      await linha.getByTestId(`salvar-${f.tipo}`).click();

      await expect(linha.getByTestId(`lembrete-ligado-${f.tipo}`)).toContainText("pede confirmação", { timeout: 20_000 });
      const { data: tipo } = await db
        .from("calendar_event_types")
        .select("reminder_enabled, reminder_minutes_before, reminder_asks_confirmation")
        .eq("id", f.tipo)
        .single();
      expect(tipo, "a tela disse que ligou e o banco não gravou").toMatchObject({
        reminder_enabled: true,
        reminder_minutes_before: 60,
        reminder_asks_confirmation: true,
      });
      await evidencia(page, info, "1-chave-ligada");
    });

    await test.step("2 · o cron manda o lembrete, e o que chegou ao WhatsApp pede SIM", async () => {
      const cron = await page.request.post("/api/v1/cron/agenda-reminder", {
        headers: { authorization: `Bearer ${segredoDoCron()}` },
      });
      const corpo = await cron.text();
      expect(cron.status(), corpo).toBe(200);

      const paraAna = receptor.envios.filter((e) => e.chatId.startsWith(f.ana.digitos));
      expect(paraAna, `o lembrete da Ana não chegou ao receptor (cron: ${corpo})`).toHaveLength(1);
      expect(paraAna[0]!.text.trimEnd().endsWith(FRASE_PEDIDO_DE_CONFIRMACAO), paraAna[0]!.text).toBe(true);
      expect(
        receptor.envios.filter((e) => e.chatId.startsWith(f.bruno.digitos)),
        "o lembrete do Bruno (daqui a 3 h, degrau de 60 min) saiu antes da hora",
      ).toHaveLength(0);

      // O carimbo que liga o SIM ao compromisso, numa mensagem que SAIU.
      const { data: lembrete } = await db
        .from("messages")
        .select("status, conversation_id, metadata")
        .eq("organization_id", f.org)
        .eq("contact_id", f.ana.contato)
        .eq("direction", "outbound")
        .maybeSingle();
      expect(lembrete?.status, "o lembrete não ficou como enviado").toBe("sent");
      // A resposta só confirma se cair na MESMA conversa do lembrete.
      expect(lembrete?.conversation_id).toBe(f.ana.conversa);
      expect((lembrete?.metadata as { agenda_lembrete?: unknown } | null)?.agenda_lembrete).toMatchObject({
        appointment_id: f.lembrado,
        revision: 1,
      });
    });

    await test.step("3 · antes da resposta, o cartão diz 'Lembrete sem resposta'", async () => {
      const cartao = await cartaoNaGrade(page, f.lembrado);
      await expect(page.getByTestId(`lembrete-sem-resposta-${f.lembrado}`)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId(`lembrete-sem-resposta-${f.lembrado}`)).toHaveAttribute(
        "aria-label",
        "Lembrete sem resposta",
      );
      await expect(page.getByTestId(`presenca-confirmada-${f.lembrado}`)).toHaveCount(0);
      expect(await cartao.getAttribute("aria-label")).toContain("lembrete sem resposta");
      await expect(page.getByTestId("legenda-da-grade")).toContainText("Lembrete sem resposta");
      await evidencia(page, info, "2-lembrete-sem-resposta");
    });

    await test.step("4 · o paciente responde SIM pelo WhatsApp", async () => {
      const r = await page.request.post(`/api/v1/webhooks/waha/${f.webhookToken}`, {
        data: {
          event: "message",
          session: f.sessao,
          payload: {
            id: `e2e-confirma-${randomUUID()}`,
            from: `${f.ana.digitos}@c.us`,
            fromMe: false,
            body: "SIM",
            timestamp: Math.floor(Date.now() / 1000),
            _data: { notifyName: "Ana Confirma Teste" },
          },
        },
      });
      expect(r.status(), `o webhook precisa ACEITAR: ${await r.text()}`).toBe(200);
      await expect
        .poll(
          async () => {
            const { data } = await db
              .from("calendar_appointments")
              .select("patient_confirmed_source")
              .eq("id", f.lembrado)
              .single();
            return (data as { patient_confirmed_source: string | null } | null)?.patient_confirmed_source ?? null;
          },
          { timeout: 30_000, message: "o SIM chegou e o CRM não leu a confirmação" },
        )
        .toBe("mensagem");
    });

    await test.step("5 · o cartão mostra a presença confirmada, e o painel diz 'pelo WhatsApp'", async () => {
      const cartao = await cartaoNaGrade(page, f.lembrado);
      const icone = page.getByTestId(`presenca-confirmada-${f.lembrado}`);
      await expect(icone).toBeVisible({ timeout: 20_000 });
      await expect(icone).toHaveAttribute("aria-label", "Presença confirmada");
      await expect(page.getByTestId(`lembrete-sem-resposta-${f.lembrado}`)).toHaveCount(0);
      await expect(page.getByTestId("legenda-da-grade")).toContainText("Presença confirmada");

      await cartao.click();
      const painel = page.getByTestId("painel-do-compromisso");
      await expect(painel.getByTestId("estado-do-compromisso")).toHaveText("Agendado", { timeout: 20_000 });
      await expect(painel.getByTestId("presenca-confirmada")).toContainText("Presença confirmada · pelo WhatsApp em");
      await expect(painel.getByTestId("acao-paciente-confirmou"), "já confirmado não oferece o botão").toHaveCount(0);
      await evidencia(page, info, "3-presenca-pelo-whatsapp");
    });

    await test.step("6 · noutro compromisso, a recepção marca 'Paciente confirmou'", async () => {
      await page.goto(`/app/agenda?compromisso=${f.porTelefone}`);
      const painel = page.getByTestId("painel-do-compromisso");
      await expect(painel.getByTestId("estado-do-compromisso")).toHaveText("Agendado", { timeout: 30_000 });
      await expect(painel.getByTestId("presenca-confirmada")).toHaveCount(0);
      const botao = painel.getByTestId("acao-paciente-confirmou");
      await expect(botao, "o botão nasceu desabilitado — controle decorativo").toBeEnabled({ timeout: 15_000 });

      const patch = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/v1/agenda/agendamentos" && r.request().method() === "PATCH",
      );
      await botao.click();
      const resposta = await patch;
      expect(resposta.status(), await resposta.text()).toBe(200);
      expect(resposta.request().postDataJSON(), "o pedido leva só o necessário").toEqual({
        id: f.porTelefone,
        revision: 1,
        patient_confirmed: true,
      });
      await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Presença confirmada" })).toBeVisible({
        timeout: 15_000,
      });
      // Sem `reload()`: a mutação invalida `["agenda"]` e o painel relê.
      await expect(painel.getByTestId("presenca-confirmada")).toContainText("pela equipe", { timeout: 20_000 });
      await expect(botao).toHaveCount(0);

      const { data } = await db
        .from("calendar_appointments")
        .select("patient_confirmed_source, patient_confirmed_user_id")
        .eq("id", f.porTelefone)
        .single();
      expect(data).toEqual({ patient_confirmed_source: "equipe", patient_confirmed_user_id: f.usuario });
      await evidencia(page, info, "4-paciente-confirmou-pela-equipe");
    });
  } finally {
    await receptor.fechar();
  }
});
