/**
 * GET /api/v1/contacts/duplicates — quem é a MESMA pessoa cadastrada duas vezes.
 *
 * A detecção é PURA (`lib/contacts/duplicados.ts`) e roda aqui, no servidor,
 * sobre a página de contatos vivos que a RLS deixa o usuário ver. Não é um
 * `select` esperto: os três índices únicos parciais de `contacts` já impedem
 * duas linhas ativas com a MESMA string, então o que sobra para o produto é a
 * grafia diferente do mesmo número (o nono dígito) e o telefone que a ingestão
 * do WhatsApp parkou em `source_metadata.telefone_em_conflito`. Nenhum dos dois
 * é comparação de igualdade, e é por isso que a regra vive em TypeScript
 * testável em vez de virar SQL que ninguém relê.
 *
 * `viewer` pode LISTAR (é leitura de contato, que ele já enxerga na tabela);
 * quem funde é `manager`, e esse gate está na rota de POST /contacts/merge.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import {
  encontrarContatosDuplicados,
  principalSugerido,
  type ContatoParaDeduplicar,
} from "@/lib/contacts/duplicados";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Teto de linhas varridas.
 *
 * A varredura é O(n) e roda sobre contatos VIVOS — mas ela é uma tela de
 * limpeza, não um relatório: numa base grande, devolver "os 5.000 grupos" não
 * ajuda ninguém a decidir nada e custa memória do contêiner do self-hoster.
 * Quem passa daqui limpa em levas, e a resposta diz que truncou (`varreu_tudo`)
 * em vez de calar — silêncio aqui leria como "não há mais duplicata".
 */
const TETO_DE_VARREDURA = 2000;

/** Tamanho da página ao ler identidades do Instagram (o `max-rows` padrão do PostgREST é 1000). */
const PAGINA_DE_IDENTIDADES = 1000;

export async function GET(): Promise<Response> {
  const requestId = randomUUID();

  const user = await loadAuthUser();
  if (!user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const org = await resolveActiveOrg(user);
  if (!org) {
    const t = (texto: string) => traduzir(texto, user.idioma);
    return fail("forbidden_tenant", t("Organização ativa não resolvida."), 403, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .select(
      "id, name, display_name, email, email_normalized, phone_number, is_merged_into, is_anonymized, source_metadata, created_at, last_activity_at",
    )
    .eq("organization_id", org.orgId)
    .is("is_merged_into", null)
    .eq("is_anonymized", false)
    .order("created_at", { ascending: true })
    .limit(TETO_DE_VARREDURA + 1);
  if (error) {
    return fail("internal_error", error.message, 500, { requestId });
  }

  const brutas = (data ?? []).slice(0, TETO_DE_VARREDURA) as unknown as Omit<ContatoParaDeduplicar, "do_instagram">[];
  const varreuTudo = (data ?? []).length <= TETO_DE_VARREDURA;

  // Quem tem identidade de Instagram: só org + canal, interseção em memória.
  // Um `.in("contact_id", [...até 2000 UUIDs])` estourava a URL do GET, o
  // erro era ignorado e os pares Instagram × WhatsApp sumiam em silêncio.
  // Paginado porque o PostgREST corta cada resposta no `max-rows`.
  const idsDaVarredura = new Set(brutas.map((c) => c.id));
  const doInstagram = new Set<string>();
  for (let desde = 0; idsDaVarredura.size > 0; desde += PAGINA_DE_IDENTIDADES) {
    const { data: identidades, error: erroIdentidades } = await supabase
      .from("contact_channel_identities")
      .select("contact_id")
      .eq("organization_id", org.orgId)
      .eq("channel", "instagram")
      .order("contact_id", { ascending: true })
      .range(desde, desde + PAGINA_DE_IDENTIDADES - 1);
    if (erroIdentidades) {
      return fail("internal_error", erroIdentidades.message, 500, { requestId });
    }
    const pagina = (identidades ?? []) as { contact_id: string }[];
    for (const row of pagina) {
      if (idsDaVarredura.has(row.contact_id)) doInstagram.add(row.contact_id);
    }
    if (pagina.length < PAGINA_DE_IDENTIDADES) break;
  }

  const linhas: ContatoParaDeduplicar[] = brutas.map((c) => ({
    ...c,
    do_instagram: doInstagram.has(c.id),
  }));
  const grupos = encontrarContatosDuplicados(linhas);

  return ok(
    grupos.map((grupo) => ({
      chave: grupo.chave,
      motivos: grupo.motivos,
      principal_sugerido: principalSugerido(grupo),
      contatos: grupo.contatos.map((c) => ({
        id: c.id,
        name: c.name,
        display_name: c.display_name,
        email: c.email,
        phone_number: c.phone_number,
        created_at: c.created_at,
        last_activity_at: c.last_activity_at,
      })),
    })),
    { requestId, meta: { varreu_tudo: varreuTudo, contatos_varridos: Math.min(linhas.length, TETO_DE_VARREDURA) } },
  );
}
