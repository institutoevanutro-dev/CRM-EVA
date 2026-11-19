"use client";
import { useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ResumoFinanceiro } from "@/lib/integrations/financeiro/cliente";
type Dados =
  | { configurada: false }
  | { configurada: true; resumo: ResumoFinanceiro | null; abrir_url: string; base_url: string };
const brl = (v: string) => {
  const n = BigInt(v);
  return `R$ ${(n / 100n).toLocaleString("pt-BR")},${(n % 100n).toString().padStart(2, "0")}`;
};
/** Lê só AAAA-MM-DD; o que não for data aparece como veio, nunca "Invalid Date". */
function dataDoSinal(data: string, idioma: string): string {
  const d = new Date(`${data.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? data : d.toLocaleDateString(idioma, { timeZone: "UTC" });
}

const rotulo: Record<string, string> = {
  em_aberto: "Em aberto",
  quitada: "Quitada",
  atrasada: "Atrasada",
  cancelada: "Cancelada",
  rascunho: "Rascunho",
  enviada: "Enviada",
  aprovada: "Aprovada",
  recusada: "Recusada",
  expirada: "Expirada",
  aberto: "Em aberto",
  usado: "Usado numa venda",
  retido: "Retido (paciente faltou)",
  estornado: "Estornado",
};
export function FinanceiroDoContato({ contactId }: { contactId: string }) {
  const idioma = useTagDeIdioma();
  const t = useT();
  const [rodada, setRodada] = useState(0);
  const chave = `${contactId}:${rodada}`;
  const [resultado, setResultado] = useState<{
    chave: string;
    dados: Dados | null;
    erro: boolean;
  } | null>(null);
  const carregando = resultado?.chave !== chave;
  // Ao recarregar, o quadro anterior fica na tela até a resposta nova chegar
  // (antes ele sumia e voltava). Depois de uma falha não há quadro antigo:
  // número velho ao lado de "não foi possível" leria como atual.
  const dados = resultado?.erro ? null : resultado?.dados;
  const erro = !carregando && resultado?.erro;
  const hoje = new Date().toISOString().slice(0, 10);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/contacts/${contactId}/financeiro`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const body = await r.json();
        if (!controller.signal.aborted) setResultado({ chave, dados: body.data, erro: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResultado({ chave, dados: null, erro: true });
      });
    return () => controller.abort();
  }, [contactId, chave]);
  return (
    <Card className="space-y-4 p-4" aria-label={t("Financeiro do contato")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("Propostas, vendas e pagamentos")}</h2>
        <Button variant="outline" disabled={carregando} onClick={() => setRodada((r) => r + 1)}>
          {t("Atualizar")}
        </Button>
      </div>
      {carregando && !dados ? <p role="status">{t("Consultando o financeiro…")}</p> : null}
      {erro ? (
        <p role="alert">
          {t("Não foi possível consultar o financeiro. Use Atualizar para tentar novamente.")}
        </p>
      ) : null}
      {dados && !dados.configurada ? (
        <p>
          {t(
            "A ligação com o financeiro não está configurada nesta instalação. Quem liga é quem cuida do servidor.",
          )}
        </p>
      ) : null}
      {dados?.configurada ? (
        <>
          <a
            className="text-primary underline"
            href={dados.abrir_url}
            target="_blank"
            rel="noreferrer"
          >
            {t("Abrir no financeiro")}
          </a>
          <p className="text-sm text-muted-foreground">
            {t(
              "Propostas, vendas e pagamentos são registrados no financeiro, com as permissões de cada usuário.",
            )}
          </p>
          {!dados.resumo ? (
            <p>
              {t(
                "Este contato ainda não está vinculado a um paciente do financeiro. Abra o financeiro para conferir e vincular o cadastro.",
              )}
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {t("Consultado em")} {new Date(dados.resumo.consultado_em).toLocaleString(idioma)}
                {". "}
                {t("Atualize após registrar alterações no financeiro.")}
              </p>
              <h3 className="font-semibold">{t("Propostas")}</h3>
              {!dados.resumo.propostas.length ? (
                <p>{t("Nenhuma proposta registrada.")}</p>
              ) : (
                <ul className="space-y-2">
                  {dados.resumo.propostas.map((p) => (
                    <li key={p.id} className="flex flex-wrap justify-between gap-2 border-b py-2">
                      <a
                        className="underline"
                        href={`${dados.base_url}/propostas/${p.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {p.numero ?? t("Rascunho")} ·{" "}
                        {/* Enviada e já vencida não é mais "Enviada": o paciente não pode aceitar. */}
                        {p.status === "enviada" && p.validade && p.validade.slice(0, 10) < hoje
                          ? t("Vencida")
                          : t(rotulo[p.status]!)}
                      </a>
                      <span className="flex flex-wrap gap-x-3">
                        {p.validade ? (
                          <span className="text-sm text-muted-foreground">
                            {t("vale até")} {dataDoSinal(p.validade, idioma)}
                          </span>
                        ) : null}
                        <span>{brl(p.total_cents)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="font-semibold">{t("Vendas e pagamentos")}</h3>
              {!dados.resumo.vendas.length ? (
                <p>{t("Nenhuma venda registrada.")}</p>
              ) : (
                <ul className="space-y-3">
                  {dados.resumo.vendas.map((v) => (
                    <li key={v.id} className="space-y-1 border-b py-2">
                      <a
                        className="underline"
                        href={`${dados.base_url}/vendas/${v.id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {v.numero} ·{" "}
                        <span className={v.situacao === "atrasada" ? "font-semibold text-error-fg" : undefined}>
                          {t(rotulo[v.situacao]!)}
                        </span>
                      </a>
                      {v.data ? (
                        <p className="text-sm text-muted-foreground">
                          {t("Vendida em")} {dataDoSinal(v.data, idioma)}
                        </p>
                      ) : null}
                      <p className="text-sm">
                        {t("Total")} {brl(v.total_cents)} · {t("Recebido")} {brl(v.recebido_cents)}{" "}
                        · {t("A receber")} {brl(v.saldo_cents)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="font-semibold">{t("Sinais")}</h3>
              {!(dados.resumo.sinais ?? []).length ? (
                <p>{t("Nenhum sinal registrado.")}</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      "O sinal entra no faturamento no dia em que o paciente paga; a venda que usa o sinal entra só pelo restante.",
                    )}
                  </p>
                  <ul className="space-y-2" data-testid="sinais-do-contato">
                    {(dados.resumo.sinais ?? []).map((s) => (
                      <li key={s.id} className="flex flex-wrap justify-between gap-2 border-b py-2">
                        <span>
                          {dataDoSinal(s.data, idioma)} · {t(rotulo[s.situacao]!)}
                        </span>
                        <span>{brl(s.valor_cents)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {dados.resumo.limitado ? (
                <p>
                  {t(
                    "Mostrando até 100 propostas e 100 vendas recentes. Consulte o histórico completo no financeiro.",
                  )}
                </p>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </Card>
  );
}
