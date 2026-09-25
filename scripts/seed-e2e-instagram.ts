/**
 * Seed do canal Instagram para o e2e `tests/e2e/instagram-receber.spec.ts`.
 *
 * Grava o app do Instagram da instalação (App ID + App Secret cifrado — o
 * segredo `"segredo-e2e"` que a spec usa para assinar o HMAC do webhook) e uma
 * conexão `meta_instagram` ATIVA na org do seed de credenciais
 * (`ig_account_id = "17841400000000001"`, `ig_username = "clinica_e2e"`), com a
 * Origem padrão apontando para um campo `select` do funil padrão.
 *
 * Reusa os MESMOS caminhos de produção em vez de inserir linhas cruas:
 * `salvarConexaoDoInstagram`/`definirOrigemPadrao` (o que o callback do OAuth e
 * a tela de Conexões chamam) e `encryptWebhookSecret` (o que
 * `updateMetaApp.ts` chama) — é o que garante que o segredo fica cifrado
 * exatamente do jeito que a tela do admin grava, não um formato inventado
 * pelo seed.
 *
 * Idempotente. Só escreve em localhost (mesma guarda dos outros
 * `scripts/seed-e2e-*.ts`, via `anunciarDestino`/`credenciaisSupabaseDeTeste`).
 *
 * Run: npx tsx scripts/seed-e2e-instagram.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { definirOrigemPadrao, salvarConexaoDoInstagram } from "../lib/channels/instagram/conexao";
import { encryptWebhookSecret } from "../lib/webhooks/secrets";
import { anunciarDestino, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

export const APP_SECRET = "segredo-e2e";
export const IG_ACCOUNT_ID = "17841400000000001";
export const IG_USERNAME = "clinica_e2e";
export const ORIGEM_CAMPO = "origem";
export const ORIGEM_VALOR = "Instagram Dr. André";

interface Creds {
  org_id: string;
  users: Record<string, { id: string }>;
}

async function main(): Promise<void> {
  const credenciais = credenciaisSupabaseDeTeste();
  anunciarDestino("seed-e2e-instagram", credenciais);
  const admin = createClient(credenciais.url, credenciais.serviceRole, {
    auth: { persistSession: false },
  });

  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts` antes");
  }
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  const orgId = creds.org_id;
  const managerId = creds.users.manager?.id;
  if (!managerId) throw new Error("`.e2e-creds.json` sem o usuário `manager`");

  // 1 · App do Instagram da instalação — App Secret cifrado do MESMO jeito que
  // `app/actions/settings/updateMetaApp.ts` grava.
  const appSecretCifrado = await encryptWebhookSecret(admin, APP_SECRET);
  if (!appSecretCifrado) {
    throw new Error(
      "cifra indisponível (GUC app.nuvemshop_oauth_key ausente) — semeie private.app_secrets antes, como o e2e.yml faz",
    );
  }
  const { error: erroApp } = await admin
    .from("platform_meta_app")
    .upsert(
      { id: 1, ig_app_id: "e2e-instagram-app-id", ig_app_secret_encrypted: appSecretCifrado } as never,
      { onConflict: "id" },
    );
  if (erroApp) throw new Error(`platform_meta_app: ${erroApp.message}`);
  console.log("[seed] platform_meta_app.ig_app_id/ig_app_secret_encrypted gravados");

  // 2 · Conexão ativa — pelo MESMO caminho que o callback do OAuth usa
  // (`lib/channels/instagram/oauth.ts` → `salvarConexaoDoInstagram`).
  const tokenCifrado = await encryptWebhookSecret(admin, "token-e2e-instagram");
  if (!tokenCifrado) throw new Error("cifra do token do Instagram indisponível");
  const resultado = await salvarConexaoDoInstagram(admin, {
    organizationId: orgId,
    igAccountId: IG_ACCOUNT_ID,
    username: IG_USERNAME,
    tokenCifrado,
    expiraEm: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    userId: managerId,
  });
  if (resultado.status === "conta_em_outra_organizacao") {
    throw new Error(
      `a conta ${IG_ACCOUNT_ID} já está ativa em outra organização — banco sujo de outra sessão?`,
    );
  }
  console.log(`[seed] channel_session meta_instagram: ${resultado.status}`);

  // 3 · Campo `origem` (select) no funil padrão — a Origem só é aceita se o
  // campo existir entre os `select` do funil (`camposDeListaDoFunilPadrao`).
  const { data: funil, error: erroFunil } = await admin
    .from("crm_pipelines")
    .select("id, settings")
    .eq("organization_id", orgId)
    .eq("is_default", true)
    .eq("is_archived", false)
    .maybeSingle();
  if (erroFunil || !funil) throw new Error(`funil padrão: ${erroFunil?.message ?? "não encontrado"}`);
  const funilRow = funil as { id: string; settings: Record<string, unknown> | null };
  const settings = funilRow.settings ?? {};
  const fields = Array.isArray((settings as { fields?: unknown[] }).fields)
    ? ((settings as { fields: Record<string, unknown>[] }).fields)
    : [];
  const campoOrigem = fields.find((f) => f.key === ORIGEM_CAMPO) as
    | { key: string; label: string; type: string; options?: { value: string; label: string }[] }
    | undefined;
  const opcoes = campoOrigem?.options ?? [];
  const jaTemOpcao = opcoes.some((o) => o.value === ORIGEM_VALOR);
  if (!campoOrigem || !jaTemOpcao) {
    const novoCampo = {
      key: ORIGEM_CAMPO,
      label: "Origem",
      type: "select",
      options: [...opcoes, { value: ORIGEM_VALOR, label: ORIGEM_VALOR }],
    };
    const novosFields = campoOrigem
      ? fields.map((f) => (f.key === ORIGEM_CAMPO ? novoCampo : f))
      : [...fields, novoCampo];
    const { error: erroSettings } = await admin
      .from("crm_pipelines")
      .update({ settings: { ...settings, fields: novosFields } } as never)
      .eq("id", funilRow.id);
    if (erroSettings) throw new Error(`funil settings: ${erroSettings.message}`);
    console.log(`[seed] campo "${ORIGEM_CAMPO}" (select) gravado no funil padrão`);
  } else {
    console.log(`[seed] campo "${ORIGEM_CAMPO}" já existia no funil padrão`);
  }

  // 4 · Origem padrão da conexão — MESMO caminho da tela (PATCH
  // /api/v1/channels/instagram/:id → `definirOrigemPadrao`).
  const { data: sessao, error: erroSessao } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("provider", "meta_instagram")
    .eq("ig_account_id", IG_ACCOUNT_ID)
    .is("archived_at", null)
    .maybeSingle();
  if (erroSessao || !sessao) throw new Error(`sessão do Instagram recém-criada não encontrada: ${erroSessao?.message}`);
  await definirOrigemPadrao(admin, orgId, (sessao as { id: string }).id, {
    campo: ORIGEM_CAMPO,
    valor: ORIGEM_VALOR,
  });
  console.log(`[seed] origem padrão: ${ORIGEM_CAMPO} = "${ORIGEM_VALOR}"`);

  console.log("\n✅ Seed do Instagram completo.");
  console.log(`org: ${orgId} · conta: ${IG_USERNAME} (${IG_ACCOUNT_ID})`);
}

main().catch((err) => {
  console.error("❌ Seed do Instagram falhou:", err);
  process.exit(1);
});
