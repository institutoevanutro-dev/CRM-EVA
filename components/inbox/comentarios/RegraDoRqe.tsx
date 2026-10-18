"use client";
import { useId } from "react";

import { Switch } from "@/components/ui/switch";
import { useRegraDoRqe, useSalvarRegraDoRqe } from "@/hooks/comentarios/useComentarios";
import { useT } from "@/hooks/i18n/useT";

/**
 * A chave "Médico sem RQE" da aba Comentários (migration 0381).
 *
 * Ligada, que é como toda organização nasce e como estava antes de a regra ser
 * configurável, a IA nunca chama ninguém de especialista ou nutrólogo nas
 * respostas aos comentários, e comentário sobre especialidade espera você.
 * Desligada, essas palavras deixam de ser trava, e o dono pode liberá-las em
 * "Palavras da IA".
 *
 * Só o administrador chega aqui (o painel esconde dos outros papéis). Quem
 * decide se o clique vale é a rota (`app/api/v1/comentarios/regra-do-rqe`) e a
 * função do banco, que conferem o papel de novo.
 */
export function RegraDoRqe() {
  const t = useT();
  const idDoRotulo = useId();
  const { data, isLoading, isError } = useRegraDoRqe();
  const salvar = useSalvarRegraDoRqe();

  if (isError) {
    return (
      <p className="px-3 py-4 text-sm text-text-muted">
        {t("Não foi possível carregar a regra. Atualize a página para tentar de novo.")}
      </p>
    );
  }

  if (isLoading || !data) {
    return <p className="px-3 py-4 text-sm text-text-muted">{t("Carregando…")}</p>;
  }

  // Enquanto salva, a chave mostra o que foi pedido; depois, o que o servidor devolveu.
  const ligada = salvar.isPending && salvar.variables !== undefined ? salvar.variables : data.ligada;

  return (
    <div className="flex flex-col gap-2 px-3 py-4">
      <div className="flex items-center gap-3">
        <Switch
          checked={ligada}
          onCheckedChange={(valor) => salvar.mutate(valor)}
          disabled={salvar.isPending}
          aria-labelledby={idDoRotulo}
        />
        <span id={idDoRotulo} className="text-sm font-medium text-text">
          {t("Médico sem RQE")}
        </span>
      </div>
      <p className="text-xs text-text-muted">
        {t(
          "Ligada, a IA nunca chama ninguém de especialista ou nutrólogo nas respostas aos comentários. Desligue se o médico da clínica tem RQE ou se a clínica não é médica, como uma clínica odontológica.",
        )}
      </p>
    </div>
  );
}
