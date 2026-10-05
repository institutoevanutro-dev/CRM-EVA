/**
 * O ícone da aba da INSTALAÇÃO (migration 0291) — subir e remover.
 *
 * Irmã de `app/api/v1/marca/logo/route.ts` no escopo de instalação, com as
 * mesmas guardas e na mesma ordem: suporte em modo leitura não escreve, só
 * platform admin de scope `full`, segundo fator provado na sessão, teto de trocas por usuário,
 * tipo e medidas decididos pelos BYTES (`lib/branding/icone-arquivo.ts`),
 * caminho não-enumerável em `brand-logos/platform/<uuid>.png`, ponteiro gravado
 * no banco ANTES de apagar o arquivo anterior, e auditoria em
 * `platform_branding.updated` com a FORMA da mudança (nunca o caminho).
 *
 * Não há escopo de organização: a aba é uma por domínio, e o domínio é da
 * instalação.
 */
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { EscritaDePlatformAdminNegada, requirePlatformAdminEscrita } from "@/lib/auth/requirePlatformAdmin";
import { loadAuthUser } from "@/lib/auth/server";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { recusaDoIcone } from "@/lib/branding/icone-arquivo";
import { invalidarVersaoDoIcone } from "@/lib/branding/icone-versao";
import {
  baseDoStorage,
  BUCKET_DE_LOGOS,
  caminhoNovoDoLogo,
  PREFIXO_DA_INSTALACAO,
  urlPublicaDoLogo,
} from "@/lib/branding/logo";
import { podeApagar } from "@/lib/branding/logo-arquivo";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const TETO_POR_USUARIO = 10;
const JANELA_SEGUNDOS = 300;

type Recusa = { readonly codigo: string; readonly mensagem: string; readonly status: number };

async function quemPode(): Promise<{ userId: string } | { recusa: Recusa }> {
  const user = await loadAuthUser();
  if (!user) return { recusa: { codigo: "unauthenticated", mensagem: "Faça login.", status: 401 } };
  // Linha ativa em `platform_admins`, scope `full` (o `support_readonly` lê o
  // painel e nada muda) e segundo fator provado na sessão. O guarda REDIRECIONA
  // quem não é platform admin; aqui o redirect vira recusa, porque 307 para HTML
  // num fetch de upload chega à tela como "erro inesperado".
  try {
    await requirePlatformAdminEscrita();
  } catch (err) {
    if (err instanceof EscritaDePlatformAdminNegada) {
      return { recusa: { codigo: err.code, mensagem: err.message, status: 403 } };
    }
    return {
      recusa: {
        codigo: "forbidden_role",
        mensagem: "Só quem administra a instalação pode trocar o ícone do sistema.",
        status: 403,
      },
    };
  }
  return { userId: user.id };
}

async function caminhoGravado(): Promise<string | null> {
  const { data } = await createAdminClient()
    .from("platform_branding")
    .select("icone_path")
    .eq("id", 1)
    .maybeSingle();
  return (data as { icone_path?: string | null } | null)?.icone_path ?? null;
}

async function gravarCaminho(caminho: string | null): Promise<boolean> {
  const { error } = await createAdminClient()
    .from("platform_branding")
    .upsert({ id: 1, icone_path: caminho, seeded_from_env: false }, { onConflict: "id" });
  if (error) {
    logger.error("[marca/icone] gravação falhou", { codigo: error.code, detalhe: error.message });
    return false;
  }
  invalidarVersaoDoIcone();
  return true;
}

async function apagarAnterior(anterior: string | null): Promise<void> {
  if (!anterior) return;
  if (!podeApagar(anterior, PREFIXO_DA_INSTALACAO)) {
    logger.error("[marca/icone] recusei apagar arquivo fora do prefixo da instalação", {
      caminho_recusado: anterior,
    });
    return;
  }
  const { error } = await createAdminClient().storage.from(BUCKET_DE_LOGOS).remove([anterior]);
  if (error) logger.warn("[marca/icone] arquivo anterior ficou órfão", { detalhe: error.message, caminho: anterior });
}

async function registrarAuditoria(userId: string, req: NextRequest, requestId: string, definido: boolean) {
  await audit({
    action: "platform_branding.updated",
    actorUserId: userId,
    resourceType: "platform_branding",
    // `null`: `resource_id` é uuid e o singleton não tem um (ver a rota do logo).
    resourceId: null,
    requestId,
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: req.headers.get("user-agent") ?? null,
    actingAsPlatformAdmin: true,
    metadata: { fields_changed: ["icone_path"], icone_definido: definido },
  });
}

async function dentroDoTeto(userId: string): Promise<boolean> {
  const limite = await checkRateLimit(`marca-icone:${userId}`, TETO_POR_USUARIO, JANELA_SEGUNDOS);
  return limite.allowed;
}

const MUITAS_TROCAS = "Muitas trocas de ícone seguidas. Tente em alguns minutos.";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();

  const quem = await quemPode();
  if ("recusa" in quem) return fail(quem.recusa.codigo, quem.recusa.mensagem, quem.recusa.status, { requestId });
  if (!(await dentroDoTeto(quem.userId))) {
    return fail("rate_limited", MUITAS_TROCAS, 429, { requestId, headers: { "Retry-After": String(JANELA_SEGUNDOS) } });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return fail("validation_failed", "Campo 'file' (multipart) obrigatório.", 422, { requestId });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const recusa = recusaDoIcone(bytes);
  if (recusa) {
    return fail(recusa.codigo, recusa.mensagem, recusa.status, {
      requestId,
      details: { content_type_declarado: file.type || null },
    });
  }

  const anterior = await caminhoGravado();
  const caminho = caminhoNovoDoLogo(PREFIXO_DA_INSTALACAO, "png");
  const { error: erroUp } = await createAdminClient()
    .storage.from(BUCKET_DE_LOGOS)
    .upload(caminho, bytes, { contentType: "image/png", upsert: false });
  if (erroUp) {
    logger.error("[marca/icone] upload falhou", { detalhe: erroUp.message, requestId });
    return fail("internal_error", "Erro ao subir o ícone.", 500, { requestId });
  }
  if (!(await gravarCaminho(caminho))) {
    void createAdminClient().storage.from(BUCKET_DE_LOGOS).remove([caminho]);
    return fail("internal_error", "Erro ao gravar o ícone.", 500, { requestId });
  }

  await apagarAnterior(anterior);
  await registrarAuditoria(quem.userId, req, requestId, true);
  return ok({ icone_path: caminho, icone_url: urlPublicaDoLogo(caminho, baseDoStorage()) }, { requestId });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();

  const quem = await quemPode();
  if ("recusa" in quem) return fail(quem.recusa.codigo, quem.recusa.mensagem, quem.recusa.status, { requestId });
  if (!(await dentroDoTeto(quem.userId))) {
    return fail("rate_limited", MUITAS_TROCAS, 429, { requestId, headers: { "Retry-After": String(JANELA_SEGUNDOS) } });
  }

  const anterior = await caminhoGravado();
  if (!(await gravarCaminho(null))) return fail("internal_error", "Erro ao remover o ícone.", 500, { requestId });
  await apagarAnterior(anterior);
  await registrarAuditoria(quem.userId, req, requestId, false);
  return ok({ icone_path: null, icone_url: null }, { requestId });
}
