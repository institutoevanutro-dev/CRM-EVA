import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { test, expect } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

/**
 * O PRESTADOR DE SERVIÇO PUBLICA A JORNADA PELA TELA.
 *
 * ═══ O defeito ═══════════════════════════════════════════════════════════════
 * Medido em produção (05/10/2026): um `provider` aceito (o fisioterapeuta de
 * uma clínica) não aparecia em Equipe › Atendimento. A lista vinha do roster de
 * ROTEAMENTO (agent+), e essa lista é a única porta da tela para gravar
 * `attendant_availability.schedule` — que a Agenda lê para oferecer horário.
 * O tipo de agendamento aceitava o prestador como "Quem atende", mas a jornada
 * dele só se gravava pela API, à mão.
 *
 * ═══ O que esta spec prova pela tela ═════════════════════════════════════════
 * O gerente vê o prestador marcado "Só agenda", SEM a chave de plantão (ele não
 * recebe conversa), abre o editor, publica uma janela numa unidade e salva — e a
 * linha do banco guarda a janela com a unidade.
 */
const RAIZ = path.resolve(__dirname, "../..");
const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

test.describe.configure({ timeout: 120_000 });

interface Creds {
  password: string;
  users: Record<string, { id: string; email: string } | undefined>;
}
function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  return JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
}

const sufixo = randomUUID().slice(0, 8);
const nomePrestador = `Fisio ${sufixo}`;
const nomeUnidade = `Unidade ${sufixo}`;
let prestadorId = "";
let unidadeId = "";
let orgId = "";

test.beforeAll(async () => {
  const creds = lerCreds();
  const gerente = creds.users.manager;
  if (!gerente) throw new Error(".e2e-creds.json sem o usuário `manager`");
  const { data: m, error: mErr } = await db
    .from("user_organizations")
    .select("organization_id")
    .eq("user_id", gerente.id)
    .is("revoked_at", null)
    .limit(1)
    .single();
  if (mErr) throw mErr;
  orgId = (m as { organization_id: string }).organization_id;

  const { data: u, error: uErr } = await db.auth.admin.createUser({
    email: `prestador-${sufixo}@deskcomm.test`,
    password: `Local-${randomUUID()}!`,
    email_confirm: true,
    user_metadata: { full_name: nomePrestador },
  });
  if (uErr || !u.user) throw uErr;
  prestadorId = u.user.id;
  const { error: pErr } = await db
    .from("user_organizations")
    .insert({ user_id: prestadorId, organization_id: orgId, role: "provider" });
  if (pErr) throw pErr;

  const { data: un, error: unErr } = await db
    .from("calendar_units")
    .insert({ organization_id: orgId, name: nomeUnidade })
    .select("id")
    .single();
  if (unErr) throw unErr;
  unidadeId = (un as { id: string }).id;
});

test.afterAll(async () => {
  if (prestadorId) {
    await db.from("attendant_availability").delete().eq("organization_id", orgId).eq("user_id", prestadorId);
    await db.from("user_organizations").delete().eq("organization_id", orgId).eq("user_id", prestadorId);
    await db.auth.admin.deleteUser(prestadorId);
  }
  if (unidadeId) await db.from("calendar_units").delete().eq("id", unidadeId);
});

test("o gerente publica a jornada do prestador numa unidade, sem pô-lo no roteamento", async ({ page }) => {
  const creds = lerCreds();
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(creds.users.manager!.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });

  await page.goto("/app/team?aba=atendimento");
  const linha = page.getByRole("row").filter({ hasText: nomePrestador });
  await expect(linha, "o prestador não aparece na tela de jornada — é o defeito").toBeVisible({
    timeout: 20_000,
  });
  await expect(linha).toContainText("Só agenda");
  await expect(linha).toContainText("Fora do roteamento");
  await expect(linha).toContainText("Não publicado");
  await expect(
    linha.getByRole("switch"),
    "prestador não recebe conversa: a chave de plantão não pode existir na linha dele",
  ).toHaveCount(0);

  await linha.getByRole("button", { name: `Editar horário de ${nomePrestador}` }).click();
  const dialogo = page.getByRole("dialog");
  await dialogo.getByRole("button", { name: /Adicionar janela/ }).click();
  await dialogo.getByRole("combobox", { name: "Unidade" }).click();
  await page.getByRole("option", { name: nomeUnidade }).click();
  await page.screenshot({ path: "evidence/equipe/prestador-editor-jornada.png", fullPage: true });
  await dialogo.getByRole("button", { name: "Salvar" }).click();
  await expect(dialogo).toBeHidden({ timeout: 10_000 });

  await expect(linha, "o resumo da jornada não atualizou depois de salvar").toContainText("08:00–18:00", {
    timeout: 10_000,
  });

  const { data: linhaDb, error } = await db
    .from("attendant_availability")
    .select("is_available, schedule")
    .eq("organization_id", orgId)
    .eq("user_id", prestadorId)
    .single();
  if (error) throw error;
  const salvo = linhaDb as { is_available: boolean; schedule: { windows: Array<Record<string, unknown>> } };
  expect(salvo.schedule.windows).toEqual([{ dow: 1, start: "08:00", end: "18:00", unit_id: unidadeId }]);
  expect(salvo.is_available, "salvar a jornada não pode ligar o plantão do prestador").toBe(false);

  await page.screenshot({ path: "evidence/equipe/prestador-jornada-publicada.png", fullPage: true });
});
