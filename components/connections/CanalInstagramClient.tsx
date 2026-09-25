"use client";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { apiClient } from "@/lib/api/client";
import { InstagramLogo } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

/**
 * Instagram Direct em Conexões: contas conectadas, validade da chave, Origem
 * padrão, reconectar e desconectar.
 *
 * Conectar é um LINK (o login acontece no site do Instagram e volta para cá com
 * `?instagram=<código>`), não um formulário: a tela não vê token nenhum.
 */

interface Origem {
  campo: string;
  valor: string;
}

interface Conta {
  id: string;
  username: string | null;
  status: string;
  expira_em: string | null;
  origem_padrao: Origem | null;
}

interface Campo {
  key: string;
  label: string;
  options: { value: string; label: string }[];
}

interface Estado {
  pode_conectar: boolean;
  contas: Conta[];
  campos: Campo[];
}

const CONECTAR = "/api/v1/channels/instagram/connect";

/** O que cada volta do login quer dizer, em uma frase. */
export const AVISO_DA_VOLTA: Record<string, { texto: string; tom: "ok" | "erro" }> = {
  conectado: { texto: "Conta do Instagram conectada.", tom: "ok" },
  cancelado: { texto: "Login do Instagram cancelado. Nada foi conectado.", tom: "erro" },
  link_vencido: { texto: "O link de conexão venceu. Clique em Conectar Instagram de novo.", tom: "erro" },
  conta_em_outra_organizacao: {
    texto: "Esta conta do Instagram já está conectada em outra organização desta instalação.",
    tom: "erro",
  },
  sem_credencial: {
    texto: "Falta cadastrar a credencial do Instagram no painel do administrador.",
    tom: "erro",
  },
  falhou: { texto: "Não foi possível conectar o Instagram. Tente de novo.", tom: "erro" },
};

function OrigemPadrao({ conta, campos, onSalvo }: { conta: Conta; campos: Campo[]; onSalvo: () => void }) {
  const t = useT();
  const [campo, setCampo] = useState(conta.origem_padrao?.campo ?? "");
  const [valor, setValor] = useState(conta.origem_padrao?.valor ?? "");
  const [salvando, setSalvando] = useState(false);
  const opcoes = campos.find((c) => c.key === campo)?.options ?? [];

  const salvar = async () => {
    setSalvando(true);
    try {
      await apiClient.patch(`/api/v1/channels/instagram/${conta.id}`, {
        origem_padrao: campo && valor ? { campo, valor } : null,
      });
      toast.success(t("Origem padrão salva."));
      onSalvo();
    } catch {
      toast.error(t("Não foi possível salvar a origem padrão."));
    } finally {
      setSalvando(false);
    }
  };

  if (campos.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("Para usar a Origem padrão, crie no funil padrão um campo do tipo lista.")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium">{t("Origem padrão")}</span>
      <p className="text-xs text-muted-foreground">
        {t("Todo contato novo que chegar por esta conta nasce com este valor.")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={t("Campo")}
          className="rounded-md border bg-background p-2 text-sm"
          value={campo}
          onChange={(e) => {
            setCampo(e.target.value);
            setValor("");
          }}
        >
          <option value="">{t("Nenhuma")}</option>
          {campos.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
        {campo && (
          <select
            aria-label={t("Valor")}
            className="rounded-md border bg-background p-2 text-sm"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
          >
            <option value="">{t("Selecione…")}</option>
            {opcoes.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        <Button size="sm" variant="outline" disabled={salvando || (campo !== "" && valor === "")} onClick={() => void salvar()}>
          {salvando ? t("Salvando…") : t("Salvar")}
        </Button>
      </div>
    </div>
  );
}

export function CanalInstagramClient() {
  const t = useT();
  const params = useSearchParams();
  const volta = AVISO_DA_VOLTA[params.get("instagram") ?? ""];
  const [estado, setEstado] = useState<Estado | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [desconectando, setDesconectando] = useState<Conta | null>(null);

  const carregar = async () => {
    try {
      const r = await apiClient.get<{ data: Estado }>("/api/v1/channels/instagram");
      setEstado(r.data);
      setFalhou(false);
    } catch {
      setFalhou(true);
    }
  };

  useEffect(() => {
    void carregar();
  }, []);

  const desconectar = async (conta: Conta) => {
    try {
      await apiClient.delete(`/api/v1/channels/instagram/${conta.id}`);
      toast.success(t("Conta desconectada."));
      await carregar();
    } catch {
      toast.error(t("Não foi possível desconectar a conta."));
    } finally {
      setDesconectando(null);
    }
  };

  const podeConectar = estado?.pode_conectar ?? false;
  const contas = estado?.contas ?? [];

  return (
    <div className="flex flex-col gap-4">
      {volta && (
        <div
          role={volta.tom === "erro" ? "alert" : "status"}
          className={
            volta.tom === "erro"
              ? "rounded-md border border-warning/40 bg-warning-bg p-3 text-sm"
              : "rounded-md border border-border bg-muted/40 p-3 text-sm"
          }
        >
          {t(volta.texto)}
        </div>
      )}

      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <InstagramLogo size={16} weight="regular" aria-hidden />
              {t("Instagram")}
            </h3>
            <p className="text-xs text-muted-foreground">
              {t("As mensagens do Direct das contas conectadas entram no Inbox e viram lead no funil.")}
            </p>
          </div>
          {contas.length > 0 ? (
            <Badge variant="secondary">{t("Conectado")}</Badge>
          ) : (
            <Badge variant="outline">{t("Não conectado")}</Badge>
          )}
        </div>

        {falhou && (
          <p role="alert" className="text-sm text-destructive">
            {t("Não foi possível carregar as contas do Instagram.")}
          </p>
        )}

        {contas.map((conta) => (
          <div key={conta.id} className="flex flex-col gap-3 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{conta.username ? `@${conta.username}` : t("Conta do Instagram")}</p>
                <p className="text-xs text-muted-foreground">
                  {conta.status === "WORKING" ? t("Recebendo mensagens") : t("Precisa reconectar")}
                  {conta.expira_em ? ` · ${t("Chave válida até")} ${format(new Date(conta.expira_em), "dd/MM/yyyy")}` : ""}
                </p>
              </div>
              <div className="flex gap-2">
                {podeConectar && (
                  <Button size="sm" variant="outline" asChild>
                    <a href={CONECTAR}>{t("Reconectar")}</a>
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setDesconectando(conta)}>
                  {t("Desconectar")}
                </Button>
              </div>
            </div>
            <OrigemPadrao conta={conta} campos={estado?.campos ?? []} onSalvo={() => void carregar()} />
          </div>
        ))}

        {estado && !podeConectar ? (
          <div className="flex flex-col gap-2">
            <Button disabled title={t("Falta a credencial do Instagram nesta instalação.")} className="self-start">
              {t("Conectar Instagram")}
            </Button>
            <div className="rounded-md border border-warning/40 bg-warning-bg p-3 text-xs">
              <p className="font-medium">{t("Falta a credencial do Instagram nesta instalação.")}</p>
              <ol className="mt-1 list-decimal pl-4 text-muted-foreground">
                <li>{t("Painel da Meta › seu app › Instagram › Configuração da API com login do Instagram")}</li>
                <li>{t("Copie o Instagram App ID e o Instagram App Secret.")}</li>
                <li>{t("Quem administra a instalação cola os dois na tela Meta do painel do administrador.")}</li>
              </ol>
            </div>
          </div>
        ) : (
          <Button asChild className="self-start" disabled={!estado}>
            <a href={CONECTAR}>{contas.length > 0 ? t("Conectar outra conta") : t("Conectar Instagram")}</a>
          </Button>
        )}
      </Card>

      <AlertDialog open={desconectando !== null} onOpenChange={(v) => !v && setDesconectando(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Desconectar esta conta?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("As mensagens novas do Direct deixam de entrar no CRM. As conversas que já estão aqui continuam.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => desconectando && void desconectar(desconectando)}>
              {t("Desconectar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
