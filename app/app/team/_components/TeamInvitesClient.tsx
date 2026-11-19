"use client";

import { useState } from "react";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useTeamInvites, type TeamInvite } from "@/hooks/team/useTeamInvites";
import { useResendInvite } from "@/hooks/team/useResendInvite";
import { useRevokeInvite } from "@/hooks/team/useRevokeInvite";
import { Badge } from "@/components/ui/badge";
import { ROTULO_DO_PAPEL } from "@/lib/auth/types";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowsClockwise, Copy, DotsThree, Warning } from "@/lib/ui/icons";
import { copyToClipboard } from "@/lib/clipboard";
import type { StatusConvite } from "@/lib/team/convite-status";

function rotuloDoPapel(role: string): string {
  return (ROTULO_DO_PAPEL as Record<string, string>)[role] ?? role;
}

interface Props {
  /** admin: mostra as ações de reenviar/revogar. Manager só lê. */
  canManage: boolean;
}

/**
 * No celular a tabela de 9 colunas rolava de lado e o "⋯" ficava fora da tela.
 * Lá ficam só e-mail, papel, status e ações; o resto aparece do `md` para cima.
 */
const SO_NO_COMPUTADOR = "hidden md:table-cell";

const BADGE_VARIANT: Record<StatusConvite, "default" | "outline" | "secondary" | "destructive"> = {
  aceito: "default",
  pendente: "outline",
  expirado: "secondary",
  revogado: "destructive",
};

export function TeamInvitesClient({ canManage }: Props) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { data, isLoading, isError } = useTeamInvites();
  const resend = useResendInvite();
  const revoke = useRevokeInvite();

  const [revokeDialog, setRevokeDialog] = useState<TeamInvite | null>(null);

  const STATUS_LABEL: Record<StatusConvite, string> = {
    aceito: t("Aceito"),
    pendente: t("Pendente"),
    expirado: t("Expirado"),
    revogado: t("Revogado"),
  };

  async function copyLink(url: string) {
    // Helper do repo (funciona em http://IP, self-host sem TLS), nunca a API crua.
    if (await copyToClipboard(url)) toast.success(t("Link do convite copiado."));
    else toast.error(t("Não foi possível copiar. Copie da barra do navegador."));
  }

  // Reenviar renova o prazo. Diz a verdade sobre o e-mail: sem envio
  // configurado, o caminho é copiar o link novo e mandar por fora.
  async function reenviar(id: string) {
    try {
      const res = await resend.mutateAsync(id);
      const url = res.data.accept_url;
      if (res.data.email_dispatched) toast.success(t("Convite reenviado por e-mail."));
      else if (url)
        toast.warning(t("Convite renovado, mas o e-mail não saiu. Copie o link e envie você."), {
          action: { label: t("Copiar link"), onClick: () => void copyLink(url) },
        });
    } catch {
      /* showApiError já disparou */
    }
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  }
  if (isError) {
    return <p className="text-sm text-destructive">{t("Erro ao carregar convites.")}</p>;
  }
  const invites = data?.data ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{t("Convites")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Convites enviados e seu status. Um convite aceito vira membro na lista acima.")}
        </p>
      </div>

      {invites.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhum convite enviado.")}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("E-mail")}</TableHead>
                <TableHead>{t("Papel")}</TableHead>
                <TableHead className={SO_NO_COMPUTADOR}>{t("Interface")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("E-mail enviado")}</TableHead>
                <TableHead className={SO_NO_COMPUTADOR}>{t("Enviado em")}</TableHead>
                <TableHead className={SO_NO_COMPUTADOR}>{t("Expira em")}</TableHead>
                <TableHead className={SO_NO_COMPUTADOR}>{t("Convidado por")}</TableHead>
                {canManage ? <TableHead className="w-[60px]" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.map((inv) => {
                const emAberto = inv.status === "pendente" || inv.status === "expirado";
                return (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t(rotuloDoPapel(inv.role))}</Badge>
                    </TableCell>
                    <TableCell className={`text-sm ${SO_NO_COMPUTADOR}`}>
                      {inv.interface_settings?.destinos
                        ? t("Personalizada")
                        : inv.interface_settings?.preset === "simplificada"
                          ? t("Simplificada")
                          : t("Completa")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={BADGE_VARIANT[inv.status]}>{STATUS_LABEL[inv.status]}</Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {inv.email_dispatched ? (
                        <span className="text-sm text-muted-foreground">{t("Sim")}</span>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <span className="flex items-center gap-1 text-sm text-destructive">
                            <Warning size={14} weight="fill" />
                            {t("Não saiu")}
                          </span>
                          {inv.accept_url ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 w-fit gap-1 text-xs"
                              onClick={() => copyLink(inv.accept_url!)}
                            >
                              <Copy size={13} />
                              {t("Copiar link")}
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className={`text-sm text-muted-foreground ${SO_NO_COMPUTADOR}`}>
                      {new Date(inv.last_sent_at).toLocaleString(tagDoIdioma, { dateStyle: "short", timeStyle: "short" })}
                      {inv.resend_count > 0 ? (
                        <span className="ml-1 text-xs">
                          ({t("reenviado")} {inv.resend_count}×)
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className={`text-sm text-muted-foreground ${SO_NO_COMPUTADOR}`}>
                      {inv.status === "aceito"
                        ? "—"
                        : new Date(inv.expires_at).toLocaleString(tagDoIdioma, { dateStyle: "short", timeStyle: "short" })}
                    </TableCell>
                    <TableCell className={`text-sm text-muted-foreground ${SO_NO_COMPUTADOR}`}>
                      {inv.inviter_name ?? "—"}
                    </TableCell>
                    {canManage ? (
                      <TableCell>
                        {emAberto ? (
                          <DropdownMenu
                            // `modal={false}`: o menu modal trava a rolagem da página ao abrir, e
                            // nesta tela — com as abas da área empurrando a lista para baixo da dobra —
                            // a página voltava ao topo no mesmo instante, deixando o menu FORA da tela
                            // e sem como rolar até ele (e2e invite-lifecycle #15, run 37774453932).
                            modal={false}
                          >
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" aria-label={t("Ações")}>
                                <DotsThree size={20} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                disabled={resend.isPending}
                                onClick={() => void reenviar(inv.id)}
                              >
                                <ArrowsClockwise size={16} />
                                {t("Reenviar")}
                              </DropdownMenuItem>
                              {inv.accept_url ? (
                                <DropdownMenuItem onClick={() => copyLink(inv.accept_url!)}>
                                  <Copy size={16} />
                                  {t("Copiar link")}
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => setRevokeDialog(inv)}
                              >
                                {t("Revogar")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={!!revokeDialog} onOpenChange={(o) => !o && setRevokeDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Revogar convite")}</DialogTitle>
            <DialogDescription>
              {revokeDialog?.email}{" "}
              {t(
                "não poderá mais usar este convite para entrar. Você pode enviar um novo depois.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevokeDialog(null)}>
              {t("Cancelar")}
            </Button>
            <Button
              variant="destructive"
              disabled={revoke.isPending}
              onClick={async () => {
                if (!revokeDialog) return;
                try {
                  await revoke.mutateAsync(revokeDialog.id);
                  toast.success(t("Convite revogado."));
                  setRevokeDialog(null);
                } catch {
                  /* showApiError já disparou */
                }
              }}
            >
              {t("Revogar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
