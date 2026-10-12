"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";

import { useT } from "@/hooks/i18n/useT";
import { useRegistrarPedidoLgpd } from "@/hooks/useLgpdPedidoManual";
import { SeletorDeContato } from "@/components/kanban/SeletorDeContato";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/types";
import { hojeNoBrasil } from "@/lib/lgpd/pedido-manual";
import { prazoEmBr } from "@/lib/lgpd/sla";
import {
  LGPD_CANAIS_DE_CHEGADA,
  LGPD_CANAL_LABELS,
  type LgpdCanalDeChegada,
} from "@/lib/lgpd/types";
import type { Contact } from "@/lib/types/contacts";

/**
 * A PORTA DE ENTRADA do pedido do titular para quem não tem loja.
 *
 * Até aqui um pedido só nascia pelo webhook da Nuvemshop. O paciente que pede
 * pelo WhatsApp, por e-mail, por telefone ou no balcão não tinha como entrar: sem
 * registro não há prazo contando nem trilha.
 *
 * Registrar NÃO executa nada. O pedido nasce "Recebido" e só anda quando um
 * administrador aprova na página dele, e isso vale em dobro para a anonimização.
 */

const CAMPO =
  "flex h-10 w-full rounded-sm border border-border bg-bg px-3 py-2 text-sm text-text";

type Tipo = "data_request" | "redact";

export function RegistrarPedidoDialog() {
  const t = useT();
  const [aberto, setAberto] = useState(false);

  return (
    <>
      <Button onClick={() => setAberto(true)}>{t("Registrar pedido")}</Button>
      {/* Montado só enquanto aberto: fechar zera o formulário sem código de limpeza. */}
      {aberto && <Formulario onFechar={() => setAberto(false)} />}
    </>
  );
}

function Formulario({ onFechar }: { onFechar: () => void }) {
  const t = useT();
  const hoje = hojeNoBrasil();
  const [contato, setContato] = useState<Contact | null>(null);
  const [tipo, setTipo] = useState<Tipo>("data_request");
  const [canal, setCanal] = useState<LgpdCanalDeChegada>("whatsapp");
  const [recebidoEm, setRecebidoEm] = useState(hoje);
  const [email, setEmail] = useState("");
  const [nota, setNota] = useState("");
  const [erro, setErro] = useState<{ texto: string; pedidoAberto?: string } | null>(null);
  const registrar = useRegistrarPedidoLgpd();

  function escolher(escolhido: Contact | null) {
    setContato(escolhido);
    setEmail(escolhido?.email ?? "");
    setErro(null);
  }

  const noFuturo = recebidoEm > hoje;
  const podeEnviar = Boolean(contato) && recebidoEm !== "" && !noFuturo && !registrar.isPending;

  function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (!contato || !podeEnviar) return;
    setErro(null);
    registrar.mutate(
      {
        contact_id: contato.id,
        request_type: tipo,
        channel: canal,
        received_on: recebidoEm,
        delivery_email: email.trim() || null,
        note: nota.trim() || null,
      },
      {
        onSuccess: (r) => {
          toast.success(`${t("Pedido registrado. Prazo:")} ${prazoEmBr(r.data.due_at) ?? ""}`);
          onFechar();
        },
        onError: (err) => {
          const api = err instanceof ApiError ? err : null;
          const pedidoAberto = api?.details?.existing_request_id;
          setErro({
            texto: api?.message ?? t("Não foi possível registrar o pedido. Tente de novo."),
            pedidoAberto: typeof pedidoAberto === "string" ? pedidoAberto : undefined,
          });
        },
      },
    );
  }

  return (
    <Dialog open onOpenChange={(abrir) => !abrir && onFechar()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Registrar pedido do titular")}</DialogTitle>
          <DialogDescription>
            {t("Use quando a pessoa pedir os próprios dados, ou o apagamento deles, por WhatsApp, e-mail, telefone ou pessoalmente. O prazo legal conta do dia em que ela pediu.")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={enviar} className="space-y-4">
          <SeletorDeContato escolhido={contato} onEscolher={escolher} rotulo={t("De quem é o pedido")} />

          <div className="space-y-2">
            <Label htmlFor="lgpd-tipo">{t("O que a pessoa pediu")}</Label>
            <select
              id="lgpd-tipo"
              className={CAMPO}
              value={tipo}
              onChange={(e) => setTipo(e.target.value as Tipo)}
            >
              <option value="data_request">{t("Cópia dos dados")}</option>
              <option value="redact">{t("Apagar os dados (anonimização)")}</option>
            </select>
            {tipo === "redact" && (
              <p role="note" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
                {t("Registrar não apaga nada. A anonimização só acontece depois que um administrador aprovar este pedido, e não pode ser desfeita.")}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="lgpd-canal">{t("Como o pedido chegou")}</Label>
              <select
                id="lgpd-canal"
                className={CAMPO}
                value={canal}
                onChange={(e) => setCanal(e.target.value as LgpdCanalDeChegada)}
              >
                {LGPD_CANAIS_DE_CHEGADA.map((c) => (
                  <option key={c} value={c}>
                    {t(LGPD_CANAL_LABELS[c])}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="lgpd-recebido-em">{t("Dia em que a pessoa pediu")}</Label>
              <Input
                id="lgpd-recebido-em"
                type="date"
                required
                max={hoje}
                value={recebidoEm}
                onChange={(e) => setRecebidoEm(e.target.value)}
                aria-invalid={noFuturo}
              />
              {noFuturo && (
                <p className="text-xs text-destructive">{t("A data em que o pedido chegou não pode estar no futuro.")}</p>
              )}
            </div>
          </div>

          {tipo === "data_request" && (
            <div className="space-y-2">
              <Label htmlFor="lgpd-email">
                {t("E-mail para enviar o relatório")}{" "}
                <span className="text-xs text-muted-foreground">({t("opcional")})</span>
              </Label>
              <Input
                id="lgpd-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                maxLength={254}
              />
              <p className="text-xs text-muted-foreground">
                {t("Sem e-mail, o relatório fica pronto para baixar e entregar em mãos.")}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="lgpd-nota">
              {t("Observação")}{" "}
              <span className="text-xs text-muted-foreground">({t("opcional")})</span>
            </Label>
            <Textarea
              id="lgpd-nota"
              rows={2}
              maxLength={1000}
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              className="resize-none"
            />
          </div>

          {erro && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {erro.texto}{" "}
              {erro.pedidoAberto && (
                <Link href={`/app/lgpd/requests/${erro.pedidoAberto}`} className="underline">
                  {t("Abrir o pedido em aberto")}
                </Link>
              )}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onFechar}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={!podeEnviar}>
              {registrar.isPending ? t("Registrando…") : t("Registrar pedido")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
