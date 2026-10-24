/**
 * O bônus da equipe pela tela, como a clínica usaria (nomes fictícios):
 * o dono liga o programa e escolhe os participantes; a fila do dia é montada
 * pela mesma função do cron; a participante abre "Meu bônus", vê o paciente
 * para ligar, registra a ligação e vê o contador subir; quem não aprova não
 * enxerga a configuração; e, se o aprovador sai da equipe, o dono vê o aviso e
 * assume a função pela tela. Medido por ferramenta, não a olho.
 *
 * Quem liga o programa é o dono da organização (`organizations.created_by`) ou
 * um platform admin pleno. O seed cria a org sem dono e o `e2e-admin` não é
 * platform admin: o `beforeAll` grava o `e2e-admin` como dono (só se estiver
 * vazio) e o `afterAll` desfaz.
 */
import { randomInt, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "bonus-da-equipe");
const creds = lerCreds();
const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function entrarComo(page: Page, chave: "agent" | "manager"): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.locator("#email").fill(creds.users[chave]!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/);
}

async function idDe(email: string): Promise<string> {
  const { data } = await admin().auth.admin.listUsers({ perPage: 200 });
  return data.users.find((u) => u.email === email)!.id;
}

test.describe.serial("bônus da equipe", () => {
  test.describe.configure({ timeout: 120_000 });

  let org: string;
  let dono: string;
  let agente: string;
  let gerente: string;
  let donoGravadoAqui = false;
  let contato: string | null = null;
  let consulta: string | null = null;
  let quemSaiu: string | null = null;
  const sufixo = randomInt(1000, 9999);
  const paciente = `Paciente Ficticio Bonus ${sufixo}`;

  test.beforeAll(async () => {
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    dono = await idDe(creds.users.admin!.email);
    agente = await idDe(creds.users.agent!.email);
    gerente = await idDe(creds.users.manager!.email);
    const { data: o } = await admin().from("organizations").select("id").eq("slug", "e2e-test-org").single();
    org = (o as { id: string }).id;
    await admin().from("bonus_programas").delete().eq("organization_id", org);
    const { data: gravou } = await admin()
      .from("organizations")
      .update({ created_by: dono })
      .eq("id", org)
      .is("created_by", null)
      .select("id");
    donoGravadoAqui = (gravou ?? []).length > 0;
  });

  test.afterAll(async () => {
    const db = admin();
    await db.from("bonus_programas").delete().eq("organization_id", org);
    if (consulta) await db.from("calendar_appointments").delete().eq("id", consulta);
    if (contato) await db.from("contacts").delete().eq("id", contato);
    if (quemSaiu) await db.auth.admin.deleteUser(quemSaiu);
    if (donoGravadoAqui) await db.from("organizations").update({ created_by: null }).eq("id", org).eq("created_by", dono);
  });

  test("o dono liga o programa e escolhe os participantes", async ({ page }) => {
    await loginComoAdmin(page, creds);
    await page.goto("/app/analise/bonus");
    await page.getByRole("button", { name: "Ligar o programa" }).click();
    await page.getByRole("tab", { name: "Configuração" }).click();
    await page.getByLabel("E2E Agent").check();
    await page.getByLabel("E2E Manager").check();
    await page.getByLabel("Tarefas, valor cheio (R$)").fill("200");
    await page.getByRole("button", { name: "Salvar configuração" }).click();
    await expect(page.getByText("Configuração salva.")).toBeVisible();

    const { data } = await admin().from("bonus_programas").select("aprovador_user_id, regras").eq("organization_id", org).single();
    const p = data as { aprovador_user_id: string; regras: { participantes: string[]; tarefas: { valor_cents: number } } };
    expect(p.aprovador_user_id).toBe(dono);
    expect([...p.regras.participantes].sort()).toEqual([agente, gerente].sort());
    expect(p.regras.tarefas.valor_cents).toBe(20_000);
    await page.screenshot({ path: path.join(EVIDENCIA, "1-configuracao.png"), fullPage: true });
  });

  test("a fila do dia nasce e a participante registra a ligação", async ({ page }) => {
    // Um paciente que faltou há pouco, para a fila de ligações; nome fictício,
    // telefone com sufixo aleatório (uniq_contacts_org_phone num segundo run).
    const { data: c, error: erroContato } = await admin()
      .from("contacts")
      .insert({ organization_id: org, name: paciente, display_name: paciente, phone_number: `+55279${randomInt(10_000_000, 99_999_999)}` })
      .select("id")
      .single();
    expect(erroContato).toBeNull();
    contato = (c as { id: string }).id;
    // Falta de duas horas atrás: a fila põe faltas primeiro, a mais recente antes.
    const inicio = new Date(Date.now() - 2 * 3_600_000);
    const { data: a, error: erroConsulta } = await admin()
      .from("calendar_appointments")
      .insert({
        organization_id: org,
        contact_id: contato,
        title: "Consulta de teste",
        starts_at: inicio.toISOString(),
        ends_at: new Date(inicio.getTime() + 3_600_000).toISOString(),
        status: "no_show",
      })
      .select("id")
      .single();
    expect(erroConsulta).toBeNull();
    consulta = (a as { id: string }).id;

    // A fila é montada pela própria função (o cron só decide a hora); dia de hoje no fuso da org.
    const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    await admin().from("bonus_fila_itens").delete().eq("organization_id", org).eq("dia", hoje);
    const { error } = await admin().rpc("fn_bonus_montar_fila", {
      // Só a participante do teste: o rodízio não decide o caso.
      p_org: org,
      p_dia: hoje,
      p_agora: new Date().toISOString(),
      p_participantes: [agente],
      p_leads_por_pessoa: 30,
      p_ligacoes_por_pessoa: 5,
      p_fila: {},
    });
    expect(error).toBeNull();

    await entrarComo(page, "agent");
    await page.goto("/app/analise/bonus");
    const meu = page.getByTestId("meu-bonus");
    await expect(meu).toBeVisible();
    // Não vê a configuração nem a equipe.
    await expect(page.getByRole("tab", { name: "Configuração" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Bônus da equipe" })).toHaveCount(0);

    const item = page.getByTestId("item-ligacao").filter({ hasText: paciente });
    const contador = meu.getByRole("heading", { name: /Pacientes para ligar/ });
    const antes = Number((await contador.textContent())!.match(/(\d+)\/\d+/)![1]);
    await item.getByRole("button", { name: "Registrar ligação" }).click();
    const dialogo = page.getByRole("dialog");
    await expect(dialogo).toBeVisible();
    expect((await dialogo.boundingBox())!.height).toBeGreaterThan(0);
    await page.getByRole("radio", { name: "Atendeu", exact: true }).click();
    await page.getByLabel("Resumo curto").fill("Remarcou para a semana que vem");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(item.getByText("Atendeu", { exact: true })).toBeVisible();
    await expect(contador).toContainText(`${antes + 1}/`);
    const caixa = await item.boundingBox();
    expect(caixa!.width).toBeGreaterThan(200);
    await page.screenshot({ path: path.join(EVIDENCIA, "2-meu-bonus.png"), fullPage: true });
  });

  test("a API recusa a configuração a quem não aprova", async ({ page }) => {
    await entrarComo(page, "manager");
    const r = await page.request.put("/api/v1/bonus/programa", { data: { aprovador_user_id: gerente } });
    expect(r.status()).toBe(403);
    const g = await page.request.get("/api/v1/bonus/programa");
    expect((await g.json()).data.programa).toBeNull();
  });

  test("o aprovador sai da equipe e o dono assume pela tela", async ({ page }) => {
    // Uma pessoa fictícia que aprovava e saiu: vínculo revogado na organização.
    const { data: u, error: erroUsuario } = await admin().auth.admin.createUser({
      email: `bonus-saiu-${randomUUID()}@invariant.test`,
      password: `Local-${randomUUID()}!`,
      email_confirm: true,
    });
    expect(erroUsuario).toBeNull();
    quemSaiu = u.user!.id;
    const agora = new Date().toISOString();
    const vinculo = await admin()
      .from("user_organizations")
      .insert({ organization_id: org, user_id: quemSaiu, role: "agent", accepted_at: agora, revoked_at: agora });
    expect(vinculo.error).toBeNull();
    const troca = await admin().from("bonus_programas").update({ aprovador_user_id: quemSaiu }).eq("organization_id", org);
    expect(troca.error).toBeNull();

    await page.context().clearCookies();
    await loginComoAdmin(page, creds);
    await page.goto("/app/analise/bonus");
    const aviso = page.getByTestId("aprovador-fora-da-equipe");
    await expect(aviso).toContainText("Quem aprova o bônus não faz mais parte da equipe.");
    await expect(page.getByRole("tab", { name: "Configuração" })).toHaveCount(0);
    await page.screenshot({ path: path.join(EVIDENCIA, "3-aprovador-saiu.png"), fullPage: true });

    await aviso.getByRole("button", { name: "Assumir aprovação" }).click();
    await expect(aviso).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Configuração" })).toBeVisible();
    const { data } = await admin().from("bonus_programas").select("aprovador_user_id").eq("organization_id", org).single();
    expect((data as { aprovador_user_id: string }).aprovador_user_id).toBe(dono);
    await page.screenshot({ path: path.join(EVIDENCIA, "4-aprovacao-assumida.png"), fullPage: true });
  });
});
