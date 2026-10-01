/**
 * Seed do e2e `tests/e2e/cadastro-incorporado.spec.ts` (botão Conectar WhatsApp).
 *
 * Grava o App da Meta da instalação com o Cadastro Incorporado LIGADO
 * (`app_id` + `es_config_id`, migration 0296) e o par de segredos cifrado do
 * MESMO jeito que `app/actions/settings/updateMetaApp.ts` grava
 * (`encryptWebhookSecret`). O App Secret em claro vem de `E2E_META_APP_SECRET`
 * (`scripts/gerar-env-e2e.sh`): é com ele que a troca do `code` e o HMAC do
 * webhook se fecham.
 *
 * Arquiva toda sessão `meta_cloud` ativa da org do seed, para cada rodada
 * conectar do zero. Com `--so-arquivar`, faz só isso — é o que o `afterAll` da
 * spec chama, para a sessão oficial conectada não vazar para as specs seguintes
 * da mesma parte (elas compartilham o banco).
 *
 * Com `--adiantar-contatos`, faz só isto: torna devido agora o reprocessamento
 * dos `meta.state_sync` pendentes (o worker os reagenda para daqui a minutos
 * enquanto o histórico não fecha; o e2e não espera esse relógio).
 *
 * Idempotente. RECUSA escrever fora de localhost (mesma guarda de
 * `seed-e2e-instagram.ts`).
 *
 * Run: npx tsx scripts/seed-e2e-cadastro-incorporado.ts [--so-arquivar | --adiantar-contatos]
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { encryptWebhookSecret } from "../lib/webhooks/secrets";
import { anunciarDestino, credenciaisSupabaseDeTeste, destinoEhLocal } from "./lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

export const APP_ID = "e2e-app";
export const ES_CONFIG_ID = "e2e-config";
const VERIFY_TOKEN = "e2e-verify-token-cadastro-incorporado";

async function main(): Promise<void> {
  const credenciais = credenciaisSupabaseDeTeste();
  anunciarDestino("seed-e2e-cadastro-incorporado", credenciais);
  if (!destinoEhLocal(credenciais.url) && !process.argv.includes("--permitir-remoto")) {
    console.error(
      `[seed-e2e-cadastro-incorporado] recusado: ${credenciais.url} não é local, e este seed grava ` +
        "o App Secret da instalação. Para gravar mesmo assim, rode de novo com --permitir-remoto.",
    );
    process.exit(2);
  }
  const admin = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

  if (!fs.existsSync(CREDS_PATH)) {
    throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts` antes");
  }
  const { org_id: orgId } = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as { org_id: string };

  if (process.argv.includes("--adiantar-contatos")) {
    const { error: erroFila } = await admin
      .from("event_log")
      .update({ next_attempt_at: new Date().toISOString() } as never)
      .eq("organization_id", orgId)
      .eq("event_type", "meta.state_sync")
      .eq("status", "pending");
    if (erroFila) throw new Error(`event_log: ${erroFila.message}`);
    return;
  }

  const { data: arquivadas, error: erroArquivo } = await admin
    .from("channel_sessions")
    .update({ archived_at: new Date().toISOString() } as never)
    .eq("organization_id", orgId)
    .eq("provider", "meta_cloud")
    .is("archived_at", null)
    .select("id");
  if (erroArquivo) throw new Error(`channel_sessions: ${erroArquivo.message}`);
  console.info(`[seed] sessões meta_cloud arquivadas: ${(arquivadas ?? []).length}`);
  if (process.argv.includes("--so-arquivar")) return;

  const segredo = process.env.E2E_META_APP_SECRET;
  if (!segredo) throw new Error("E2E_META_APP_SECRET ausente — rode `pnpm e2e:env` (scripts/gerar-env-e2e.sh)");
  const appSecretCifrado = await encryptWebhookSecret(admin, segredo);
  const verifyTokenCifrado = await encryptWebhookSecret(admin, VERIFY_TOKEN);
  if (!appSecretCifrado || !verifyTokenCifrado) {
    throw new Error("cifra indisponível (GUC app.nuvemshop_oauth_key ausente) — semeie private.app_secrets antes");
  }
  const { error } = await admin.from("platform_meta_app").upsert(
    {
      id: 1,
      app_id: APP_ID,
      es_config_id: ES_CONFIG_ID,
      app_secret_encrypted: appSecretCifrado,
      verify_token_encrypted: verifyTokenCifrado,
      verify_token_created_at: new Date().toISOString(),
    } as never,
    { onConflict: "id" },
  );
  if (error) throw new Error(`platform_meta_app: ${error.message}`);
  console.info("[seed] platform_meta_app: app_id, es_config_id e par de segredos gravados");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Seed do Cadastro Incorporado falhou:", err);
    process.exit(1);
  });
}
