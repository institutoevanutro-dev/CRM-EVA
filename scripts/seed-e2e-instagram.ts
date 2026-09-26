/**
 * Seed do canal Instagram para os e2e `tests/e2e/instagram-receber.spec.ts` e
 * `tests/e2e/instagram-responder.spec.ts` (este usa também as três conversas
 * dos passos 5 e 6: Instagram recente, Instagram de 8 dias e uma de WhatsApp) e
 * `tests/e2e/instagram-contato-unico.spec.ts` (passo 7: segundo perfil
 * conectado, contato com WhatsApp e Instagram, par de mesmo @ e par de mesmo
 * nome Instagram × WhatsApp).
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
 * Idempotente. RECUSA escrever fora de localhost — mesma guarda de
 * `seed-automacoes-e-followups.ts` (`destinoEhLocal`): este seed grava um App
 * Secret e um token de canal cifrados numa organização real, e "escrevendo em
 * REMOTO" no `console.warn` de `anunciarDestino` é fácil de rolar batido num
 * terminal cheio. Sem `--permitir-remoto`, roda só em localhost.
 *
 * Run: npx tsx scripts/seed-e2e-instagram.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { definirOrigemPadrao, salvarConexaoDoInstagram } from "../lib/channels/instagram/conexao";
import { encryptWebhookSecret } from "../lib/webhooks/secrets";
import { anunciarDestino, credenciaisSupabaseDeTeste, destinoEhLocal } from "./lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

export const APP_SECRET = "segredo-e2e";
export const IG_ACCOUNT_ID = "17841400000000001";
export const IG_USERNAME = "clinica_e2e";
export const ORIGEM_CAMPO = "origem";
export const ORIGEM_VALOR = "Instagram Dr. André";

// Fixtures de `tests/e2e/instagram-responder.spec.ts`. O prefixo comum é o que
// a spec digita na busca do Inbox para isolar as três conversas das demais do
// banco; o IGSID é o destinatário que o receptor local tem de ver no envio.
export const PREFIXO_RESPONDER = "IgResp";
export const IGSID_RECENTE = "IGSID-E2E-RESPONDER-RECENTE";
export const IGSID_ANTIGO = "IGSID-E2E-RESPONDER-ANTIGO";
export const NOME_IG_RECENTE = `${PREFIXO_RESPONDER} Recente`;
export const NOME_IG_ANTIGO = `${PREFIXO_RESPONDER} Antigo`;
export const NOME_WHATSAPP = `${PREFIXO_RESPONDER} WhatsApp`;
const SESSAO_WHATSAPP = "e2e-instagram-filtro-whatsapp";

// Fixtures de `tests/e2e/instagram-contato-unico.spec.ts` (passo 7).
export const IG_ACCOUNT_ID_2 = "17841400000000002";
export const IG_USERNAME_2 = "clinica_e2e_2";
export const NOME_CANAIS = "IgUnico Canais";
export const HANDLE_CANAIS = "igunico_canais";
const IGSID_CANAIS = "IGSID-E2E-UNICO-CANAIS";
const TELEFONE_CANAIS = "+5511988880701";
export const NOME_ARROBA = "IgUnico Arroba";
// O mesmo @ com grafias diferentes: a junção compara sem maiúsculas.
const ARROBA_NO_PERFIL_1 = { igsid: "IGSID-E2E-UNICO-ARROBA-1", handle: "igunico_arroba" };
const ARROBA_NO_PERFIL_2 = { igsid: "IGSID-E2E-UNICO-ARROBA-2", handle: "IgUnico_Arroba" };
export const NOME_PAR = "IgUnico Maria Par";
const IGSID_PAR = "IGSID-E2E-UNICO-PAR";
const TELEFONE_PAR = "+5511988880702";

interface Creds {
  org_id: string;
  users: Record<string, { id: string }>;
}

async function main(): Promise<void> {
  const credenciais = credenciaisSupabaseDeTeste();
  anunciarDestino("seed-e2e-instagram", credenciais);

  // Só a URL decide: este script fala apenas com a API do Supabase (admin
  // client) e nunca abre `pg.Pool`, então o `dbUrl` não é destino dele.
  if (!destinoEhLocal(credenciais.url) && !process.argv.includes("--permitir-remoto")) {
    console.error(
      `[seed-e2e-instagram] recusado: ${credenciais.url} não é local, e este seed grava um App ` +
        "Secret e um token de canal cifrados numa organização real. Para gravar mesmo assim, " +
        "rode de novo com --permitir-remoto.",
    );
    process.exit(2);
  }

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

  // 5 · Conversas para responder (etapa 2). Contato e conversa do Instagram
  // pelos MESMOS RPCs da ingestão (`lib/channels/instagram/ingest.ts`); o
  // IGSID em `provider_conversation_id` é o que o envio usa (migration 0278).
  // `last_inbound_at` é regravado a cada rodada: a recente precisa estar
  // dentro das 24h, a antiga passou dos 7 dias da Meta.
  const sessaoId = (sessao as { id: string }).id;
  const DIA = 24 * 60 * 60 * 1000;
  for (const [igsid, nome, idade] of [
    [IGSID_RECENTE, NOME_IG_RECENTE, 10 * 60 * 1000],
    [IGSID_ANTIGO, NOME_IG_ANTIGO, 8 * DIA],
  ] as const) {
    const { data: linhas, error: erroContato } = await admin.rpc("fn_upsert_contato_por_identidade" as never, {
      p_org: orgId, p_canal: "instagram", p_external_id: igsid, p_handle: null, p_nome: nome, p_avatar: null,
    } as never);
    const contatoId = (linhas as { contact_id: string }[] | null)?.[0]?.contact_id;
    if (erroContato || !contatoId) throw new Error(`contato ${nome}: ${erroContato?.message ?? "sem id"}`);
    await conversaComUltimaEntrada(admin, orgId, contatoId, sessaoId, "instagram", {
      provider_conversation_id: igsid,
      em: new Date(Date.now() - idade).toISOString(),
      preview: `Oi, sou ${nome}`,
    });
  }

  // 6 · Uma conversa de WhatsApp, para o filtro "Só WhatsApp" ter o que
  // mostrar num banco fresco. Sessão WAHA própria (mesmo formato de
  // `seed-e2e-queue.ts`), sem depender da ordem de outros seeds.
  let { data: sessaoWa } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("waha_session_name", SESSAO_WHATSAPP)
    .maybeSingle();
  if (!sessaoWa) {
    const { data, error } = await admin
      .from("channel_sessions")
      .insert({
        organization_id: orgId,
        waha_session_name: SESSAO_WHATSAPP,
        display_name: "Número Filtro E2E",
        webhook_secret_encrypted: "\\x00",
      } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`sessão de WhatsApp: ${error?.message}`);
    sessaoWa = data;
  }
  let { data: contatoWa } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("display_name", NOME_WHATSAPP)
    .maybeSingle();
  if (!contatoWa) {
    const { data, error } = await admin
      .from("contacts")
      .insert({ organization_id: orgId, display_name: NOME_WHATSAPP } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`contato de WhatsApp: ${error?.message}`);
    contatoWa = data;
  }
  await conversaComUltimaEntrada(
    admin,
    orgId,
    (contatoWa as { id: string }).id,
    (sessaoWa as { id: string }).id,
    "whatsapp",
    { provider_conversation_id: null, em: new Date().toISOString(), preview: `Oi, sou ${NOME_WHATSAPP}` },
  );
  console.log("[seed] conversas de responder: Instagram recente, Instagram de 8 dias, WhatsApp");

  await semearContatoUnico(admin, {
    orgId,
    managerId,
    sessaoIg1: sessaoId,
    sessaoWa: (sessaoWa as { id: string }).id,
  });

  console.log("\n✅ Seed do Instagram completo.");
  console.log(`org: ${orgId} · conta: ${IG_USERNAME} (${IG_ACCOUNT_ID})`);
}

async function contatoPorIdentidade(
  admin: SupabaseClient,
  orgId: string,
  i: { igsid: string; handle: string | null; nome: string },
): Promise<string> {
  const { data, error } = await admin.rpc("fn_upsert_contato_por_identidade" as never, {
    p_org: orgId, p_canal: "instagram", p_external_id: i.igsid, p_handle: i.handle, p_nome: i.nome, p_avatar: null,
  } as never);
  const contatoId = (data as { contact_id: string }[] | null)?.[0]?.contact_id;
  if (error || !contatoId) throw new Error(`contato ${i.nome}: ${error?.message ?? "sem id"}`);
  return contatoId;
}

/**
 * 7 · Contato único (etapa 3). Idempotente INCLUSIVE depois da junção: a spec
 * dispara o cron que junta o par de mesmo @, e a rodada seguinte precisa achar
 * o par separado de novo. Quando a identidade do segundo perfil já aponta para
 * o principal, o seed devolve a ela (e à conversa dela) um contato próprio,
 * mais novo — o principal continua o mesmo, e o cadastro absorvido na rodada
 * anterior fica como lápide, fora da lista.
 */
async function semearContatoUnico(
  admin: SupabaseClient,
  s: { orgId: string; managerId: string; sessaoIg1: string; sessaoWa: string },
): Promise<void> {
  const { orgId } = s;
  const agora = new Date().toISOString();

  // Segundo perfil da clínica conectado: é por ele que o mesmo @ ganha outro IGSID.
  const tokenCifrado = await encryptWebhookSecret(admin, "token-e2e-instagram-2");
  if (!tokenCifrado) throw new Error("cifra do token do segundo perfil indisponível");
  const conexao = await salvarConexaoDoInstagram(admin, {
    organizationId: orgId,
    igAccountId: IG_ACCOUNT_ID_2,
    username: IG_USERNAME_2,
    tokenCifrado,
    expiraEm: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
    userId: s.managerId,
  });
  if (conexao.status === "conta_em_outra_organizacao") {
    throw new Error(`a conta ${IG_ACCOUNT_ID_2} já está ativa em outra organização`);
  }
  const { data: sessao2, error: erroSessao2 } = await admin
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", orgId)
    .eq("ig_account_id", IG_ACCOUNT_ID_2)
    .is("archived_at", null)
    .maybeSingle();
  if (erroSessao2 || !sessao2) throw new Error(`segundo perfil: ${erroSessao2?.message ?? "não encontrado"}`);
  const sessaoIg2 = (sessao2 as { id: string }).id;

  // Um contato, duas conversas: WhatsApp (telefone) e Instagram (@).
  const canais = await contatoPorIdentidade(admin, orgId, { igsid: IGSID_CANAIS, handle: HANDLE_CANAIS, nome: NOME_CANAIS });
  const { error: erroTelefone } = await admin
    .from("contacts")
    .update({ phone_number: TELEFONE_CANAIS } as never)
    .eq("organization_id", orgId)
    .eq("id", canais);
  if (erroTelefone) throw new Error(`telefone de ${NOME_CANAIS}: ${erroTelefone.message}`);
  await conversaComUltimaEntrada(admin, orgId, canais, s.sessaoIg1, "instagram", {
    provider_conversation_id: IGSID_CANAIS, em: agora, preview: `Oi pelo Instagram, sou ${NOME_CANAIS}`,
  });
  await conversaComUltimaEntrada(admin, orgId, canais, s.sessaoWa, "whatsapp", {
    provider_conversation_id: null, em: agora, preview: `Oi pelo WhatsApp, sou ${NOME_CANAIS}`,
  });

  // Mesmo @ nos dois perfis: dois contatos até a rodada diária juntar.
  const principal = await contatoPorIdentidade(admin, orgId, { ...ARROBA_NO_PERFIL_1, nome: NOME_ARROBA });
  let segundo = await contatoPorIdentidade(admin, orgId, { ...ARROBA_NO_PERFIL_2, nome: NOME_ARROBA });
  if (segundo === principal) {
    const { data, error } = await admin
      .from("contacts")
      .insert({ organization_id: orgId, source: "instagram", display_name: NOME_ARROBA } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`separar o par de mesmo @: ${error?.message}`);
    segundo = (data as { id: string }).id;
    const { error: erroIdentidade } = await admin
      .from("contact_channel_identities")
      .update({ contact_id: segundo } as never)
      .eq("organization_id", orgId)
      .eq("channel", "instagram")
      .eq("external_id", ARROBA_NO_PERFIL_2.igsid);
    if (erroIdentidade) throw new Error(`separar o par de mesmo @: ${erroIdentidade.message}`);
    const { error: erroConversa } = await admin
      .from("conversations")
      .update({ contact_id: segundo } as never)
      .eq("organization_id", orgId)
      .eq("contact_id", principal)
      .eq("channel_session_id", sessaoIg2);
    if (erroConversa) throw new Error(`separar o par de mesmo @: ${erroConversa.message}`);
  }
  await conversaComUltimaEntrada(admin, orgId, principal, s.sessaoIg1, "instagram", {
    provider_conversation_id: ARROBA_NO_PERFIL_1.igsid, em: agora, preview: `Oi perfil 1, sou ${NOME_ARROBA}`,
  });
  await conversaComUltimaEntrada(admin, orgId, segundo, sessaoIg2, "instagram", {
    provider_conversation_id: ARROBA_NO_PERFIL_2.igsid, em: agora, preview: `Oi perfil 2, sou ${NOME_ARROBA}`,
  });

  // Mesmo nome, um só no Instagram (sem telefone) e outro no WhatsApp.
  await contatoPorIdentidade(admin, orgId, { igsid: IGSID_PAR, handle: null, nome: NOME_PAR });
  const { data: parWa } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("phone_number", TELEFONE_PAR)
    .is("is_merged_into", null)
    .maybeSingle();
  if (!parWa) {
    const { error } = await admin
      .from("contacts")
      .insert({ organization_id: orgId, display_name: NOME_PAR, phone_number: TELEFONE_PAR } as never);
    if (error) throw new Error(`contato de WhatsApp ${NOME_PAR}: ${error.message}`);
  }
  console.log("[seed] contato único: segundo perfil, contato com dois canais, par de mesmo @, par de mesmo nome");
}

async function conversaComUltimaEntrada(
  admin: SupabaseClient,
  orgId: string,
  contatoId: string,
  sessaoId: string,
  canal: "instagram" | "whatsapp",
  c: { provider_conversation_id: string | null; em: string; preview: string },
): Promise<void> {
  const { data: conversaId, error } = await admin.rpc("fn_upsert_conversa_de_canal" as never, {
    p_org: orgId, p_contact: contatoId, p_session: sessaoId, p_canal: canal,
  } as never);
  if (error || !conversaId) throw new Error(`conversa ${c.preview}: ${error?.message ?? "sem id"}`);
  const { error: erroUpdate } = await admin
    .from("conversations")
    .update({
      provider_conversation_id: c.provider_conversation_id,
      status: "open",
      last_inbound_at: c.em,
      last_message_at: c.em,
      last_message_preview: c.preview,
    } as never)
    .eq("organization_id", orgId)
    .eq("id", conversaId as string);
  if (erroUpdate) throw new Error(`conversa ${c.preview}: ${erroUpdate.message}`);
}

// Só roda quando executado. As specs IMPORTAM as constantes daqui, e rodar o
// seed no import derrubava o runner inteiro (`process.exit(1)`) em banco
// fresco, antes de `loadCreds` semear as credenciais.
if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Seed do Instagram falhou:", err);
    process.exit(1);
  });
}
