"use client";

import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import type { ResultadoCrmResposta } from "@/hooks/ads/useMetaAds";
import type { LinhaDeCampanha } from "@/lib/plataformas-de-anuncio/types";

const reais = (centavos: string | null) => {
  if (centavos === null) return "—";
  const n = BigInt(centavos);
  return `R$ ${(n / 100n).toLocaleString("pt-BR")},${(n % 100n).toString().padStart(2, "0")}`;
};

export function ResultadoCrm({
  dados,
  campanhas,
}: {
  dados: ResultadoCrmResposta;
  campanhas: LinhaDeCampanha[];
}) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const nomes = new Map(campanhas.map((c) => [c.campanhaId, c.nome]));
  return (
    <section
      className="space-y-3 rounded-md border p-4"
      aria-label={t("Resultados no CRM e Financeiro")}
    >
      <h2 className="text-lg font-semibold">{t("Contatos e vendas por campanha")}</h2>
      <p className="text-sm text-muted-foreground">
        {t(
          "Contatos criados no período pelo anúncio identificado; vendas vinculadas no mesmo período e recebimento líquido até agora.",
        )}
      </p>
      <p className="text-xs text-muted-foreground">{t("Consultado em")} {new Date(dados.consultado_em).toLocaleString(tagDoIdioma)}</p>
      {dados.contatos_vinculados !== null &&
        dados.contatos_vinculados < dados.contatos_atribuidos && (
          <p className="text-sm text-amber-700" role="status">
            {dados.contatos_vinculados} {t("de")} {dados.contatos_atribuidos}{" "}
            {t(
              "contatos atribuídos estão vinculados ao Financeiro; os totais de vendas são parciais.",
            )}
          </p>
        )}
      {dados.financeiro !== "disponivel" && (
        <p role="status" className="text-sm text-amber-700">
          {dados.financeiro === "nao_configurado"
            ? t("Financeiro não configurado: os valores de venda não estão disponíveis.")
            : t("Financeiro indisponível: os valores de venda não estão disponíveis.")}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="p-2">{t("Campanha")}</th>
              <th className="p-2 text-right">{t("Contatos atribuídos")}</th>
              <th className="p-2 text-right">{t("Vendas no Financeiro")}</th>
              <th className="p-2 text-right">{t("Valor vendido")}</th>
              <th className="p-2 text-right">{t("Recebido até agora")}</th>
            </tr>
          </thead>
          <tbody>
            {dados.campanhas.map((linha) => (
              <tr key={linha.campanha_id} className="border-b">
                <td className="p-2">{nomes.get(linha.campanha_id) ?? linha.campanha_id}</td>
                <td className="p-2 text-right">{linha.contatos}</td>
                <td className="p-2 text-right">{linha.vendas ?? "—"}</td>
                <td className="p-2 text-right">{reais(linha.valor_cents)}</td>
                <td className="p-2 text-right">{reais(linha.recebido_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dados.campanhas.length === 0 && (
        <p className="text-sm">{t("Nenhum contato com campanha identificada neste período.")}</p>
      )}
      <p className="text-xs text-muted-foreground">
        {t("Sem campanha identificada")}: {dados.contatos_sem_campanha}.{" "}
        {t("Não somamos esses contatos a uma campanha pelo nome do anúncio.")}
      </p>
    </section>
  );
}
