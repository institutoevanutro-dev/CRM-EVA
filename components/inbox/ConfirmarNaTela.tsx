"use client";

import { useRef } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Confirmação na própria tela para o que não tem volta limpa (I6, passo 1).
 *
 * Substitui o `confirm()` do navegador: a caixa cinza não diz a consequência,
 * não segue o tema e, no celular, aparece com o endereço do site no título.
 * Quem chama decide o texto — a frase tem de dizer o que ACONTECE.
 *
 * `focoNaAcao`: o foco nasce no botão da ação, não no "Cancelar". É o que
 * mantém o atalho `e` seguido de Enter fechando a conversa, como sempre foi.
 * Ação que apaga para sempre (excluir nota) não liga isto.
 */
export function ConfirmarNaTela({
  aberto,
  onAbertoChange,
  titulo,
  descricao,
  acao,
  onConfirmar,
  focoNaAcao = false,
  destrutiva = false,
}: {
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  titulo: string;
  descricao?: string;
  acao: string;
  onConfirmar: () => void;
  focoNaAcao?: boolean;
  destrutiva?: boolean;
}) {
  const t = useT();
  const acaoRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog open={aberto} onOpenChange={onAbertoChange}>
      <AlertDialogContent
        onOpenAutoFocus={
          focoNaAcao
            ? (e) => {
                e.preventDefault();
                acaoRef.current?.focus();
              }
            : undefined
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{titulo}</AlertDialogTitle>
          {/* Sem frase, o Radix ainda pede a descrição: vazia e escondida. */}
          <AlertDialogDescription className={descricao ? undefined : "sr-only"}>
            {descricao ?? titulo}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
          <Button
            ref={acaoRef}
            variant={destrutiva ? "destructive" : "default"}
            onClick={() => {
              onAbertoChange(false);
              onConfirmar();
            }}
          >
            {acao}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
