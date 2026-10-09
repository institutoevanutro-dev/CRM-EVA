import { z } from "zod";
import { audit } from "@/lib/audit";
import type { createAdminClient } from "@/lib/supabase/admin";

/**
 * O catálogo do CRM lê os preços do PrecificaEva, a fonte única de preço da clínica
 * (a mesma função `tabela-precos` que o financeiro lê). Só serviços: um item por procedimento.
 * Item que só existe no CRM fica como está.
 */
export const ORIGEM_PRECIFICAEVA = "precificaeva";
export type ConfigPrecificaEva = { url: string; token: string };
type Admin = ReturnType<typeof createAdminClient>;

/** `PRECIFICAEVA_URL` é o endereço completo da função (https, sem usuário, query ou âncora). Token em cabeçalho, nunca na URL. */
export function configPrecificaEva(env: Record<string, string | undefined> = process.env): ConfigPrecificaEva | null {
  if (!env.PRECIFICAEVA_TOKEN || env.PRECIFICAEVA_TOKEN.length < 32) return null;
  try {
    const u = new URL(env.PRECIFICAEVA_URL ?? "");
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
    return { url: u.href, token: env.PRECIFICAEVA_TOKEN };
  } catch {
    return null;
  }
}

const reais = z.number().finite().nullable();
export const TabelaPrecificaEva = z.object({
  versao: z.literal(1),
  servicos: z.array(z.object({
    id: z.string().uuid(),
    nome: z.string().trim().min(1).max(200),
    ativo: z.boolean(),
    precoComercial: reais,
    custo: reais.optional(),
    categoria: z.string().max(100).nullable().optional(),
  })).max(2000).default([]),
});
export type TabelaPrecificaEva = z.infer<typeof TabelaPrecificaEva>;

export async function buscaTabela(c: ConfigPrecificaEva): Promise<TabelaPrecificaEva> {
  const r = await fetch(c.url, {
    headers: { "x-integracao-token": c.token },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("PrecificaEva indisponível.");
  return TabelaPrecificaEva.parse(await r.json());
}

export type ProdutoPrecificaEva = { codigo: string; nome: string; categoria: string | null; preco_cents: number; custo_cents: number | null; ativo: boolean };
const centavos = (v: number | null | undefined) => (v == null || !Number.isFinite(v) || v < 0 ? null : Math.round(v * 100));

/**
 * Serviços com preço comercial aprovado. Medicações ficam de fora de propósito (decisão do dono, 08/10):
 * o catálogo é o que o agente de IA usa para responder pacientes, e preço de medicação não é informado por ele.
 * Sem preço no PrecificaEva, o serviço não vai para o catálogo.
 */
export function produtosDaTabela(t: TabelaPrecificaEva): ProdutoPrecificaEva[] {
  const lista: ProdutoPrecificaEva[] = [];
  for (const s of t.servicos) {
    const preco = centavos(s.precoComercial);
    if (preco && preco > 0) lista.push({ codigo: `pe:proc:${s.id}`, nome: s.nome, categoria: s.categoria ?? null, preco_cents: preco, custo_cents: centavos(s.custo), ativo: s.ativo });
  }
  return lista;
}

export type ProdutoDoCrm = { id: string; codigo: string; nome: string; categoria: string | null; preco_cents: number; custo_cents: number | null; ativo: boolean; origem: string };
export type Plano = {
  inserir: ProdutoPrecificaEva[];
  atualizar: { id: string; patch: Partial<ProdutoPrecificaEva> & { origem?: string } }[];
  desativar: string[];
};

const normaliza = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * O que muda no catálogo. Produto já ligado (código "pe:...") é atualizado; produto da planilha
 * com o MESMO nome de um item do PrecificaEva é adotado (mantém o id, que a agenda usa) em vez de
 * duplicado; o resto é inserido. Ligado que sumiu ou perdeu o preço no PrecificaEva é desativado.
 */
export function planejar(doPrecificaEva: ProdutoPrecificaEva[], doCrm: ProdutoDoCrm[]): Plano {
  const porCodigo = new Map(doCrm.map((p) => [p.codigo, p]));
  const soltos = new Map<string, ProdutoDoCrm[]>();
  for (const p of doCrm) {
    if (p.codigo.startsWith("pe:")) continue;
    const k = normaliza(p.nome);
    soltos.set(k, [...(soltos.get(k) ?? []), p]);
  }
  const plano: Plano = { inserir: [], atualizar: [], desativar: [] };
  for (const pe of doPrecificaEva) {
    const ligado = porCodigo.get(pe.codigo);
    if (ligado) {
      const patch: Partial<ProdutoPrecificaEva> = {};
      for (const k of ["nome", "categoria", "preco_cents", "custo_cents", "ativo"] as const) if (ligado[k] !== pe[k]) (patch as Record<string, unknown>)[k] = pe[k];
      if (Object.keys(patch).length) plano.atualizar.push({ id: ligado.id, patch });
      continue;
    }
    const mesmos = soltos.get(normaliza(pe.nome)) ?? [];
    if (mesmos.length === 1) {
      soltos.delete(normaliza(pe.nome));
      plano.atualizar.push({ id: mesmos[0]!.id, patch: { ...pe, origem: ORIGEM_PRECIFICAEVA } });
    } else plano.inserir.push(pe);
  }
  const vivos = new Set(doPrecificaEva.map((p) => p.codigo));
  for (const p of doCrm) if (p.origem === ORIGEM_PRECIFICAEVA && p.codigo.startsWith("pe:") && !vivos.has(p.codigo) && p.ativo) plano.desativar.push(p.id);
  return plano;
}

export type ResultadoCatalogo = { inseridos: number; atualizados: number; desativados: number };

export async function sincronizarCatalogo(admin: Admin, org: string, config: ConfigPrecificaEva): Promise<ResultadoCatalogo> {
  const tabela = await buscaTabela(config);
  const { data, error } = await admin
    .from("catalog_products")
    .select("id,codigo,nome,categoria,preco_cents,custo_cents,ativo,origem")
    .eq("organization_id", org);
  if (error) throw new Error("Não foi possível ler o catálogo.");
  const plano = planejar(produtosDaTabela(tabela), (data ?? []) as ProdutoDoCrm[]);

  if (plano.inserir.length) {
    const { error: e } = await admin.from("catalog_products").insert(plano.inserir.map((p) => ({
      ...p, organization_id: org, origem: ORIGEM_PRECIFICAEVA, moeda: "BRL",
      // Serviço e aplicação não têm estoque: com controla_estoque=true o agente os esconderia (quantidade 0).
      controla_estoque: false, quantidade: 0,
    })));
    if (e) throw new Error("Não foi possível inserir produtos.");
  }
  for (const u of plano.atualizar) {
    const { error: e } = await admin.from("catalog_products").update({ ...u.patch, updated_at: new Date().toISOString() }).eq("organization_id", org).eq("id", u.id);
    if (e) throw new Error("Não foi possível atualizar produto.");
  }
  if (plano.desativar.length) {
    const { error: e } = await admin.from("catalog_products").update({ ativo: false, updated_at: new Date().toISOString() }).eq("organization_id", org).in("id", plano.desativar);
    if (e) throw new Error("Não foi possível desativar produtos.");
  }
  const resultado = { inseridos: plano.inserir.length, atualizados: plano.atualizar.length, desativados: plano.desativar.length };
  // Rodada sem efeito não é mutação e não audita (tests/unit/cron-audita-so-quando-ha-efeito.test.ts).
  if (resultado.inseridos || resultado.atualizados || resultado.desativados) {
    await audit({
      action: "catalog_product.synced",
      organizationId: org,
      resourceType: "catalog_products",
      resourceId: null,
      metadata: { actor_type: "system", source: ORIGEM_PRECIFICAEVA, ...resultado },
    });
  }
  return resultado;
}
