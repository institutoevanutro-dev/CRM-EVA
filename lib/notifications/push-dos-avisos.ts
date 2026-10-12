/**
 * Push para o CELULAR dos avisos que pedem gente.
 *
 * O som da Central (`sons-da-org.ts`) só toca com o CRM aberto na tela. Quem
 * atende pelo WhatsApp passa o dia com o CRM fechado no bolso, e os avisos que
 * pedem uma pessoa esperavam sem ninguém saber. Vai ao celular o momento em que
 * a IA passou a conversa para uma pessoa (aviso `handoff`) e o momento em que a
 * IA ficou sem crédito ou com a chave recusada no provedor.
 *
 * É o MESMO que tem som próprio: a regra de quais avisos pedem gente é uma só
 * (`somDoAviso`). Todo aviso chega pelo barramento como `central.aviso_criado`
 * (migration 0314); o resto da Central fica só na tela.
 *
 * Porte do DeskcommCRM original (PR #1815): lá também vai ao celular o negócio
 * que entrou numa etapa que avisa, aviso que não existe neste fork. Quando
 * chegar, entra em `somDoAviso` e aqui.
 *
 * O texto sai no idioma da ORGANIZAÇÃO — ninguém está logado quando o push sai
 * — e não carrega dado do cliente: o push aparece na tela bloqueada, e quem
 * precisa do nome toca e abre o contexto com a permissão que tem. O destino é o
 * mesmo que a Central daria ao aviso (`REFERENCIAS_DE_AVISO`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehAvisoDoProvedor } from "@/lib/agent-engine/edge/llm/aviso-do-provedor";
import { REFERENCIAS_DE_AVISO } from "@/lib/ai/inbox-destino";
import { traduzir } from "@/lib/i18n/dicionario";
import { normalizarIdioma, type Idioma } from "@/lib/i18n/idiomas";

import type { PushPayload } from "./push_payload";
import { somDoAviso } from "./sons-da-org";

/** Sem destino próprio, o push abre a Central — onde o aviso está. */
const CENTRAL = "/app/ai/inbox";

async function idiomaDaOrganizacao(admin: SupabaseClient, orgId: string): Promise<Idioma> {
  const { data } = await admin.from("organizations").select("locale").eq("id", orgId).maybeSingle();
  return normalizarIdioma((data as { locale?: string | null } | null)?.locale ?? null);
}

type Aviso = {
  id: string;
  kind: string;
  ref_kind: string | null;
  ref_id: string | null;
  title: string;
  body: string | null;
};

function destinoDaPassagem(item: Aviso): string {
  if (!item.ref_id) return CENTRAL;
  if (item.ref_kind === "conversation") return REFERENCIAS_DE_AVISO.conversation.href(item.ref_id);
  if (item.ref_kind === "contact") return REFERENCIAS_DE_AVISO.contact.href(item.ref_id);
  return CENTRAL;
}

/**
 * O push de um aviso da Central, ou `null` quando o aviso não vai ao celular.
 * Lê o aviso do banco em vez de confiar no payload: o evento carrega só o id.
 */
export async function pushDoAvisoDaCentral(
  admin: SupabaseClient,
  orgId: string,
  itemId: string,
): Promise<PushPayload | null> {
  // ⚠️ Organização junto do id: o client é service-role e ignora RLS.
  const { data } = await admin
    .from("agent_inbox_items")
    .select("id, kind, ref_kind, ref_id, title, body")
    .eq("organization_id", orgId)
    .eq("id", itemId)
    .maybeSingle();
  const item = data as Aviso | null;
  if (!item) return null;

  if (somDoAviso(item) !== "pessoa") return null;
  const idioma = await idiomaDaOrganizacao(admin, orgId);
  // IA sem crédito ou com a chave recusada: o título do aviso já diz o que
  // houve (gravado no idioma da organização, sem dado de cliente nem chave), e
  // o que fazer está na Central.
  if (ehAvisoDoProvedor(item.title)) {
    return {
      title: item.title,
      body: traduzir("Abra a Central de avisos para ver o que fazer.", idioma),
      tag: `aviso:${item.id}`,
      href: CENTRAL,
    };
  }
  return {
    title: traduzir("A IA passou uma conversa para a equipe", idioma),
    body: traduzir("Abra a conversa para responder o cliente.", idioma),
    tag: `aviso:${item.id}`,
    href: destinoDaPassagem(item),
  };
}
