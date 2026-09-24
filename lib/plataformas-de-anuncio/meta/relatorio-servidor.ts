import { configFinanceiro, consultaVendasPorContatos } from "@/lib/integrations/financeiro/cliente";
import { lerCredencialDeLeitura } from "@/lib/plataformas-de-anuncio/credenciais-de-leitura";
import { lerAnunciosDaConta, lerFusoDaConta } from "@/lib/plataformas-de-anuncio/meta/insights";
import {
  campanhaDoContato,
  inicioDoDiaNoFuso,
  resultadosPorCampanha,
  type ContatoAtribuido,
} from "@/lib/plataformas-de-anuncio/meta/resultado-crm";
import { createAdminClient } from "@/lib/supabase/admin";

export type ConsultaDeCampanhas = { organizacao: string; conta: string; de: string; ate: string };

export async function relatorioDeCampanhas({ organizacao, conta, de, ate }: ConsultaDeCampanhas) {
  const admin = createAdminClient();
  const credencial = await lerCredencialDeLeitura(admin, organizacao, "meta_ads");
  if (!credencial.ok) return { ok: false as const, causa: "credencial" as const };
  const [anuncios, fuso] = await Promise.all([
    lerAnunciosDaConta(credencial.credencial.accessToken, conta),
    lerFusoDaConta(credencial.credencial.accessToken, conta),
  ]);
  if (!anuncios.ok || !fuso) return { ok: false as const, causa: "meta" as const };
  const mapa = new Map(anuncios.dados.map((a) => [a.id, a.campaign_id]));
  const campanhasValidas = new Set(mapa.values());

  const contatos: ContatoAtribuido[] = [];
  const inicioUtc = inicioDoDiaNoFuso(de, fuso);
  const diaDepois = new Date(Date.parse(ate) + 86400000).toISOString().slice(0, 10);
  const ateExclusivo = inicioDoDiaNoFuso(diaDepois, fuso);
  for (let inicio = 0; inicio <= 5000; inicio += 500) {
    const { data, error } = await admin
      .from("contacts")
      .select("id,source_metadata,is_anonymized")
      .eq("organization_id", organizacao)
      .gte("created_at", inicioUtc)
      .lt("created_at", ateExclusivo)
      .order("id")
      .range(inicio, inicio + 499);
    if (error) return { ok: false as const, causa: "contatos" as const };
    contatos.push(...(data ?? []));
    if (contatos.length > 5000) return { ok: false as const, causa: "volume" as const };
    if (!data || data.length < 500) break;
  }

  const ids = contatos
    .filter((c) => !c.is_anonymized && campanhaDoContato(c.source_metadata, mapa, campanhasValidas))
    .map((c) => c.id);
  const config = configFinanceiro(organizacao);
  let vendas: Awaited<ReturnType<typeof consultaVendasPorContatos>> | null = null;
  let financeiro: "disponivel" | "nao_configurado" | "indisponivel" = config
    ? "disponivel"
    : "nao_configurado";
  if (config) {
    try {
      const lotes = await Promise.all(
        Array.from({ length: Math.ceil(ids.length / 500) }, (_, i) =>
          consultaVendasPorContatos(config, ids.slice(i * 500, i * 500 + 500), de, ate),
        ),
      );
      vendas = lotes.flat();
    } catch {
      financeiro = "indisponivel";
    }
  }
  if (config && ids.length === 0) vendas = [];
  return {
    ok: true as const,
    dados: {
      ...resultadosPorCampanha(contatos, mapa, vendas),
      financeiro,
      contatos_vinculados: vendas?.length ?? null,
      consultado_em: new Date().toISOString(),
      periodo: { from: de, to: ate, fuso },
      criterio:
        "Contatos criados no período com ID de anúncio Meta; vendas vinculadas realizadas no período; recebido líquido até a consulta.",
    },
  };
}
