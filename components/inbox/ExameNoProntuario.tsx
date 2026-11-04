"use client";
/**
 * A fatia do balão que leva o exame ao Prontuário: botão, "Enviando…", selo
 * "No prontuário" com quem e quando VISÍVEIS, dica de formato/tamanho/arquivo
 * que não chegou, e o erro escrito embaixo do botão (o toast some em 4 s).
 *
 * O selo aparece para qualquer papel; o resto só para quem recebe `onEnviar`
 * (quem decide é o `InboxLayout`). A regra de qual estado mora em
 * `lib/prontuario/exames.ts` (`situacaoDoExame`).
 */
import { format } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { situacaoDoExame } from "@/lib/prontuario/exames";
import type { Message } from "@/lib/types/messaging";
import { CheckCircle, CircleNotch, PaperPlaneTilt } from "@/lib/ui/icons";

interface Props {
  message: Message;
  agora: number;
  onEnviar?: (m: Message) => void;
  enviando?: boolean;
  quemEnviou?: string | null;
  erro?: string | null;
}

export function ExameNoProntuario({ message, agora, onEnviar, enviando = false, quemEnviou = null, erro = null }: Props) {
  const t = useT();
  const locale = useLocaleDeData();
  const selo = message.prontuario_exame;

  if (selo) {
    const data = format(new Date(selo.enviado_em), "Pp", { locale });
    const nome = quemEnviou?.trim() || null;
    const curto = selo.ja_existia
      ? t("já estava lá · conferido por {nome} · {data}").replace("{nome}", () => nome ?? "—").replace("{data}", () => data)
      : nome
        ? t("por {nome} · {data}").replace("{nome}", () => nome).replace("{data}", () => data)
        : data;
    const longo = selo.ja_existia
      ? t("Já estava no prontuário (conferido por {nome} em {data})").replace("{nome}", () => nome ?? "—").replace("{data}", () => data)
      : nome
        ? t("Enviado ao prontuário por {nome} em {data}").replace("{nome}", () => nome).replace("{data}", () => data)
        : t("Enviado ao prontuário em {data}").replace("{data}", () => data);
    return (
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1" title={longo} data-testid="selo-do-prontuario">
        <Badge variant="success" className="gap-1">
          <CheckCircle size={14} weight="bold" aria-hidden />
          {t("No prontuário")}
        </Badge>
        <span className="text-xs text-muted-foreground">{curto}</span>
      </div>
    );
  }

  if (!onEnviar) return null;
  const situacao = situacaoDoExame(message, agora);
  if (!situacao) return null;

  if (situacao === "formato")
    return <p className="mt-1 text-xs text-muted-foreground">{t("Peça ao paciente um PDF ou foto comum")}</p>;
  if (situacao === "grande")
    return <p className="mt-1 text-xs text-muted-foreground">{t("Arquivo maior que 10 MB: peça ao paciente um arquivo menor")}</p>;
  if (situacao === "falhou")
    return (
      <p className="mt-1 text-xs text-muted-foreground">
        {t("O arquivo não chegou inteiro ao CRM. Peça ao paciente para enviar de novo.")}
      </p>
    );

  return (
    <div className="mt-1 flex flex-col items-start gap-1">
      {enviando ? (
        <Button size="default" variant="secondary" disabled aria-busy="true" title={t("Enviando ao prontuário…")}>
          <CircleNotch className="motion-safe:animate-spin" aria-hidden />
          {t("Enviando…")}
        </Button>
      ) : (
        <Button size="default" variant="secondary" onClick={() => onEnviar(message)} data-testid="enviar-ao-prontuario">
          <PaperPlaneTilt aria-hidden />
          {t("Enviar ao prontuário")}
        </Button>
      )}
      {erro && !enviando ? (
        <p className="text-xs text-destructive" role="alert" data-testid="erro-ao-prontuario">
          {erro}
        </p>
      ) : null}
    </div>
  );
}
