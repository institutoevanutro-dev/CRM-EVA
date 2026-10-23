"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A seção RECOLHÍVEL do dossiê e o estado lembrado dela (upstream #3181).
 *
 * O estado é POR NAVEGADOR (`localStorage`), como a visão do funil
 * (`lib/kanban/visao-do-funil.ts`): é preferência de quem olha, não dado do
 * negócio. Uma preferência da ORGANIZAÇÃO faria quem recolhe uma seção mudar a
 * tela de todo mundo. O custo declarado: a escolha não atravessa máquinas nem
 * navegadores da mesma pessoa. Sem schema, sem rota.
 *
 * Guarda-se o CONJUNTO DOS FECHADOS: sem nada salvo, tudo abre. Guardar os
 * abertos faria "sem preferência" virar "tudo fechado".
 *
 * Começa vazio em toda renderização e só lê o storage depois do mount: ler no
 * inicializador do `useState` daria HTML diferente no servidor e no cliente.
 */
export const CHAVE_DAS_SECOES_RECOLHIDAS = "dossie:secoes-recolhidas";

/**
 * As seções recolhíveis do dossiê do fork. O upstream tem também "contato"
 * (bloco `ContatoDoNegocio`), que o fork não tem. Tarefas fica de fora:
 * é trabalho em curso, não consulta.
 */
export type IdDeSecao = "dados-do-negocio" | "linha-do-tempo";

function gravar(fechadas: Set<string>): void {
  try {
    window.localStorage.setItem(CHAVE_DAS_SECOES_RECOLHIDAS, JSON.stringify([...fechadas]));
  } catch {
    // Storage bloqueado (aba privada, política de cookies): o clique continua
    // valendo nesta sessão; só não sobrevive a um F5.
  }
}

export interface SecoesRecolhiveis {
  fechadas: Set<string>;
  alternar: (id: IdDeSecao) => void;
  /** Abre a seção sem fechar nenhuma (o atalho "Editar campos"). */
  abrir: (id: IdDeSecao) => void;
}

export function useSecoesRecolhidas(): SecoesRecolhiveis {
  const [fechadas, setFechadas] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    try {
      const salvo: unknown = JSON.parse(
        window.localStorage.getItem(CHAVE_DAS_SECOES_RECOLHIDAS) ?? "[]",
      );
      if (Array.isArray(salvo) && salvo.length > 0) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- o armazenamento só existe no cliente.
        setFechadas(new Set(salvo.filter((s): s is string => typeof s === "string")));
      }
    } catch {
      // Valor corrompido ou storage bloqueado: tudo aberto, que é o padrão.
    }
  }, []);

  const alternar = useCallback((id: IdDeSecao) => {
    setFechadas((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      gravar(next);
      return next;
    });
  }, []);

  const abrir = useCallback((id: IdDeSecao) => {
    setFechadas((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      gravar(next);
      return next;
    });
  }, []);

  return { fechadas, alternar, abrir };
}

interface Props {
  id: IdDeSecao;
  /** O título JÁ traduzido: quem chama escreve `t("...")` com o literal. */
  titulo: string;
  recolhida: boolean;
  aoAlternar: (id: IdDeSecao) => void;
  children: ReactNode;
  /**
   * O que mostrar RECOLHIDA, quando mostrar nada não serve (a linha do tempo:
   * as três entradas mais recentes e o "ver tudo"). Sem esta prop o corpo fica
   * MONTADO e escondido, nunca desmontado: fechar "Dados do negócio" no meio de
   * uma edição não pode descartar o que já foi digitado.
   */
  conteudoRecolhido?: ReactNode;
  className?: string;
}

export function SecaoDoDossie({
  id,
  titulo,
  recolhida,
  aoAlternar,
  children,
  conteudoRecolhido,
  className,
}: Props) {
  const temConteudoRecolhido = conteudoRecolhido !== undefined;

  return (
    <section
      // QUAL seção, em que ORDEM e se está fechada: o que o teste mede, sem
      // depender de classe de estilo.
      data-secao={id}
      data-recolhida={recolhida ? "sim" : "nao"}
      className={cn("border-b border-border py-3", className)}
    >
      <h3 className="mb-2">
        {/* `uppercase` no próprio botão: o estilo do navegador zera o
            `text-transform` herdado em <button>. */}
        <button
          type="button"
          onClick={() => aoAlternar(id)}
          aria-expanded={!recolhida}
          className="flex w-full items-center gap-2 text-left text-xs font-medium uppercase tracking-wide text-text-muted hover:text-text"
        >
          <span>{titulo}</span>
          {/* `+` fechado, `−` aberto; quem fala a verdade para o leitor de
              tela é o `aria-expanded`. */}
          <span aria-hidden className="ml-auto text-[10px]">
            {recolhida ? "+" : "−"}
          </span>
        </button>
      </h3>
      <div hidden={recolhida && !temConteudoRecolhido}>
        {recolhida && temConteudoRecolhido ? conteudoRecolhido : children}
      </div>
    </section>
  );
}
