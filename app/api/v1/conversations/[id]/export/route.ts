// GET /api/v1/conversations/[id]/export?formato=pdf
//
// O histórico de UMA conversa como PDF, para quem atende baixar. Porte de
// melgarafael/DeskcommCRM #2229 (contribuição de @webtecnica, refs #1982).
//
// ─── Acesso ─────────────────────────────────────────────────────────────────
// `requireRole("agent")` ANTES de qualquer leitura, o mesmo gate das outras
// rotas de `conversations/[id]`. "Somente leitura" e "Prestador de serviço"
// seguem lendo na tela o que já leem, mas não levam o arquivo: um download é o
// histórico inteiro saindo do sistema. Sessão de acompanhamento do suporte
// também não leva.
//
// Depois do papel, a leitura é pelo client da SESSÃO: a RLS de `conversations`
// e de `messages` passa por `fn_can_view_conversation`, então quem não enxerga
// a conversa na Inbox recebe 404 aqui, e conversa de outra organização também.
// A organização vem da sessão, nunca do caminho ou do corpo.
//
// ─── O que não é lido ───────────────────────────────────────────────────────
// `conversation_notes` (nota interna), rascunhos da IA e campos cifrados do
// contato não são consultados por esta rota. O que não é lido não vaza.
import { randomUUID } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { auditarLeitura } from "@/lib/audit/leitura";
import { requireRole } from "@/lib/auth/require-role";
import {
  COLUNAS_DA_MENSAGEM,
  LIMITE_DE_MENSAGENS,
  mensagensQueCabem,
  montarPdfDaConversa,
  type ConversaParaPdf,
  type MensagemParaPdf,
} from "@/lib/conversas/exporta-pdf";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

export const dynamic = "force-dynamic";

// O render é a parte cara: CPU e memória do mesmo processo que serve o CRM.
// O teto por pessoa barra o clique repetido; o da organização, vários ao mesmo
// tempo ao longo do minuto.
const TETO_POR_USUARIO = 5;
const TETO_POR_ORGANIZACAO = 20;
const JANELA_SEGUNDOS = 60;

// Limite por minuto não impede dois renders NO MESMO INSTANTE, e cada um custa
// até a casa de 200 MB (ver `LIMITE_DE_CARACTERES_DO_ARQUIVO`). Um de cada vez por processo.
// ponytail: contador em memória, vale por processo; se o app ganhar réplicas,
// trocar por trava no Redis.
let rendersEmAndamento = 0;
const RENDERS_SIMULTANEOS = 1;

const parametros = z.object({ id: z.uuid(), formato: z.literal("pdf") });

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (authz.user.support) {
    return fail("forbidden", t("O acompanhamento do suporte não exporta conversas."), 403, { requestId });
  }

  const lidos = parametros.safeParse({
    id: (await ctx.params).id,
    formato: new URL(req.url).searchParams.get("formato") ?? "pdf",
  });
  if (!lidos.success) {
    const idInvalido = lidos.error.issues.some((i) => i.path[0] === "id");
    return idInvalido
      ? fail("not_found", t("Conversa não encontrada."), 404, { requestId })
      : fail("validation_failed", t("Formato não suportado: use ?formato=pdf."), 422, { requestId });
  }
  const id = lidos.data.id;
  const orgId = authz.org.orgId;

  // O da organização só conta pedido que a pessoa ainda podia fazer: quem
  // martela o botão esgota o próprio minuto, não o dos colegas.
  const porUsuario = await checkRateLimit(`conversa-export:${authz.user.id}`, TETO_POR_USUARIO, JANELA_SEGUNDOS);
  const barrou = porUsuario.allowed
    ? await checkRateLimit(`conversa-export-org:${orgId}`, TETO_POR_ORGANIZACAO, JANELA_SEGUNDOS)
    : porUsuario;
  if (!barrou.allowed) {
    return fail("rate_limited", t("Muitas exportações seguidas. Tente em um minuto."), 429, {
      requestId,
      headers: {
        "Retry-After": String(JANELA_SEGUNDOS),
        "X-RateLimit-Limit": String(barrou.limit),
        "X-RateLimit-Remaining": String(Math.max(0, barrou.limit - barrou.count)),
      },
    });
  }

  const supabase = await createClient();

  const { data: conversa, error: erroDaConversa } = await supabase
    .from("conversations")
    .select("id, contact_id, channel")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (erroDaConversa) return fail("internal_error", t("Erro ao ler a conversa."), 500, { requestId });
  if (!conversa) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });

  // Do fim para o começo + limite: o corte fica nas mais ANTIGAS. A ordem do
  // documento é refeita por `linhasDoHistorico`.
  const [contato, mensagensLidas] = await Promise.all([
    conversa.contact_id
      ? supabase
          .from("contacts")
          .select("name, display_name, phone_number")
          .eq("organization_id", orgId)
          .eq("id", conversa.contact_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("messages")
      .select(COLUNAS_DA_MENSAGEM)
      .eq("organization_id", orgId)
      .eq("conversation_id", id)
      .order("sent_at", { ascending: false })
      .order("id", { ascending: false })
      // Uma a mais que o limite: é ela que diz se a conversa passou do teto.
      .limit(LIMITE_DE_MENSAGENS + 1),
  ]);
  if (contato.error) return fail("internal_error", t("Erro ao ler o contato."), 500, { requestId });
  if (mensagensLidas.error) return fail("internal_error", t("Erro ao ler as mensagens."), 500, { requestId });

  // Dois tetos, contagem e volume de texto: o que estourar primeiro corta.
  const { mensagens, truncada } = mensagensQueCabem((mensagensLidas.data ?? []) as unknown as MensagemParaPdf[]);

  // Nome de quem enviou não fica na linha da mensagem. Se o lookup cair, o
  // rótulo cai para "Equipe", sem falhar o export.
  const nomesDosUsuarios = await nomesDosAtendentes(mensagens.map((m) => m.sent_by_user_id));

  const conversaParaPdf: ConversaParaPdf = {
    id,
    channel: (conversa.channel as string | null) ?? null,
    contato: (contato.data as ConversaParaPdf["contato"]) ?? null,
  };

  if (rendersEmAndamento >= RENDERS_SIMULTANEOS) {
    return fail("rate_limited", t("Outra exportação está em andamento. Tente de novo em instantes."), 429, {
      requestId,
      headers: { "Retry-After": "5" },
    });
  }
  rendersEmAndamento++;
  let pdf;
  try {
    pdf = await montarPdfDaConversa(supabase, orgId, conversaParaPdf, mensagens, {
      t,
      idioma: authz.user.idioma,
      exportadoPor: authz.user.full_name ?? authz.user.email ?? null,
      nomesDosUsuarios,
      truncada,
    });
  } finally {
    rendersEmAndamento--;
  }
  if (!pdf.ok) return fail("internal_error", pdf.motivo, 500, { requestId });

  // Quem, qual conversa e QUANTAS mensagens. Nunca o texto delas.
  auditarLeitura({
    action: "conversation.exported",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "conversation",
    resourceId: id,
    requestId,
    metadata: { mensagens: mensagens.length, formato: "pdf", truncada },
  });

  return new Response(new Uint8Array(pdf.buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${pdf.nomeDoArquivo}"`,
      "Cache-Control": "no-store",
      "X-Request-Id": requestId,
      // A tela lê isto para avisar que o arquivo não tem a conversa inteira.
      "X-Export-Truncated": truncada ? "1" : "0",
    },
  });
}
