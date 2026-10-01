import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/official — estado da conexão oficial + o que colar na Meta.
 * POST /api/v1/channels/official — VALIDA a credencial e só então grava.
 *
 * O `POST` valida contra a Graph API **antes** de persistir. Gravar primeiro e
 * descobrir depois é o que faz o operador achar que conectou e só entender que não na
 * primeira mensagem que não sai — com o lead do outro lado esperando.
 *
 * O `POST` é também o caminho de VOLTA: conectar por cima de um canal oficial que
 * foi excluído RESSUSCITA a linha (`lib/channels/reactivate.ts`). Sem isso o
 * update devolvia status/credencial/número e deixava `archived_at` no lugar — e o
 * canal "conectado" ficava invisível para o webhook, para o ingest, para os
 * seletores e para o envio, todos filtrados por essa coluna.
 *
 * Ressuscitar NÃO devolve a URL de webhook antiga: a exclusão rotacionou o
 * `webhook_path_token` de propósito (é o que corta a entrega da plataforma), e a
 * volta mantém a nova. É por isso que a tela mostra o que colar na Meta depois de
 * conectar — inclusive na reconexão, onde o endereço mudou.
 *
 * O token é cifrado pelas MESMAS RPCs do resto do repo (`lib/webhooks/secrets.ts`) e
 * **nunca volta** num GET: uma vez gravado, a tela mostra que existe, não qual é.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { appDaMeta, appDaMetaDoAmbiente } from "@/lib/channels/meta/app";
import { lerCoexistencia } from "@/lib/channels/meta/coexistencia";
import { conectarCanalOficial } from "@/lib/channels/meta/conectar-canal-oficial";
import { graphVersion } from "@/lib/graph-version";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

import { publicBase, traduzirMotivo } from "./route-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  phone_number_id: z.string().min(5),
  waba_id: z.string().min(5),
  token: z.string().min(20),
});

/** O endereço que a Meta chama para ESTA sessão — o mesmo que a tela manda colar. */
function callbackDaSessao(req: NextRequest, webhookPathToken: string): string {
  return `${publicBase(req)}/api/v1/webhooks/meta/${webhookPathToken}`;
}

/**
 * O que a Meta respondeu na última vez que esta sessão assinou o webhook da conta.
 * Guardado em `metadata.webhook_da_conta` para a tela seguir avisando depois do
 * reload: um toast some, e a tela voltaria a parecer saudável com o recebimento morto.
 */
interface AssinaturaGravada {
  assinado: boolean;
  motivo?: string;
  em: string;
}

function assinaturaGravada(metadata: unknown): AssinaturaGravada | null {
  const v = (metadata as { webhook_da_conta?: unknown } | null)?.webhook_da_conta as
    | Partial<AssinaturaGravada>
    | undefined;
  if (!v || typeof v.assinado !== "boolean" || typeof v.em !== "string") return null;
  return { assinado: v.assinado, em: v.em, ...(typeof v.motivo === "string" ? { motivo: v.motivo } : {}) };
}

/**
 * O token de verificação que esta tela pode MOSTRAR — e de onde vem o que vale.
 *
 * Isto lia `process.env.META_WEBHOOK_VERIFY_TOKEN` direto, e a migration 0257
 * tornou a leitura errada nos dois sentidos: com o App da Meta cadastrado pela
 * tela de administração, o handshake passa a conferir o token do BANCO, e esta
 * rota seguia mostrando o do `.env` (que a Meta recusaria) ou, sem `.env`,
 * "defina no servidor" para quem já tinha configurado tudo.
 *
 * O valor do banco NÃO é devolvido: ele é mostrado uma vez, na resposta da
 * action que o gera (`app/actions/settings/updateMetaApp.ts`), e aqui quem
 * responde é o admin de UM tenant, não quem administra a instalação. O do `.env`
 * continua sendo mostrado, como sempre foi — é o mesmo valor, na mesma rota.
 *
 * Por que "o que vale é igual ao do `.env`" basta para rotular a origem como
 * `ambiente`: o token em vigor (`lib/channels/meta/app.ts`) é OU o do banco OU o
 * do `.env` — o do banco só vale com o par inteiro decifrado; fora disso vale o
 * que o `.env` tiver, até pela metade. Então a igualdade só engana num caso: o
 * token do banco coincidir com o do `.env`. E o do banco ninguém escolhe — é
 * gerado pelo servidor com 32 bytes aleatórios —, então coincidir exige alguém
 * ter COPIADO o token gerado para o `.env`. Nesse caso o rótulo erra a origem,
 * mas o valor exibido é o mesmo que já está no `.env`, que esta rota sempre
 * mostrou: não sai nada que antes não saía.
 */
async function tokenDeVerificacaoParaATela(): Promise<{
  verifyToken: string | null;
  verifyTokenOrigem: "ambiente" | "instalacao" | null;
}> {
  const { verifyToken: emVigor } = await appDaMeta();
  if (!emVigor) return { verifyToken: null, verifyTokenOrigem: null };
  if (emVigor === appDaMetaDoAmbiente().verifyToken) {
    return { verifyToken: emVigor, verifyTokenOrigem: "ambiente" };
  }
  return { verifyToken: null, verifyTokenOrigem: "instalacao" };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const admin = createAdminClient();
  // Canal ARQUIVADO não conta como conectado. A linha sobrevive à exclusão como
  // âncora das FKs, e sem este filtro a tela dizia "conectado" (com a URL de
  // webhook já rotacionada, portanto morta) para um canal que o operador acabou
  // de excluir — e oferecia "Trocar credencial" onde deveria oferecer "Conectar".
  // O POST, ao contrário, PRECISA enxergar a linha arquivada: é ela que ele
  // ressuscita.
  const consultar = () =>
    admin
      .from("channel_sessions")
      .select("id, meta_phone_number_id, meta_waba_id, meta_token_encrypted, phone_number, display_name, webhook_path_token, status, metadata")
      .eq("organization_id", orgId)
      .eq("provider", CHANNEL_PROVIDER_META);
  const { data } = await queryTolerantToMissingArchived(
    () => consultar().is(ARCHIVED_AT, null).maybeSingle(),
    () => consultar().maybeSingle(),
  );

  const app = await appDaMeta();
  const faltam = (["META_APP_ID", "META_ES_CONFIG_ID"] as const).filter((v) =>
    v === "META_APP_ID" ? !app.appId : !app.esConfigId,
  );
  const cadastroIncorporado = {
    disponivel: faltam.length === 0,
    appId: app.appId,
    configId: app.esConfigId,
    versao: graphVersion(),
    faltam,
    configurarEm: authz.user.is_platform_admin && !authz.user.support ? "/admin/meta" : null,
  };

  return ok({
    connected: Boolean(data),
    cadastroIncorporado,
    coexistencia: data ? lerCoexistencia(data.metadata) : null,
    channel_session_id: data?.id ?? null,
    // `hasToken` em vez do token: uma vez gravado, a tela mostra que EXISTE, nunca
    // qual é. Devolver o segredo para preencher o campo seria vazá-lo a cada render.
    hasToken: Boolean(data?.meta_token_encrypted),
    phoneNumberId: data?.meta_phone_number_id ?? null,
    wabaId: data?.meta_waba_id ?? null,
    displayName: data?.display_name ?? null,
    phoneNumber: data?.phone_number ?? null,
    status: data?.status ?? null,
    /** O que o operador precisa colar do NOSSO lado no dashboard da Meta. */
    webhook: data
      ? {
          callbackUrl: callbackDaSessao(req, data.webhook_path_token),
          assinatura: (() => {
            const a = assinaturaGravada(data.metadata);
            return a?.motivo ? { ...a, motivo: traduzirMotivo(a.motivo, t) } : a;
          })(),
          ...(await tokenDeVerificacaoParaATela()),
          // A porta para quem PODE abrir a tela da instalação — mesma regra do
          // link de `/admin/google` na Agenda. Para o admin de um tenant qualquer
          // o link seria um 404; a tela diz a ele quem procurar.
          configurarEm: authz.user.is_platform_admin && !authz.user.support ? "/admin/meta" : null,
          fields: ["messages", "message_template_status_update"],
        }
      : null,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const userId = authz.user.id;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("phone_number_id, waba_id e token são obrigatórios"), 422, {
      requestId,
    });
  }
  const { phone_number_id, waba_id, token } = parsed.data;

  // Validação, gravação (ou ressurreição) e assinatura do webhook da conta: o
  // mesmo caminho do Cadastro Incorporado — ver `conectarCanalOficial`.
  const r = await conectarCanalOficial(createAdminClient(), {
    organizationId: orgId, userId, requestId, phoneNumberId: phone_number_id, wabaId: waba_id, token, callbackBase: publicBase(req),
  });
  if (!r.ok) return fail(r.codigo, traduzirMotivo(r.motivo, t), r.status, { requestId });
  return ok({
    connected: true, displayName: r.displayName, phoneNumber: r.phoneNumber,
    webhook: r.webhook.assinado ? { assinado: true } : { assinado: false, motivo: traduzirMotivo(r.webhook.motivo, t) },
  });
}
