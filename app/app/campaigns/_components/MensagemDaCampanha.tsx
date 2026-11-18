"use client";
/**
 * A MENSAGEM da campanha — texto, variáveis, textos salvos e como ela chega.
 *
 * Um componente para criar e editar, pelo mesmo motivo do público: as duas
 * telas eram cópias e divergiam. O que ele resolve (auditoria de 17/11/2026):
 *
 *  - item 25: a variável entra ONDE ESTÁ O CURSOR (colava no fim do texto), e o
 *    balão mostra a mensagem com um nome de exemplo — `{{primeiro_nome}}` cru
 *    não diz a ninguém como a mensagem chega;
 *  - item 20: os textos salvos aparecem na hora de escrever. Antes eles só
 *    existiam na tela de ritmo, onde ninguém escreve campanha.
 */
import { useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { useTextosSalvos } from "@/hooks/campanhas/useConfiguracao";
import { useT } from "@/hooks/i18n/useT";
import {
  DESCRICAO_DA_VARIAVEL,
  VARIAVEIS_DA_CAMPANHA,
  renderizar,
  type VariavelDaCampanha,
} from "@/lib/campanhas/renderizador";
import { CaretDown } from "@/lib/ui/icons";

/** Nome inventado para a prévia. Nunca um nome tirado de contato de verdade. */
const NOME_DE_EXEMPLO = "Ana Souza";

export function MensagemDaCampanha({
  texto,
  onChange,
}: {
  texto: string;
  onChange: (texto: string) => void;
}) {
  const t = useT();
  const campo = useRef<HTMLTextAreaElement>(null);
  const textos = useTextosSalvos();

  function inserir(variavel: VariavelDaCampanha) {
    const token = `{{${variavel}}}`;
    const el = campo.current;
    const inicio = el?.selectionStart ?? texto.length;
    const fim = el?.selectionEnd ?? texto.length;
    onChange(texto.slice(0, inicio) + token + texto.slice(fim));
    // O cursor volta para DEPOIS da variável: quem continua digitando escreve
    // a frase em volta dela, não do fim do texto.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(inicio + token.length, inicio + token.length);
    });
  }

  // Texto salvo nunca apaga o que já foi escrito: entra no lugar do vazio, ou
  // depois do que existe.
  const usarTextoSalvo = (corpo: string) => onChange(texto.trim() === "" ? corpo : `${texto}\n\n${corpo}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{t("Mensagem")}</h2>
        {(textos.data ?? []).length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                {t("Usar texto salvo")}
                <CaretDown size={14} aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 max-w-xs overflow-y-auto">
              {(textos.data ?? []).map((salvo) => (
                <DropdownMenuItem key={salvo.id} onSelect={() => usarTextoSalvo(salvo.body)}>
                  {salvo.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <Textarea
        ref={campo}
        rows={6}
        value={texto}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("Escreva como você falaria com uma pessoa só.")}
        aria-label={t("Texto da mensagem")}
      />
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>{t("Você pode usar:")}</p>
        <ul className="space-y-2">
          {VARIAVEIS_DA_CAMPANHA.map((v) => (
            <li key={v} className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" className="font-mono" onClick={() => inserir(v)}>
                {`{{${v}}}`}
              </Button>
              <span>{t(DESCRICAO_DA_VARIAVEL[v])}</span>
            </li>
          ))}
        </ul>
        <p>{t('Para não depender do dado, ponha um texto de reserva: {{primeiro_nome|"paciente"}}.')}</p>
        <p>
          {t(
            "Quem não tiver o dado que a mensagem usa fica de fora, com o motivo na lista — mensagem com buraco não sai.",
          )}
        </p>
      </div>
      <BalaoDaMensagem texto={texto} />
    </div>
  );
}

/**
 * Como a mensagem chega: um balão de saída, com o nome de exemplo no lugar das
 * variáveis. A saudação sai da hora de agora — e a legenda avisa que ela muda
 * com a hora do envio, para ninguém esperar "Bom dia" às 16h.
 */
export function BalaoDaMensagem({ texto }: { texto: string }) {
  const t = useT();
  const exemplo = useMemo(() => {
    if (texto.trim() === "") return null;
    const fuso = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return renderizar(texto, { nome: NOME_DE_EXEMPLO }, { agora: new Date(), fuso }).texto;
  }, [texto]);
  if (exemplo === null) return null;

  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium">{t("Como chega")}</figcaption>
      <div className="conversa-fundo flex justify-end rounded-lg border border-border p-3">
        <p className="max-w-md rounded-lg rounded-tr-sm bg-[var(--bolha-enviada-fundo,var(--primary))] px-3 py-2 text-sm whitespace-pre-wrap break-words text-[var(--bolha-enviada-texto,var(--primary-foreground))] shadow-xs">
          {exemplo}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("Exemplo com o nome Ana Souza. A saudação segue a hora do envio.")}
      </p>
    </figure>
  );
}
