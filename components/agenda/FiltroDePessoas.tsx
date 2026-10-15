"use client";

import { useT } from "@/hooks/i18n/useT";

import { cn } from "@/lib/utils";

import { AvatarDaPessoa } from "./AvatarDaPessoa";
import type { Pessoa } from "./tipos";

/**
 * Quem aparece na grade.
 *
 * Avatares empilhados, e cada um LIGA ou DESLIGA a agenda daquela pessoa.
 * Era isolamento de uma pessoa só ("o que a Ana tem hoje?"); o dono da clínica
 * pediu em 15/10 para ver duas ou três agendas juntas na hora de marcar, e a
 * pergunta de uma pessoa continua custando um clique: com nada selecionado, o
 * primeiro clique mostra só ela. "Todos" zera a seleção.
 *
 * O filtro é só VISTA sobre o que o servidor já devolveu a quem olha: quem não
 * enxerga a agenda de um colega não recebe o colega na lista de pessoas nem os
 * compromissos dele, e selecionar não busca nada novo.
 *
 * O empilhamento com sobreposição (`-space-x-2`) é o que permite oito pessoas
 * caberem ao lado do título sem virar uma barra de rolagem horizontal — e o
 * anel na cor da superfície é o que mantém cada uma legível por cima da outra.
 */
export function FiltroDePessoas({
  pessoas,
  selecionadas,
  onMudar,
  className,
}: {
  pessoas: Pessoa[];
  /** Vazio = todos. */
  selecionadas: readonly string[];
  onMudar: (ids: string[]) => void;
  className?: string;
}) {
  const t = useT();
  // Um filtro com uma opção só não é um filtro — é um enfeite que ocupa espaço
  // e sugere uma escolha inexistente. O produto já faz isso no alternador do
  // inbox ("só aparece com 2+"), e a regra vale igual aqui.
  if (pessoas.length < 2) return null;

  const todos = selecionadas.length === 0;

  return (
    <div
      data-testid="filtro-de-pessoas"
      data-selecionadas={todos ? "todos" : selecionadas.join(",")}
      role="group"
      aria-label={t("Profissionais na agenda")}
      className={cn("flex items-center gap-2", className)}
    >
      <div className="flex -space-x-2">
        {pessoas.map((p) => {
          const marcada = selecionadas.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              data-testid={`botao-pessoa-${p.id}`}
              aria-pressed={marcada}
              aria-label={
                marcada
                  ? `${t("Tirar da agenda:")} ${p.nome}`
                  : `${t("Mostrar a agenda de")} ${p.nome}`
              }
              onClick={() =>
                onMudar(marcada ? selecionadas.filter((id) => id !== p.id) : [...selecionadas, p.id])
              }
              className={cn(
                "rounded-full transition-transform duration-fast ease-out",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500",
                // Sobe 2px em vez de crescer: escala mudaria a sobreposição e
                // faria os vizinhos parecerem se mexer junto.
                marcada ? "-translate-y-0.5" : "hover:-translate-y-0.5",
              )}
            >
              <AvatarDaPessoa pessoa={p} ativo={todos || marcada} />
            </button>
          );
        })}
      </div>

      {!todos && (
        <button
          type="button"
          data-testid="botao-todos"
          onClick={() => onMudar([])}
          className="rounded-sm px-2 py-1 text-xs text-text-muted transition-colors duration-fast hover:bg-surface-elevated hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
        >
          {t("Todos")}
        </button>
      )}
    </div>
  );
}
