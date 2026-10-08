"use client";

import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useApagarMidia,
  useCriarMidia,
  useEditarMidia,
  useMidias,
  useRemoverArquivo,
  useSubirArquivo,
  type MidiaItem,
} from "@/hooks/ai/useMidias";
import { useT } from "@/hooks/i18n/useT";
import type { SituacaoDaMidia } from "@/lib/midias/termo";

const ACEITA = "image/jpeg,image/png,image/webp,video/mp4,video/3gpp";

const SELO: Record<SituacaoDaMidia, { texto: string; variant: "success" | "warning" | "destructive" }> = {
  pronta: { texto: "Pronta", variant: "success" },
  sem_termo: { texto: "Sem termo", variant: "warning" },
  termo_vencido: { texto: "Termo vencido", variant: "warning" },
  revogada: { texto: "Revogada", variant: "destructive" },
  arquivo_ausente: { texto: "Arquivo ausente", variant: "warning" },
};

function erroDe(err: unknown): string {
  return err instanceof Error ? err.message : "Erro inesperado.";
}

export function BibliotecaDeMidias() {
  const t = useT();
  const { data, isLoading } = useMidias();
  const criar = useCriarMidia();
  const [novo, setNovo] = React.useState<CamposEditaveis | null>(null);
  const [erroCriar, setErroCriar] = React.useState<string | null>(null);

  if (isLoading || !data) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;

  async function salvarNovo() {
    if (!novo) return;
    setErroCriar(null);
    try {
      await criar.mutateAsync({
        title: novo.title.trim(),
        ...(novo.when.trim() ? { when_to_use: novo.when.trim() } : {}),
        tags: novo.tags.split(",").map((x) => x.trim()).filter((x) => x !== ""),
        contains_person: novo.pessoa,
      });
      setNovo(null);
    } catch (err) {
      setErroCriar(erroDe(err));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Button data-testid="midia-nova" onClick={() => setNovo({ title: "", when: "", tags: "", pessoa: true })}>
          {t("Nova mídia")}
        </Button>
      </div>

      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhuma mídia cadastrada ainda.")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {data.map((item) => (
            <CartaoDaMidia key={item.id} item={item} />
          ))}
        </div>
      )}

      <Dialog open={novo !== null} onOpenChange={(aberto) => !aberto && setNovo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Nova mídia")}</DialogTitle>
          </DialogHeader>
          {novo && (
            <CamposDaMidia valor={novo} onChange={setNovo} erro={erroCriar} />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNovo(null)}>{t("Cancelar")}</Button>
            <Button onClick={() => void salvarNovo()} disabled={criar.isPending || !novo?.title.trim()}>{t("Salvar")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type CamposEditaveis = { title: string; when: string; tags: string; pessoa: boolean };

function CamposDaMidia({ valor, onChange, erro }: { valor: CamposEditaveis; onChange: (v: CamposEditaveis) => void; erro: string | null }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="midia-titulo">{t("Título")}</Label>
        <Input id="midia-titulo" data-testid="midia-titulo" value={valor.title} maxLength={120} onChange={(e) => onChange({ ...valor, title: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="midia-quando-usar">{t("Quando usar")}</Label>
        <Textarea id="midia-quando-usar" data-testid="midia-quando-usar" value={valor.when} rows={3} onChange={(e) => onChange({ ...valor, when: e.target.value })} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="midia-etiquetas">{t("Etiquetas (separadas por vírgula)")}</Label>
        <Input id="midia-etiquetas" data-testid="midia-etiquetas" value={valor.tags} onChange={(e) => onChange({ ...valor, tags: e.target.value })} />
      </div>
      <div className="flex items-center gap-2">
        <input id="midia-mostra-pessoa" data-testid="midia-mostra-pessoa" type="checkbox" checked={valor.pessoa} onChange={(e) => onChange({ ...valor, pessoa: e.target.checked })} />
        <Label htmlFor="midia-mostra-pessoa">{t("Mostra pessoa identificável?")}</Label>
      </div>
      {erro && <p role="alert" className="text-sm text-destructive">{erro}</p>}
    </div>
  );
}

/** Chaveado por item + estado do termo: ao revogar ou gravar, o formulário recomeça do que o servidor tem. */
function TermoDaMidia({ item }: { item: MidiaItem }) {
  const t = useT();
  const editar = useEditarMidia();
  const [erroTermo, setErroTermo] = React.useState<string | null>(null);
  const [termo, setTermo] = React.useState({
    subject: item.consent_subject ?? "",
    scope: item.consent_scope ?? "",
    signed: item.consent_signed_at?.slice(0, 10) ?? "",
    expires: item.consent_expires_at?.slice(0, 10) ?? "",
  });
  const termoAtivo = item.consent_signed_at !== null && item.consent_revoked_at === null;

  async function salvarTermo() {
    setErroTermo(null);
    try {
      await editar.mutateAsync({
        id: item.id,
        consent: {
          subject: termo.subject.trim(),
          scope: termo.scope.trim(),
          signed_at: termo.signed,
          expires_at: termo.expires === "" ? null : termo.expires,
        },
      });
      toast.success(t("Termo salvo."));
    } catch (err) {
      setErroTermo(erroDe(err));
    }
  }

  async function revogar() {
    if (!window.confirm(t("Revogar para de enviar agora. O que já foi enviado no WhatsApp não volta."))) return;
    try {
      await editar.mutateAsync({ id: item.id, revogar: true });
    } catch (err) {
      setErroTermo(erroDe(err));
    }
  }

  return (
      <div className="flex flex-col gap-3 rounded-md border border-border p-3">
        <p className="text-sm font-medium">{t("Termo de uso de imagem")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`midia-termo-titular-${item.id}`}>{t("Titular")}</Label>
            <Input id={`midia-termo-titular-${item.id}`} data-testid="midia-termo-titular" value={termo.subject} onChange={(e) => setTermo({ ...termo, subject: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`midia-termo-escopo-${item.id}`}>{t("Escopo")}</Label>
            <Input id={`midia-termo-escopo-${item.id}`} data-testid="midia-termo-escopo" value={termo.scope} onChange={(e) => setTermo({ ...termo, scope: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`midia-termo-assinado-${item.id}`}>{t("Data de assinatura")}</Label>
            <Input id={`midia-termo-assinado-${item.id}`} data-testid="midia-termo-assinado" type="date" value={termo.signed} onChange={(e) => setTermo({ ...termo, signed: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`midia-termo-validade-${item.id}`}>{t("Validade (vazia = sem prazo)")}</Label>
            <Input id={`midia-termo-validade-${item.id}`} data-testid="midia-termo-validade" type="date" value={termo.expires} onChange={(e) => setTermo({ ...termo, expires: e.target.value })} />
          </div>
        </div>
        {erroTermo && <p role="alert" className="text-sm text-destructive">{erroTermo}</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            data-testid="midia-termo-salvar"
            disabled={editar.isPending || !termo.subject.trim() || !termo.scope.trim() || !termo.signed}
            onClick={() => void salvarTermo()}
          >
            {t("Salvar termo")}
          </Button>
          {termoAtivo && (
            <Button variant="outline" size="sm" data-testid="midia-revogar" disabled={editar.isPending} onClick={() => void revogar()}>
              {t("Revogar termo")}
            </Button>
          )}
        </div>
      </div>
  );
}

function CartaoDaMidia({ item }: { item: MidiaItem }) {
  const t = useT();
  const subir = useSubirArquivo();
  const remover = useRemoverArquivo();
  const editar = useEditarMidia();
  const apagar = useApagarMidia();
  const [erro, setErro] = React.useState<string | null>(null);
  const [edicao, setEdicao] = React.useState<CamposEditaveis | null>(null);
  const [erroEdicao, setErroEdicao] = React.useState<string | null>(null);
  const selo = SELO[item.situacao];

  async function enviar(variante: "A" | "B", arquivo: File | undefined) {
    if (!arquivo) return;
    setErro(null);
    try {
      await subir.mutateAsync({ id: item.id, variante, arquivo });
    } catch (err) {
      setErro(erroDe(err));
    }
  }

  async function tirar(variante: "A" | "B") {
    setErro(null);
    try {
      await remover.mutateAsync({ id: item.id, variante });
    } catch (err) {
      setErro(erroDe(err));
    }
  }

  async function salvarEdicao() {
    if (!edicao) return;
    setErroEdicao(null);
    try {
      await editar.mutateAsync({
        id: item.id,
        title: edicao.title.trim(),
        when_to_use: edicao.when.trim(),
        tags: edicao.tags.split(",").map((x) => x.trim()).filter((x) => x !== ""),
        contains_person: edicao.pessoa,
      });
      setEdicao(null);
    } catch (err) {
      setErroEdicao(erroDe(err));
    }
  }

  async function apagarItem() {
    if (!window.confirm(t("Apagar esta mídia e os arquivos dela?"))) return;
    try {
      await apagar.mutateAsync(item.id);
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <Card data-testid="midia-item">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="text-base">{item.title}</CardTitle>
          {item.when_to_use && <CardDescription>{item.when_to_use}</CardDescription>}
          {item.tags.length > 0 && <p className="text-xs text-muted-foreground">{item.tags.join(", ")}</p>}
        </div>
        <Badge data-testid="midia-situacao" variant={selo.variant}>{t(selo.texto)}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {(["A", "B"] as const).map((chave) => {
            const v = item.variantes.find((x) => x.key === chave);
            return (
              <div key={chave} className="flex flex-col gap-2">
                <Label htmlFor={`midia-arquivo-${chave}-${item.id}`}>{t("Arquivo")} {chave}</Label>
                {v &&
                  (v.url === null ? (
                    <p className="text-xs text-muted-foreground">{t("Pré-visualização indisponível")}</p>
                  ) : v.mime.startsWith("video/") ? (
                    <video src={v.url} controls preload="metadata" className="max-h-48 rounded-md border border-border" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- URL assinada do Storage, sem otimizador
                    <img src={v.url} alt={`${item.title} ${chave}`} className="max-h-48 rounded-md border border-border object-contain" />
                  ))}
                <Input
                  id={`midia-arquivo-${chave}-${item.id}`}
                  data-testid={`midia-arquivo-${chave}`}
                  type="file"
                  accept={ACEITA}
                  disabled={subir.isPending || remover.isPending}
                  onChange={(e) => {
                    const alvo = e.currentTarget;
                    void enviar(chave, alvo.files?.[0]).finally(() => {
                      alvo.value = "";
                    });
                  }}
                />
                {v && (
                  <Button variant="outline" size="sm" className="self-start" disabled={subir.isPending || remover.isPending} onClick={() => void tirar(chave)}>
                    {t("Tirar este arquivo")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        {erro && <p role="alert" className="text-sm text-destructive">{erro}</p>}

        {item.contains_person && (
          <TermoDaMidia key={`${item.id}|${item.consent_signed_at}|${item.consent_revoked_at}`} item={item} />
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="midia-editar"
            onClick={() => {
              setErroEdicao(null);
              setEdicao({ title: item.title, when: item.when_to_use ?? "", tags: item.tags.join(", "), pessoa: item.contains_person });
            }}
          >
            {t("Editar")}
          </Button>
          <Button variant="outline" size="sm" data-testid="midia-apagar" disabled={apagar.isPending} onClick={() => void apagarItem()}>
            {t("Apagar mídia")}
          </Button>
        </div>
      </CardContent>
      <Dialog open={edicao !== null} onOpenChange={(aberto) => !aberto && setEdicao(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Editar mídia")}</DialogTitle>
          </DialogHeader>
          {edicao && <CamposDaMidia valor={edicao} onChange={setEdicao} erro={erroEdicao} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEdicao(null)}>{t("Cancelar")}</Button>
            <Button data-testid="midia-editar-salvar" onClick={() => void salvarEdicao()} disabled={editar.isPending || !edicao?.title.trim()}>{t("Salvar")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
