/**
 * GET /api/v1/metrics/funil — o PAINEL DO FUNIL: os números do período de um
 * funil, juntos e com a régua de cada um
 * (`docs/superpowers/specs/2026-10-06-painel-do-funil-design.md`).
 *
 * ## O que esta rota faz e o que ela NÃO faz
 *
 * Lê cards, movimentos, agenda e contatos pelo client de SESSÃO, com
 * `organization_id` explícito em toda leitura (o org vem do `requireRole`,
 * nunca da query); lê o gasto de anúncio pela credencial da organização
 * (`investimentoDoPeriodo`, admin client, filtra a org). As contas são as
 * funções puras de `lib/metrics/painel-do-funil.ts`.
 *
 * A resposta leva só contagens, somas e rótulos cadastrados (etapa, opção de
 * campo, etiqueta, campanha). Nenhum nome, telefone, id de contato ou de card,
 * nem valor de campo livre: o card pode guardar dado de saúde, e nada disso sai.
 *
 * ## Sem função SQL ⇒ a conta é aqui, e a paginação também
 *
 * Mesmo precedente de `/reports/tags`: `max_rows = 1000` corta calado, então toda
 * leitura que pode passar disso pagina com `range` + `count: "exact"` — INCLUSIVE
 * dentro de cada lote de `.in(...)` (100 cards × 11 movimentos já passam de
 * 1000). O que não coube vira `truncado: true`, nunca número menor com cara de
 * certo. `ponytail:` teto de 10×1000 por leitura; quando `truncado` aparecer em
 * instalação real, vira RPC `security invoker` com a tripla de migration.
 *
 * Read-only ⇒ sem audit. Piso `manager`: investimento, receita e ROAS são da
 * empresa inteira (mesma razão da tela Meta Ads).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import { logger } from "@/lib/logger";
import {
  agregarAgenda,
  agregarCoorte,
  agregarGanhos,
  agregarPorDimensao,
  cardDoCompromisso,
  custoERoas,
  etapaDeInteracao,
  interagiu,
  janelaDoPeriodo,
  periodoPadrao,
  posicaoAlcancada,
  valoresDaDimensao,
  type Dimensao,
  type Etapa,
} from "@/lib/metrics/painel-do-funil";
import { investimentoDoPeriodo } from "@/lib/plataformas-de-anuncio/meta/investimento";
import { campanhaDoContato } from "@/lib/plataformas-de-anuncio/meta/resultado-crm";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

const TAMANHO_DA_PAGINA = 1000;
const PAGINAS_MAXIMAS = 10;
const LOTE = 100;

const querySchema = z.object({
  de: z.iso.date().optional(),
  ate: z.iso.date().optional(),
  pipeline_id: z.uuid().optional(),
  dimensao: z.enum(["campo_contato", "campo_card", "etiqueta", "campanha"]).optional(),
  campo: z
    .string()
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/i)
    .optional(),
  prefixo: z.string().trim().min(1).max(40).optional(),
});

interface Card {
  id: string;
  stage_id: string;
  status: string;
  contact_id: string | null;
  custom_fields: unknown;
  value_cents: number | string | null;
  currency: string | null;
  created_at: string;
}
interface Contato {
  id: string;
  custom_fields: unknown;
  tags: string[] | null;
  source_metadata: unknown;
  is_anonymized: boolean;
}

class ErroDeLeitura extends Error {}

type Resposta = {
  data: unknown[] | null;
  error: { message: string } | null;
  count?: number | null;
};
type Pagina = (inicio: number, fim: number) => PromiseLike<Resposta>;

/** Lê tudo até o teto, página a página. Erro LANÇA — vira 500, nunca zero. */
async function paginar<T>(pagina: Pagina): Promise<{ linhas: T[]; truncado: boolean }> {
  const linhas: T[] = [];
  let total: number | null = null;
  let cheia = false;
  for (let p = 0; p < PAGINAS_MAXIMAS; p++) {
    const inicio = p * TAMANHO_DA_PAGINA;
    const { data, error, count } = await pagina(inicio, inicio + TAMANHO_DA_PAGINA - 1);
    if (error) throw new ErroDeLeitura(error.message);
    if (total === null) total = count ?? null;
    const lote = (data ?? []) as T[];
    linhas.push(...lote);
    cheia = lote.length >= TAMANHO_DA_PAGINA;
    if (!cheia || (total !== null && linhas.length >= total)) break;
  }
  return { linhas, truncado: total === null ? cheia : linhas.length < total };
}

/** `.in()` em lotes de 100 (URL curta), cada lote paginado. */
async function emLotes<T>(ids: string[], ler: (lote: string[]) => Pagina) {
  const unicos = [...new Set(ids)];
  const linhas: T[] = [];
  let truncado = false;
  for (let i = 0; i < unicos.length; i += LOTE) {
    const r = await paginar<T>(ler(unicos.slice(i, i + LOTE)));
    linhas.push(...r.linhas);
    truncado ||= r.truncado;
  }
  return { linhas, truncado };
}

const agruparPor = <T, K>(xs: T[], chave: (x: T) => K) => {
  const mapa = new Map<K, T[]>();
  for (const x of xs) mapa.set(chave(x), [...(mapa.get(chave(x)) ?? []), x]);
  return mapa;
};

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "metrics" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const invalido = (mensagem: string, details?: unknown) =>
    fail("validation_failed", t(mensagem), 422, { requestId, details });

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return invalido(
      "Parâmetros inválidos.",
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  const q = parsed.data;
  if (q.dimensao === "etiqueta" && !q.prefixo) return invalido("Informe o prefixo da etiqueta.");
  if ((q.dimensao === "campo_contato" || q.dimensao === "campo_card") && !q.campo) {
    return invalido("Escolha o campo do recorte.");
  }

  const fuso = fusoUtilizavel(authz.org.timezone);
  const padrao = periodoPadrao(new Date(), fuso);
  const de = q.de ?? padrao.de;
  const ate = q.ate ?? padrao.ate;
  let janela: ReturnType<typeof janelaDoPeriodo>;
  try {
    janela = janelaDoPeriodo({ de, ate, fuso });
  } catch (e) {
    return invalido(
      (e as Error).message === "periodo_invertido"
        ? "A data inicial é depois da final."
        : "O painel cobre no máximo 90 dias.",
    );
  }

  const db = await createClient();
  try {
    // ─── Funis e campos ──────────────────────────────────────────────────────
    const { data: funisBrutos, error: erroFunis } = await db
      .from("crm_pipelines")
      .select("id, name, is_default, position, settings")
      .eq("organization_id", orgId)
      .eq("is_archived", false)
      .order("position");
    if (erroFunis) throw new ErroDeLeitura(erroFunis.message);
    const funis = (funisBrutos ?? []) as Array<{
      id: string;
      name: string;
      is_default: boolean;
      settings: Record<string, unknown> | null;
    }>;
    const padraoDoFunil = funis.find((f) => f.is_default) ?? funis[0];
    const funil = q.pipeline_id ? funis.find((f) => f.id === q.pipeline_id) : padraoDoFunil;
    if (!funil) return fail("not_found", t("Funil não encontrado."), 404, { requestId });

    const camposDeLista = (settings: Record<string, unknown> | null | undefined) =>
      camposDoFunil(settings).filter((c) => c.type === "select" && (c.options?.length ?? 0) > 0);
    const camposContato = camposDeLista(padraoDoFunil?.settings);
    const camposCard = camposDeLista(funil.settings);

    let dimensao: Dimensao | null = null;
    if (q.dimensao === "campo_contato" || q.dimensao === "campo_card") {
      const campo = (q.dimensao === "campo_contato" ? camposContato : camposCard).find(
        (c) => c.key === q.campo,
      );
      if (!campo) return invalido("O campo escolhido não é um campo de lista deste funil.");
      dimensao = { tipo: q.dimensao, campo: campo.key, opcoes: campo.options ?? [] };
    } else if (q.dimensao === "etiqueta") {
      dimensao = { tipo: "etiqueta", prefixo: q.prefixo! };
    } else if (q.dimensao === "campanha") {
      dimensao = { tipo: "campanha" };
    }

    // ─── Leituras do CRM (todas com organization_id) ─────────────────────────
    const { data: etapasBrutas, error: erroEtapas } = await db
      .from("crm_stages")
      .select("id, name, position, is_won, is_lost, is_archived, agent_stage_hint")
      .eq("organization_id", orgId)
      .eq("pipeline_id", funil.id);
    if (erroEtapas) throw new ErroDeLeitura(erroEtapas.message);
    const etapas = ((etapasBrutas ?? []) as Etapa[]).map((e) => ({
      ...e,
      position: Number(e.position),
    }));

    const COLUNAS_CARD =
      "id, stage_id, status, contact_id, custom_fields, value_cents, currency, created_at";
    const coorte = await paginar<Card>((a, b) =>
      db
        .from("crm_leads")
        .select(COLUNAS_CARD, { count: "exact" })
        .eq("organization_id", orgId)
        .eq("pipeline_id", funil.id)
        .gte("created_at", janela.inicio)
        .lt("created_at", janela.fimExclusivo)
        .order("created_at")
        .order("id")
        .range(a, b),
    );

    const movimentos = await emLotes<{ lead_id: string; payload: unknown }>(
      coorte.linhas.map((c) => c.id),
      (lote) => (a, b) =>
        db
          .from("crm_lead_activities")
          .select("lead_id, payload", { count: "exact" })
          .eq("organization_id", orgId)
          .eq("type", "stage_changed")
          .in("lead_id", lote)
          .order("lead_id")
          .order("performed_at")
          .order("id")
          .range(a, b),
    );

    const ganhos = await paginar<Card>((a, b) =>
      db
        .from("crm_leads")
        .select(COLUNAS_CARD, { count: "exact" })
        .eq("organization_id", orgId)
        .eq("pipeline_id", funil.id)
        .eq("status", "won")
        .gte("closed_at", janela.inicio)
        .lt("closed_at", janela.fimExclusivo)
        .order("closed_at")
        .order("id")
        .range(a, b),
    );

    const compromissos = await paginar<{
      id: string;
      status: string;
      ends_at: string;
      contact_id: string | null;
    }>((a, b) =>
      db
        .from("calendar_appointments")
        .select("id, status, ends_at, contact_id", { count: "exact" })
        .eq("organization_id", orgId)
        .gte("starts_at", janela.inicio)
        .lt("starts_at", janela.fimExclusivo)
        .order("starts_at")
        .order("id")
        .range(a, b),
    );

    const vinculos = await emLotes<{ lead_id: string; target_id: string; created_at: string }>(
      compromissos.linhas.map((c) => c.id),
      (lote) => (a, b) =>
        db
          .from("crm_lead_links")
          .select("lead_id, target_id, created_at", { count: "exact" })
          .eq("organization_id", orgId)
          .eq("target_kind", "appointment")
          .in("target_id", lote)
          .order("target_id")
          .order("id")
          .range(a, b),
    );
    const vinculosPorCompromisso = agruparPor(vinculos.linhas, (v) => v.target_id);

    // Cards DESTE funil que a agenda alcança: os vinculados, e os dos contatos
    // de compromissos sem vínculo.
    const cardsVinculados = await emLotes<Card>(
      vinculos.linhas.map((v) => v.lead_id),
      (lote) => (a, b) =>
        db
          .from("crm_leads")
          .select(COLUNAS_CARD, { count: "exact" })
          .eq("organization_id", orgId)
          .eq("pipeline_id", funil.id)
          .in("id", lote)
          .order("id")
          .range(a, b),
    );
    const contatosSemVinculo = compromissos.linhas
      .filter((c) => !vinculosPorCompromisso.has(c.id) && c.contact_id)
      .map((c) => c.contact_id!);
    const cardsDosContatos = await emLotes<Card>(
      contatosSemVinculo,
      (lote) => (a, b) =>
        db
          .from("crm_leads")
          .select(COLUNAS_CARD, { count: "exact" })
          .eq("organization_id", orgId)
          .eq("pipeline_id", funil.id)
          .in("contact_id", lote)
          .order("created_at")
          .order("id")
          .range(a, b),
    );
    const cardsDaAgenda = new Map(
      [...cardsVinculados.linhas, ...cardsDosContatos.linhas].map((c) => [c.id, c]),
    );
    const cardsPorContato = agruparPor(
      cardsDosContatos.linhas.filter((c) => c.contact_id),
      (c) => c.contact_id!,
    );
    const agenda = compromissos.linhas.flatMap((c) => {
      const card = cardDoCompromisso(
        c,
        vinculosPorCompromisso.get(c.id) ?? [],
        cardsDaAgenda,
        cardsPorContato,
      );
      return card ? [{ ...c, card }] : [];
    });

    // ─── Investimento e contatos ─────────────────────────────────────────────
    const investimento = await investimentoDoPeriodo(createAdminClient(), orgId, de, ate);
    const investimentoOk = investimento.estado === "ok" ? investimento : null;
    const dimensaoDeContato = dimensao !== null && dimensao.tipo !== "campo_card";
    const idsDeContato = [
      ...(investimentoOk ? ganhos.linhas : []),
      ...(dimensaoDeContato ? [...coorte.linhas, ...ganhos.linhas] : []),
      ...(dimensaoDeContato
        ? agenda.map((c) => ({ contact_id: c.card.contact_id ?? c.contact_id }))
        : []),
    ]
      .map((c) => c.contact_id)
      .filter((id): id is string => Boolean(id));
    const contatos = await emLotes<Contato>(
      idsDeContato,
      (lote) => (a, b) =>
        db
          .from("contacts")
          .select("id, custom_fields, tags, source_metadata, is_anonymized", { count: "exact" })
          .eq("organization_id", orgId)
          .in("id", lote)
          .order("id")
          .range(a, b),
    );
    const contatoPorId = new Map(contatos.linhas.map((c) => [c.id, c]));
    // Contato anonimizado não tem campanha — mesma exclusão da tela Meta Ads.
    const campanhaDe = (contactId: string | null): string | null => {
      const contato = contactId ? contatoPorId.get(contactId) : undefined;
      if (!investimentoOk || !contato || contato.is_anonymized) return null;
      return campanhaDoContato(contato.source_metadata, investimentoOk.campanhaPorAnuncio);
    };

    // ─── As contas ───────────────────────────────────────────────────────────
    const movimentosPorCard = agruparPor(movimentos.linhas, (mv) => mv.lead_id);
    const numerosCoorte = agregarCoorte({ etapas, cards: coorte.linhas, movimentosPorCard });
    const numerosGanhos = agregarGanhos(ganhos.linhas);
    const numerosAgenda = agregarAgenda(agenda, Date.now());
    const ganhosDeAnuncio = investimentoOk
      ? ganhos.linhas.filter((g) => campanhaDe(g.contact_id))
      : null;
    const custo = custoERoas({
      investimento,
      ganhosDeAnuncio: ganhosDeAnuncio?.length ?? 0,
      receitaDeAnuncio: agregarGanhos(ganhosDeAnuncio ?? []).receita,
    });

    let respostaDimensao: unknown = null;
    if (dimensao?.tipo === "campanha" && !investimentoOk) {
      respostaDimensao = { tipo: "campanha", estado: investimento.estado, linhas: [] };
    } else if (dimensao) {
      const d = dimensao;
      const chaves = (card: Card, contactId: string | null) =>
        valoresDaDimensao(d, {
          card,
          contato: contactId ? (contatoPorId.get(contactId) ?? null) : null,
          campanha: campanhaDe(contactId),
        });
      const porId = new Map(etapas.map((e) => [e.id, e]));
      const interacao = etapaDeInteracao(etapas);
      respostaDimensao = {
        tipo: d.tipo,
        ...(d.tipo === "campo_contato" || d.tipo === "campo_card" ? { campo: d.campo } : {}),
        ...(d.tipo === "etiqueta" ? { prefixo: d.prefixo } : {}),
        linhas: agregarPorDimensao({
          dimensao: d,
          temEtapaDeInteracao: interacao !== null,
          coorte: coorte.linhas.map((c) => ({
            chaves: chaves(c, c.contact_id),
            interagiu: interagiu(
              posicaoAlcancada(c, movimentosPorCard.get(c.id) ?? [], porId),
              interacao,
            ),
          })),
          ganhos: ganhos.linhas.map((g) => ({ ...g, chaves: chaves(g, g.contact_id) })),
          agenda: agenda.map((c) => ({
            status: c.status,
            chaves: chaves(c.card, c.card.contact_id ?? c.contact_id),
          })),
          campanhas: investimentoOk?.porCampanha,
        }),
      };
    }

    const truncado = [
      coorte,
      movimentos,
      ganhos,
      compromissos,
      vinculos,
      cardsVinculados,
      cardsDosContatos,
      contatos,
    ].some((r) => r.truncado);

    return ok(
      {
        periodo: { de, ate, fuso },
        funil: { id: funil.id, nome: funil.name },
        numeros: {
          leads: numerosCoorte.leads,
          interagiram: numerosCoorte.interagiram,
          taxa_interacao: numerosCoorte.taxa_interacao,
          perdidos: numerosCoorte.perdidos,
          aviso_interacao: numerosCoorte.aviso,
          // O nome da etapa vai para a régua: "chegaram a Interagiu ou além".
          etapa_interacao: etapaDeInteracao(etapas)?.name ?? null,
          ...numerosGanhos,
          ganhos_de_anuncio: ganhosDeAnuncio?.length ?? null,
          ...custo,
          ...numerosAgenda,
        },
        por_etapa: numerosCoorte.por_etapa,
        dimensao: respostaDimensao,
        investimento: investimentoOk
          ? {
              estado: "ok",
              conta: investimentoOk.conta.nome,
              moeda: investimentoOk.moeda,
              cents: investimentoOk.cents,
            }
          : investimento,
        opcoes: {
          funis: funis.map((f) => ({ id: f.id, nome: f.name, padrao: f.is_default })),
          campos_contato: camposContato.map((c) => ({ key: c.key, label: c.label })),
          campos_card: camposCard.map((c) => ({ key: c.key, label: c.label })),
        },
        truncado,
      },
      { requestId },
    );
  } catch (e) {
    if (!(e instanceof ErroDeLeitura)) throw e;
    logger.error("[metrics.funil] leitura falhou", { orgId, error: e.message, requestId });
    return fail("internal_error", t("Não consegui ler os dados do painel."), 500, { requestId });
  }
}
