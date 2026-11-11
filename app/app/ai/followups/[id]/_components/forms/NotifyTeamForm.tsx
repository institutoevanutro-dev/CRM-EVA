"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { TEXTO_DO_AVISO_MAX } from "@/lib/followup/graph-schema";

import type { ConfigOf } from "./shared";

/**
 * O nó `notify_team` — o texto do aviso que abre na Central e vai ao celular
 * de quem ligou o push. Obrigatório para publicar (`texto_do_aviso_ausente`);
 * o `maxLength` é o mesmo teto do schema, então o config nunca sai inválido.
 */
export function NotifyTeamForm({
  config,
  onChange,
}: {
  config: ConfigOf<"notify_team">;
  onChange: (c: ConfigOf<"notify_team">) => void;
}) {
  const t = useT();
  const vazio = config.texto.trim() === "";

  return (
    <div className="space-y-2">
      <Label htmlFor="notify-team-texto">{t("Texto do aviso")}</Label>
      <Input
        id="notify-team-texto"
        value={config.texto}
        maxLength={TEXTO_DO_AVISO_MAX}
        required
        placeholder={t("ex.: Paciente não respondeu ao pós-consulta do dia 15")}
        onChange={(e) => onChange({ texto: e.target.value.slice(0, TEXTO_DO_AVISO_MAX) })}
        aria-invalid={vazio}
        aria-describedby="notify-team-ajuda"
      />
      <div className="flex justify-between gap-2 text-xs">
        <span className={vazio ? "text-error-fg" : "invisible"}>{t("Escreva o texto do aviso.")}</span>
        <span className="tabular-nums text-text-muted">
          {config.texto.length}/{TEXTO_DO_AVISO_MAX}
        </span>
      </div>
      <p id="notify-team-ajuda" className="text-xs text-text-muted">
        {t(
          "Abre um aviso na Central com link para a conversa e avisa no celular quem ligou o push. Nada é enviado ao cliente. Não escreva dados do cliente: o texto aparece na tela bloqueada.",
        )}
      </p>
    </div>
  );
}
