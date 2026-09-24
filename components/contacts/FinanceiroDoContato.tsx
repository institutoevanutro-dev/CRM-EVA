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
  const dados = carregando ? null : resultado?.dados;
  const erro = !carregando && resultado?.erro;
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
      {carregando ? <p role="status">{t("Consultando o financeiro…")}</p> : null}
      {erro ? (
        <p role="alert">
          {t("Não foi possível consultar o financeiro. Use Atualizar para tentar novamente.")}
        </p>
      ) : null}
      {dados && !dados.configurada ? (
        <p>
          {t(
            "Integração não configurada para esta organização. Solicite a configuração ao administrador.",
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
                        {p.numero ?? t("Rascunho")} · {t(rotulo[p.status]!)}
                      </a>
                      <span>{brl(p.total_cents)}</span>
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
                        {v.numero} · {t(rotulo[v.situacao]!)}
                      </a>
                      <p className="text-sm">
                        {t("Total")} {brl(v.total_cents)} · {t("Recebido")} {brl(v.recebido_cents)}{" "}
                        · {t("A receber")} {brl(v.saldo_cents)}
                      </p>
                    </li>
                  ))}
                </ul>
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
