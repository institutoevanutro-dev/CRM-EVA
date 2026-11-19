"use client";
import Link from "next/link";
import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { ROTULO_DA_SITUACAO, type SituacaoDoAgendamento } from "@/lib/agenda/tipos";
import type { ConsultaDoContato } from "@/lib/types/contacts";

/**
 * As consultas do paciente, no topo da ficha: as próximas e as últimas que o
 * GET do contato trouxe (`consultasDoContato` no handler). Cada linha abre o
 * compromisso na Agenda. `null` = a leitura falhou, e a ficha diz isso em vez
 * de "nenhuma consulta".
 */
export function ConsultasDoContato({
  consultas,
  agora = new Date(),
}: {
  consultas: ConsultaDoContato[] | null | undefined;
  agora?: Date;
}) {
  const t = useT();
  const locale = useLocaleDeData();
  if (consultas === undefined) return null;

  const proximas = (consultas ?? []).filter((c) => new Date(c.starts_at) >= agora);
  const ultimas = (consultas ?? []).filter((c) => new Date(c.starts_at) < agora);

  const linha = (c: ConsultaDoContato) => (
    <li key={c.id}>
      <Link
        href={`/app/agenda?compromisso=${c.id}`}
        className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
      >
        <span className="font-medium tabular-nums">
          {format(new Date(c.starts_at), "dd/MM/yyyy HH:mm", { locale })}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.title}</span>
        {c.status in ROTULO_DA_SITUACAO && (
          <Badge variant={c.status === "no_show" ? "warning" : "neutral"}>
            {t(ROTULO_DA_SITUACAO[c.status as SituacaoDoAgendamento])}
          </Badge>
        )}
      </Link>
    </li>
  );

  return (
    <Card className="space-y-2 p-4" data-testid="consultas-do-contato">
      <h2 className="text-sm font-semibold">{t("Consultas")}</h2>
      {consultas === null ? (
        <p className="text-sm text-error-fg">{t("Não deu para carregar as consultas.")}</p>
      ) : consultas.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhuma consulta marcada.")}</p>
      ) : (
        <div className="space-y-2">
          {proximas.length > 0 && (
            <div>
              <h3 className="px-2 text-xs uppercase text-muted-foreground">{t("Próximas")}</h3>
              <ul>{proximas.map(linha)}</ul>
            </div>
          )}
          {ultimas.length > 0 && (
            <div>
              <h3 className="px-2 text-xs uppercase text-muted-foreground">{t("Últimas")}</h3>
              <ul>{ultimas.map(linha)}</ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
