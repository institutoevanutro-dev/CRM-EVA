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
 * `viewer` pode LISTAR os grupos fortes (é leitura de contato, que ele já
 * enxerga na tabela); quem funde é `manager`, e esse gate está na rota de
 * POST /contacts/merge.
 *
 * Os pares por NOME (`nome_parecido`, porte do #3640) vêm depois dos fortes,
 * com o mesmo formato, e só para `manager`+: é sugestão para conferir, não
 * prova, e quem decide juntar ou dispensar é o gestor. As dispensas ("Não são a
 * mesma pessoa") são lidas pela SESSÃO, sob a policy de gestor de
 * `merge_queue`. Se essa leitura falhar, a rota falha: mostrar a lista sem as
 * dispensas faria um par já dispensado voltar sem aviso.
 *
 * O CPF (porte do original #4104, com a leitura no servidor do #4225): desde a
 * 0289 `authenticated` não lê `cpf_hash`, então o índice das fichas varridas é
 * lido pelo cliente administrador, em lotes de ids, filtrado pela organização
 * da SESSÃO. Ele entra na comparação e NÃO sai na resposta: o `ok(...)` abaixo é
 * a lista fechada do que o cliente recebe.
 *
 * A primeira abertura deixa `contact.listed` na trilha (doutrina A8); a recarga
 * marcada pelo cliente (`?atualizacao=1`) não.
 */
import { randomUUID } from "node:crypto";

import { ok, fail } from "@/lib/api/wrappers";
import { auditarLeitura } from "@/lib/audit/leitura";
import { ehAberturaDeLeitura } from "@/lib/audit/releitura";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { roleAtLeast } from "@/lib/auth/types";
import { lerParesDispensados } from "@/lib/contacts/dispensar-par";
import {
  encontrarContatosDuplicados,
  encontrarParecidosPorNome,
  principalSugerido,
  type ContatoParaDeduplicar,
} from "@/lib/contacts/duplicados";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
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
 *
 * O teto só vale porque a leitura é paginada: o PostgREST corta toda resposta
 * no `max_rows` (1000 em `supabase/config.toml`) SEM erro, e o `.limit(2001)`
 * de antes devolvia 1.000 linhas com `varreu_tudo: true`.
 */
const TETO_DE_VARREDURA = 2000;

/**
 * Tamanho de cada página da varredura: o `max_rows` do PostgREST. Numa
 * instalação com `max_rows` MENOR, a página vem curta sem ser o fim — o fim é
 * provado pelo `count` exato ou por página VAZIA (#2561).
 */
const TAMANHO_DA_PAGINA = 1000;

const COLUNAS_DO_CONTATO =
  "id, name, display_name, email, email_normalized, phone_number, is_merged_into, is_anonymized, source_metadata, created_at, last_activity_at";

/** Cada id custa ~37 caracteres na URL do PostgREST; 100 ficam abaixo do limite comum de 8 KB. */
const LOTE_DE_IDS = 100;

/** O índice do CPF de cada ficha varrida, lido pelo servidor na organização da sessão. */
async function hashesDeCpf(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const admin = createAdminClient();
  const hashPorId = new Map<string, string>();
  for (let inicio = 0; inicio < ids.length; inicio += LOTE_DE_IDS) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, cpf_hash")
      .eq("organization_id", orgId)
      .in("id", ids.slice(inicio, inicio + LOTE_DE_IDS))
      .not("cpf_hash", "is", null);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { id: string; cpf_hash: string }[]) hashPorId.set(r.id, r.cpf_hash);
  }
  return hashPorId;
}

/** Tamanho da página ao ler identidades do Instagram (o `max-rows` padrão do PostgREST é 1000). */
const PAGINA_DE_IDENTIDADES = 1000;

export async function GET(req: Request): Promise<Response> {
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

  // Varredura PAGINADA por `range`, em ordem estável (`created_at`, `id`). O
  // `+1` além do teto é o que prova que existia mais do que ela alcança.
  const lidas: Omit<ContatoParaDeduplicar, "do_instagram" | "cpf_hash">[] = [];
  let totalDeVivos: number | null = null;
  let acabou = false;
  for (let pagina = 0; lidas.length <= TETO_DE_VARREDURA && !acabou; pagina++) {
    const inicio = lidas.length;
    const pedaco = Math.min(TAMANHO_DA_PAGINA, TETO_DE_VARREDURA + 1 - lidas.length);
    const { data, error, count } = await supabase
      .from("contacts")
      .select(COLUNAS_DO_CONTATO, pagina === 0 ? { count: "exact" } : undefined)
      .eq("organization_id", org.orgId)
      .is("is_merged_into", null)
      .eq("is_anonymized", false)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(inicio, inicio + pedaco - 1);
    if (error) {
      return fail("internal_error", error.message, 500, { requestId });
    }
    if (pagina === 0) totalDeVivos = count ?? null;
    const lote = (data ?? []) as unknown as Omit<ContatoParaDeduplicar, "do_instagram" | "cpf_hash">[];
    lidas.push(...lote);
    acabou = lote.length === 0 || (totalDeVivos !== null && lidas.length >= totalDeVivos);
  }

  const brutas = lidas.slice(0, TETO_DE_VARREDURA);
  const varreuTudo =
    totalDeVivos !== null ? totalDeVivos <= TETO_DE_VARREDURA : lidas.length <= TETO_DE_VARREDURA;

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

  // Sem o CPF a rota falha: listar sem ele faria o par de mesmo documento sumir calado.
  let cpfPorId: Map<string, string>;
  try {
    cpfPorId = await hashesDeCpf(org.orgId, brutas.map((c) => c.id));
  } catch {
    return fail("internal_error", "Não foi possível ler os dados de duplicados.", 500, { requestId });
  }

  const linhas: ContatoParaDeduplicar[] = brutas.map((c) => ({
    ...c,
    cpf_hash: cpfPorId.get(c.id) ?? null,
    do_instagram: doInstagram.has(c.id),
  }));
  const grupos = encontrarContatosDuplicados(linhas);

  if (roleAtLeast(org.role, "manager")) {
    let dispensados: Set<string>;
    try {
      dispensados = await lerParesDispensados(supabase, org.orgId);
    } catch {
      // Sem o detalhe do banco na resposta: ele não é para quem opera a tela.
      return fail("internal_error", "Não foi possível ler as dispensas de duplicados.", 500, { requestId });
    }
    grupos.push(...encontrarParecidosPorNome(linhas, { dispensados }));
  }

  // Só a abertura e só quando há o que mostrar: ids, nunca nome nem telefone.
  if (grupos.length > 0 && ehAberturaDeLeitura(new URL(req.url))) {
    auditarLeitura({
      action: "contact.listed",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "contact",
      requestId,
      metadata: { recurso: "duplicados", ids: grupos.flatMap((g) => g.contatos.map((c) => c.id)) },
    });
  }

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
