"use client";
/**
 * A confirmação da fusão, uma só para as três portas que juntam fichas (porte
 * do #3640): o grupo forte do `MergeDialog`, o par de "Parecidos — confira" e
 * "Juntar com outra ficha" na ficha. A frase que NOMEIA quem fica e quem é
 * absorvido não existe em três cópias.
 *
 * Quem chama faz a fusão; este componente só pergunta, com os avisos do que a
 * junção faz (`avisosDaJuncao`) quando a comparação os calculou.
 */
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { ResultadoDaFusao } from "@/hooks/contacts/useMergeContacts";

interface Props {
  aberto: boolean;
  onAbertoChange: (aberto: boolean) => void;
  nomeDeQuemFica: string;
  nomesAbsorvidos: string;
  pendente: boolean;
  onConfirmar: () => void;
  /** O que a junção faz com a ficha absorvida, já traduzido. */
  avisos?: string[];
}

/**
 * O porteiro da única ação sem desfazer. Ele NOMEIA os dois lados: o erro que
 * precisa pegar é "escolhi o vencedor errado", e para esse erro "tem certeza?"
 * não serve de nada.
 */
export function ConfirmarJuncao({
  aberto,
  onAbertoChange,
  nomeDeQuemFica,
  nomesAbsorvidos,
  pendente,
  onConfirmar,
  avisos = [],
}: Props) {
  const t = useT();
  return (
    <AlertDialog open={aberto} onOpenChange={onAbertoChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Juntar estes cadastros?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {`${nomeDeQuemFica} ${t("fica.")} ${nomesAbsorvidos} ${t(
              "será absorvido e sai da lista de contatos. Mensagens, negócios e histórico passam para quem fica. Não há como desfazer.",
            )}`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {avisos.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" data-testid="avisos-da-juncao">
            {avisos.map((aviso) => (
              <li key={aviso}>{aviso}</li>
            ))}
          </ul>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pendente}>{t("Cancelar")}</AlertDialogCancel>
          <Button variant="destructive" onClick={onConfirmar} disabled={pendente}>
            {pendente ? t("Juntando…") : t("Juntar contatos")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * O aviso de uma fusão que terminou. O parcial tem voz própria: uma fusão que
 * deixou linhas na lápide não é a mesma coisa que uma fusão limpa. E o que a
 * fusão fez com o atendimento de quem ficou também: parar de receber mensagem,
 * ou uma pausa da IA que não pôde ser aplicada.
 */
export function avisarResultadoDaJuncao(res: ResultadoDaFusao, t: (texto: string) => string): void {
  const pendentes = Object.values(res.nao_repontado).reduce((a, b) => a + b, 0);
  if (pendentes > 0) {
    toast.warning(
      t("Contatos juntados. {n} registro(s) continuaram no cadastro antigo — veja a auditoria.").replace(
        "{n}",
        String(pendentes),
      ),
    );
  } else {
    toast.success(t("Contatos juntados."));
  }
  if (res.bloqueio_herdado) {
    toast.warning(t("Quem ficou passou a não receber mensagens: o outro cadastro tinha pedido para parar."));
  }
  if (res.ia_nao_herdada) {
    toast.warning(t("A pausa da IA do outro cadastro não passou para quem ficou. Pause a IA na ficha de quem ficou."));
  }
}
