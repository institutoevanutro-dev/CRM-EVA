"use client";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import {
  useFrasesDeAbertura,
  useSalvarFrasesDeAbertura,
  type FrasesDeAbertura as Frases,
} from "@/hooks/comentarios/useComentarios";

/**
 * As duas frases que o CRM manda no Direct quando um comentário é barrado por
 * PREÇO ou AGENDAMENTO. Elas saem em nome do dono, para uma pessoa prestes a
 * comprar, então o texto tem de ser dele — não nosso.
 *
 * Campo em branco NÃO silencia: volta para o texto de fábrica. Isso é dito na
 * tela, porque um campo vazio lê naturalmente como "não mandar nada" e a
 * diferença aqui é uma mensagem indo ou não para um cliente.
 *
 * Quem decide se o clique em Salvar vale é a rota (papel `manager`); aqui é
 * só o gatilho. Ver `app/api/v1/comentarios/frases/route.ts`.
 */
export function FrasesDeAbertura() {
  const t = useT();
  const { data, isLoading } = useFrasesDeAbertura();
  const salvar = useSalvarFrasesDeAbertura();
  const [rascunho, setRascunho] = useState<Frases | null>(null);

  // O rascunho nasce do que veio do servidor e depois é do usuário: sem esta
  // guarda, o refetch de 30s do painel sobrescreveria o que ele está
  // digitando.
  useEffect(() => {
    if (data && rascunho === null) setRascunho(data.frases);
  }, [data, rascunho]);

  if (isLoading || !rascunho || !data) {
    return <p className="px-3 py-4 text-sm text-text-muted">{t("Carregando…")}</p>;
  }

  const campos: Array<{ chave: keyof Frases; titulo: string; ajuda: string }> = [
    {
      chave: "preco",
      titulo: t("Quando perguntarem preço"),
      ajuda: t("Não cite valor aqui: mensagem automática com preço vira promessa."),
    },
    {
      chave: "agendamento",
      titulo: t("Quando quiserem marcar"),
      ajuda: t("Termine com uma pergunta. É o que faz a pessoa responder."),
    },
  ];

  return (
    <form
      className="flex flex-col gap-4 px-3 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        salvar.mutate(rascunho);
      }}
    >
      <p className="text-sm text-text-muted">
        {t(
          "Comentário que pergunta preço ou quer marcar recebe uma mensagem no Direct para começar a conversa, e continua na fila abaixo para você responder em público se quiser. Assunto de saúde nunca recebe mensagem automática.",
        )}
      </p>

      {campos.map(({ chave, titulo, ajuda }) => (
        <div key={chave} className="flex flex-col gap-1">
          <label className="text-sm font-medium text-text" htmlFor={`frase-${chave}`}>
            {titulo}
          </label>
          <Textarea
            id={`frase-${chave}`}
            rows={3}
            maxLength={1000}
            value={rascunho[chave]}
            placeholder={data.padrao[chave]}
            onChange={(e) => setRascunho({ ...rascunho, [chave]: e.target.value })}
          />
          <p className="text-xs text-text-muted">{ajuda}</p>
        </div>
      ))}

      <p className="text-xs text-text-muted">
        {t("Deixar em branco não desliga a mensagem: volta para o texto de fábrica.")}
      </p>

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={salvar.isPending}>
          {salvar.isPending ? t("Salvando…") : t("Salvar frases")}
        </Button>
      </div>
    </form>
  );
}
