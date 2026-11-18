"use client";

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
 * O foco nasce no "Cancelar", sempre (item 29 da auditoria de 17/11). Ele já
 * nasceu no botão da ação, para `e` + Enter fechar a conversa: quem digitava
 * com o foco fora do campo abria a confirmação com "e" e a confirmava com o
 * espaço seguinte. Confirmar pede um gesto de propósito.
 */
export function ConfirmarNaTela({
  aberto,
  onAbertoChange,
  titulo,
  descricao,
  acao,
  onConfirmar,
  destrutiva = false,
}: {
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  titulo: string;
  descricao?: string;
  acao: string;
  onConfirmar: () => void;
  destrutiva?: boolean;
}) {
  const t = useT();
  return (
    <AlertDialog open={aberto} onOpenChange={onAbertoChange}>
      <AlertDialogContent>
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
