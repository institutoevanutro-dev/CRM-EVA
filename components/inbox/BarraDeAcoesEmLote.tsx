"use client";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useT } from "@/hooks/i18n/useT";
import { ConfirmarNaTela } from "@/components/inbox/ConfirmarNaTela";
import { ArrowRight, Archive, Check, EyeSlash, Pause, X } from "@/lib/ui/icons";

interface Props {
  /** Quantas conversas estão marcadas. Zero = a barra não existe. */
  quantidade: number;
  pendente: boolean;
  onFechar: () => void;
  onArquivar: () => void;
  onMarcarComoLida: () => void;
  onPausarIa: () => void;
  /** Ocultar do Inbox os contatos das conversas marcadas (migration 0372). */
  onOcultar: () => void;
  /** Abre o diálogo de destino e devolve `(to_user_id, reason)`. */
  onTransferir: (toUserId: string, reason?: string) => void;
  onLimpar: () => void;
}

/**
 * A barra de ações do lote da Inbox (porte do upstream #2909, fatia F1 de #2484).
 *
 * Ela SÓ EXISTE com seleção: `quantidade === 0` devolve `null`. Uma barra
 * permanente ocuparia a única linha estreita da lista ensinando o olho a
 * ignorá-la, e é justamente a área onde moram as ações de risco.
 *
 * Fechar e Marcar como lida ficam na frente. Arquivar, Pausar o automático e Transferir
 * para... moram no "Mais ações": a coluna da lista é estreita. Devolver ao
 * automático NÃO existe em lote no fork (retomaria a IA com muitos pacientes
 * de uma vez).
 *
 * A organização NÃO passa por aqui: a rota de lote lê a org da sessão. Esta
 * barra só escolhe a ação e os ids já marcados.
 */
export function BarraDeAcoesEmLote({
  quantidade,
  pendente,
  onFechar,
  onArquivar,
  onMarcarComoLida,
  onPausarIa,
  onOcultar,
  onTransferir,
  onLimpar,
}: Props) {
  const t = useT();
  const [transferirAberto, setTransferirAberto] = useState(false);
  const [ocultarAberto, setOcultarAberto] = useState(false);
  // Fechar e Arquivar em lote perguntam antes, com a contagem (item 32): um
  // clique encerrava o atendimento de várias pessoas de uma vez.
  const [confirmando, setConfirmando] = useState<"fechar" | "arquivar" | null>(null);
  const [destino, setDestino] = useState("");
  const [motivo, setMotivo] = useState("");
  const membros = useAssignableMembers(transferirAberto);
  const lista = membros.data ?? [];

  if (quantidade === 0) return null;

  const confirmarTransferencia = () => {
    if (!destino) {
      toast.error(t("Escolha para quem transferir."));
      return;
    }
    onTransferir(destino, motivo.trim() || undefined);
    setTransferirAberto(false);
    setDestino("");
    setMotivo("");
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface-elevated px-3 py-2"
      role="toolbar"
      aria-label={t("Ações em lote")}
      data-testid="barra-de-acoes-em-lote"
    >
      <span className="mr-1 text-xs font-medium text-text-muted">
        {quantidade === 1
          ? t("1 conversa selecionada")
          : `${quantidade} ${t("conversas selecionadas")}`}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={pendente}
        onClick={() => setConfirmando("fechar")}
        data-testid="lote-fechar"
      >
        {t("Fechar")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pendente}
        onClick={onMarcarComoLida}
        data-testid="lote-marcar-como-lida"
      >
        {t("Marcar como lida")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={pendente}>
            {t("Mais ações")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{t("Ações em lote")}</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => setConfirmando("arquivar")}
            data-testid="lote-arquivar"
          >
            <Archive size={14} className="mr-2" aria-hidden />
            {t("Arquivar")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onPausarIa} data-testid="lote-pausar-ia">
            <Pause size={14} className="mr-2" aria-hidden />
            {t("Pausar o automático")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setOcultarAberto(true)} data-testid="lote-ocultar">
            <EyeSlash size={14} className="mr-2" aria-hidden />
            {t("Ocultar do Inbox")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => setTransferirAberto(true)}
            data-testid="lote-transferir"
          >
            <ArrowRight size={14} className="mr-2" aria-hidden />
            {t("Transferir para…")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="sm"
        variant="ghost"
        onClick={onLimpar}
        className="ml-auto"
        aria-label={t("Limpar seleção")}
        data-testid="lote-limpar"
      >
        <X size={14} aria-hidden />
      </Button>

      <ConfirmarNaTela
        aberto={confirmando !== null}
        onAbertoChange={(aberto) => !aberto && setConfirmando(null)}
        titulo={
          confirmando === "arquivar"
            ? quantidade === 1
              ? t("Arquivar 1 conversa?")
              : t("Arquivar {n} conversas?").replace("{n}", String(quantidade))
            : quantidade === 1
              ? t("Fechar 1 conversa?")
              : t("Fechar {n} conversas?").replace("{n}", String(quantidade))
        }
        descricao={
          confirmando === "arquivar"
            ? t("Os atendimentos terminam e as conversas vão para o histórico. Se o paciente escrever de novo, a conversa volta.")
            : t("Os atendimentos terminam. Se o paciente escrever de novo, a conversa volta para a fila, e o automático pode responder.")
        }
        acao={confirmando === "arquivar" ? t("Arquivar") : t("Fechar conversas")}
        onConfirmar={() => (confirmando === "arquivar" ? onArquivar() : onFechar())}
      />

      <AlertDialog open={ocultarAberto} onOpenChange={setOcultarAberto}>
        <AlertDialogContent className="sm:max-w-md" data-testid="lote-ocultar-dialogo">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {quantidade === 1
                ? t("Ocultar do Inbox o contato da conversa selecionada?")
                : `${t("Ocultar do Inbox os contatos de")} ${quantidade} ${t("conversas selecionadas")}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "As conversas dessas pessoas saem da Fila, das contagens e do Início. O automático não responde e nenhuma mensagem automática sai. Nada é apagado: as mensagens continuam guardadas, e um gestor pode trazê-las de volta em Mais › Ocultos.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="lote-ocultar-confirmar"
              onClick={() => {
                onOcultar();
                setOcultarAberto(false);
              }}
            >
              {t("Ocultar do Inbox")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={transferirAberto}
        onOpenChange={(v) => {
          setTransferirAberto(v);
          if (!v) {
            setDestino("");
            setMotivo("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {quantidade === 1
                ? t("Transferir a conversa selecionada")
                : `${t("Transferir")} ${quantidade} ${t("conversas selecionadas")}`}
            </DialogTitle>
            <DialogDescription>
              {t("Cada conversa é transferida pelo mesmo caminho de sempre, com evento e auditoria próprios.")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="lote-destino">{t("Para quem")}</Label>
              <Select value={destino} onValueChange={setDestino}>
                <SelectTrigger id="lote-destino">
                  <SelectValue placeholder={t("Escolha um atendente")} />
                </SelectTrigger>
                <SelectContent>
                  {lista.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name ?? m.user_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!membros.isLoading && lista.length === 0 && (
                <p className="text-xs text-text-subtle">
                  {t("Nenhum atendente disponível para transferir.")}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lote-motivo">{t("Motivo (opcional)")}</Label>
              <Textarea
                id="lote-motivo"
                value={motivo}
                maxLength={500}
                onChange={(e) => setMotivo(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTransferirAberto(false)}>
              {t("Cancelar")}
            </Button>
            <Button
              onClick={confirmarTransferencia}
              disabled={pendente || destino.length === 0}
              data-testid="lote-transferir-confirmar"
            >
              <Check size={14} className="mr-1.5" aria-hidden />
              {t("Transferir")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
