"use client";

import { useT } from "@/hooks/i18n/useT";
import { ehNomeCompleto } from "@/lib/contacts/rotulo-do-contato";
import { cn } from "@/lib/utils";

/**
 * "Nome completo do paciente", para quem só tem o nome do WhatsApp.
 *
 * O prontuário abre o atendimento pelo nome do CADASTRO (`contacts.name`) e
 * recusa sem ele. O nome do WhatsApp (`display_name`) costuma ser o primeiro
 * nome ou um apelido: ele chega aqui pré-preenchido para a recepção conferir e
 * completar, e só vai para o cadastro depois que uma pessoa olhou.
 *
 * Dois lugares usam o campo: o "Novo agendamento", que grava o nome ao
 * confirmar, e o painel do compromisso que a IA, a API ou o Google marcaram,
 * que grava no "Salvar nome".
 */
export function NomeCompletoDoPaciente({
  id,
  valor,
  onValor,
}: {
  id: string;
  valor: string;
  onValor: (valor: string) => void;
}) {
  const t = useT();
  const valido = ehNomeCompleto(valor);
  return (
    <div data-testid="nome-completo-do-paciente">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-text-muted">
        {t("Nome completo do paciente")} *
      </label>
      <input
        id={id}
        data-testid="campo-nome-completo"
        type="text"
        autoComplete="off"
        maxLength={200}
        value={valor}
        onChange={(e) => onValor(e.target.value)}
        aria-invalid={!valido || undefined}
        aria-describedby={`${id}-ajuda`}
        className={cn(
          "h-10 w-full rounded-md border border-border bg-surface px-2.5 text-sm text-text outline-hidden transition-colors focus:border-accent",
          !valido && "border-warning",
        )}
      />
      <p
        id={`${id}-ajuda`}
        className={cn("mt-1 text-xs", valido ? "text-text-muted" : "text-warning")}
      >
        {valido
          ? t("Vai para o cadastro do paciente. Confira nome e sobrenome.")
          : t("Escreva nome e sobrenome.")}
      </p>
    </div>
  );
}
