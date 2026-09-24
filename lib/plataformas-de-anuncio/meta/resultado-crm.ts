import type { VendaPorContato } from "@/lib/integrations/financeiro/cliente";

export type ContatoAtribuido = {
  id: string;
  source_metadata: unknown;
  is_anonymized: boolean;
};

type Metadados = Record<string, unknown>;
const objeto = (v: unknown): Metadados | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Metadados) : null;
const idMeta = (v: unknown): string | null =>
  typeof v === "string" && /^\d{5,30}$/.test(v) ? v : null;

/** Primeiro instante UTC do dia civil no fuso informado pela conta Meta. */
export function inicioDoDiaNoFuso(data: string, fuso: string): string {
  const base = Date.parse(`${data}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const diaLocal = (ms: number) => {
    const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  let antes = base - 48 * 3600000;
  let inicio = base + 48 * 3600000;
  while (inicio - antes > 1) {
    const meio = Math.floor((inicio + antes) / 2);
    if (diaLocal(meio) < data) antes = meio;
    else inicio = meio;
  }
  return new Date(inicio).toISOString();
}

/** Só IDs explícitos. Nome/headline e ctwa_clid não identificam campanha. */
export function campanhaDoContato(
  metaBruta: unknown,
  campanhaPorAnuncio: Map<string, string>,
  validas = new Set(campanhaPorAnuncio.values()),
): string | null {
  const meta = objeto(metaBruta);
  if (!meta) return null;
  const origem = typeof meta.utm_source === "string" ? meta.utm_source.toLowerCase() : "";
  if (meta.ad_platform === "meta_ads") {
    const raw = objeto(meta.ad_raw);
    const anuncio = raw?.source_type === "post" ? null : idMeta(raw?.source_id ?? raw?.sourceId);
    if (anuncio) return campanhaPorAnuncio.get(anuncio) ?? null;
  }
  if (["facebook", "instagram", "meta", "meta_ads"].includes(origem)) {
    const campanha = idMeta(meta.utm_campaign_id);
    return campanha && validas.has(campanha) ? campanha : null;
  }
  return null;
}

export type ResultadoCampanha = {
  campanha_id: string;
  contatos: number;
  vendas: number | null;
  valor_cents: string | null;
  recebido_cents: string | null;
};

/** Contatos do período; vendas realizadas no mesmo período por esses contatos. */
export function resultadosPorCampanha(
  contatos: ContatoAtribuido[],
  campanhaPorAnuncio: Map<string, string>,
  vendas: VendaPorContato[] | null,
): { campanhas: ResultadoCampanha[]; contatos_sem_campanha: number; contatos_atribuidos: number } {
  const porCampanha = new Map<
    string,
    { contatos: number; vendas: number; valor: bigint; recebido: bigint }
  >();
  const vendaPorId = new Map(vendas?.map((v) => [v.contato_id, v]) ?? []);
  const validas = new Set(campanhaPorAnuncio.values());
  let semCampanha = 0;
  let atribuidos = 0;
  for (const contato of contatos) {
    if (contato.is_anonymized) continue;
    const id = campanhaDoContato(contato.source_metadata, campanhaPorAnuncio, validas);
    if (!id) {
      semCampanha++;
      continue;
    }
    atribuidos++;
    const atual = porCampanha.get(id) ?? { contatos: 0, vendas: 0, valor: 0n, recebido: 0n };
    atual.contatos++;
    const venda = vendaPorId.get(contato.id);
    if (venda) {
      atual.vendas += venda.vendas;
      atual.valor += BigInt(venda.valor_cents);
      atual.recebido += BigInt(venda.recebido_cents);
    }
    porCampanha.set(id, atual);
  }
  return {
    campanhas: [...porCampanha].map(([campanha_id, v]) => ({
      campanha_id,
      contatos: v.contatos,
      vendas: vendas ? v.vendas : null,
      valor_cents: vendas ? v.valor.toString() : null,
      recebido_cents: vendas ? v.recebido.toString() : null,
    })),
    contatos_sem_campanha: semCampanha,
    contatos_atribuidos: atribuidos,
  };
}
