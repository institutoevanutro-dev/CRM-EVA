"use client";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { usePalavrasDaIa, useDecidirPalavra } from "@/hooks/comentarios/useComentarios";

/**
 * As palavras que a IA pode usar sozinha.
 *
 * Mostra a palavra e em quantos comentários SEUS ela apareceu, e nada mais.
 * `vezes` conta nos últimos 500 comentários respondidos, não no histórico
 * inteiro: por isso a tela não diz "sempre" nem "no histórico".
 *
 * O comentário de origem foi oferecido ao dono e recusado em favor da tela
 * menor; se aprovação distraída virar problema, é o primeiro ajuste a fazer.
 *
 * Palavra de assunto sensível nunca chega aqui: a lista já vem sem elas, e a
 * rota recusa de novo. Quem decide se o clique vale é a rota (papel `manager`).
 */
export function PalavrasDaIa() {
  const t = useT();
  const { data, isLoading } = usePalavrasDaIa();
  const decidir = useDecidirPalavra();

  if (isLoading || !data) {
    return <p className="px-3 py-4 text-sm text-text-muted">{t("Carregando…")}</p>;
  }

  const liberadas = data.decididas.filter((d) => d.aprovada).length;
  const recusadas = data.decididas.length - liberadas;

  return (
    <div className="flex flex-col gap-3 px-3 py-4">
      <p className="text-sm text-text-muted">
        {t(
          "Estas palavras apareceram em comentários que você respondeu. Liberando uma, a IA passa a responder sozinha os elogios que a usem. Assunto de saúde, preço e agendamento nunca aparecem aqui.",
        )}
      </p>

      {data.candidatos.length === 0 ? (
        <p className="text-sm text-text-muted">
          {t("Nada novo para decidir. As palavras aparecem aqui conforme você responde comentários.")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {data.candidatos.map((c) => (
            <li key={c.palavra} className="flex items-center justify-between gap-2 py-1">
              <span className="text-sm text-text">
                {c.palavra}{" "}
                <span className="text-xs text-text-muted">
                  {t("em")} {c.vezes} {c.vezes === 1 ? t("comentário seu") : t("comentários seus")}
                </span>
              </span>
              <span className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decidir.isPending}
                  onClick={() => decidir.mutate({ palavra: c.palavra, aprovada: true })}
                >
                  {t("Pode usar")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={decidir.isPending}
                  onClick={() => decidir.mutate({ palavra: c.palavra, aprovada: false })}
                >
                  {t("Nunca")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {data.decididas.length > 0 && (
        <details className="text-xs text-text-muted">
          <summary className="cursor-pointer">
            {liberadas} {t("liberadas")}, {recusadas} {t("recusada(s)")}
          </summary>
          {/* Voltar atrás é requisito: decisão que não se desfaz vira medo de
              decidir. A rota faz upsert, então decidir de novo só atualiza a
              linha. */}
          <ul className="mt-2 flex flex-col gap-1">
            {data.decididas.map((d) => (
              <li key={d.palavra} className="flex items-center justify-between gap-2">
                <span>
                  {d.palavra} {d.aprovada ? t("(liberada)") : t("(recusada)")}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={decidir.isPending}
                  onClick={() => decidir.mutate({ palavra: d.palavra, aprovada: !d.aprovada })}
                >
                  {d.aprovada ? t("Nunca") : t("Pode usar")}
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
