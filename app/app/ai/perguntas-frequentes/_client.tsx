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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  useAlterarRespostaPronta,
  useCalcularReconhecimento,
  useMetricasRespostasProntas,
  useRespostasProntas,
  useSalvarConfig,
  useSalvarRespostaPronta,
  type RespostaProntaItem,
} from "@/hooks/ai/useRespostasProntas";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { LIMITE_MAXIMO, LIMITE_MINIMO } from "@/lib/respostas-prontas/casamento";

interface Rascunho {
  id?: string;
  titulo: string;
  resposta: string;
  perguntas: string;
}

export function PerguntasFrequentesClient() {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const { data, isLoading } = useRespostasProntas();
  const salvarConfig = useSalvarConfig();
  const salvarItem = useSalvarRespostaPronta();
  const alterar = useAlterarRespostaPronta();
  const calcular = useCalcularReconhecimento();

  const [rascunho, setRascunho] = React.useState<Rascunho | null>(null);
  // Edição local sobre o valor do banco: sem efeito que copia o servidor para o estado.
  const [ligadoEditado, setLigado] = React.useState<boolean | null>(null);
  const [limiteEditado, setLimite] = React.useState<string | null>(null);
  const ligado = ligadoEditado ?? data?.config.ligado ?? false;
  const limite = limiteEditado ?? (data ? data.config.limite_similaridade.toFixed(2) : "0.82");

  if (isLoading || !data) {
    return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  }

  const itens = data.itens;
  const naoReconhecidas = itens.flatMap((i) => i.perguntas).filter((p) => !p.reconhecida).length;
  const formatarData = (iso: string) => new Date(iso).toLocaleDateString(tagDoIdioma);

  function abrir(item?: RespostaProntaItem) {
    setRascunho(
      item
        ? { id: item.id, titulo: item.titulo, resposta: item.resposta, perguntas: item.perguntas.map((p) => p.texto).join("\n") }
        : { titulo: "", resposta: "", perguntas: "" },
    );
  }

  async function salvar() {
    if (!rascunho) return;
    const perguntas = rascunho.perguntas
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p !== "");
    try {
      const r = await salvarItem.mutateAsync({
        ...(rascunho.id ? { id: rascunho.id } : {}),
        titulo: rascunho.titulo.trim(),
        resposta: rascunho.resposta.trim(),
        perguntas,
      });
      toast.success(
        r.data.sem_reconhecimento > 0
          ? t("Salva, mas algumas formas de perguntar ainda não são reconhecidas.")
          : t("Pergunta frequente salva."),
      );
      setRascunho(null);
    } catch (err) {
      showApiError(err);
    }
  }

  async function salvarConfiguracao() {
    try {
      await salvarConfig.mutateAsync({ ligado, limite_similaridade: Number(limite) });
      setLigado(null);
      setLimite(null);
      toast.success(t("Configuração salva."));
    } catch (err) {
      showApiError(err);
    }
  }

  async function calcularAgora() {
    try {
      const r = await calcular.mutateAsync();
      if (r.data.calculadas > 0) toast.success(t("Reconhecimento calculado."));
      else toast.error(t("Não foi possível calcular agora. Confira a chave da OpenAI em Credenciais."));
    } catch (err) {
      showApiError(err);
    }
  }

  async function mudar(input: { id: string; ativo?: boolean; revisado?: true }) {
    try {
      await alterar.mutateAsync(input);
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("Responder sem IA")}</CardTitle>
          <CardDescription>
            {t("Quando ligado, a mensagem curta e de um assunto só que for claramente uma destas perguntas recebe a resposta cadastrada, marcada “Resposta pronta” na conversa.")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex items-center gap-2">
            <Switch id="rp-ligado" checked={ligado} onCheckedChange={setLigado} aria-label={t("Responder sem IA")} />
            <Label htmlFor="rp-ligado">{ligado ? t("Ligado") : t("Desligado")}</Label>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="rp-limite">{t("Rigor do reconhecimento")}</Label>
            <Input
              id="rp-limite"
              type="number"
              step="0.01"
              min={LIMITE_MINIMO}
              max={LIMITE_MAXIMO}
              value={limite}
              onChange={(e) => setLimite(e.target.value)}
              className="w-28"
            />
            <p className="text-xs text-muted-foreground">
              {t("Quanto maior, mais parecida a mensagem precisa ser com uma das formas de perguntar. Entre 0,78 e 0,95; o padrão é 0,82.")}
            </p>
          </div>
          <Button onClick={() => void salvarConfiguracao()} disabled={salvarConfig.isPending}>
            {t("Salvar configuração")}
          </Button>
        </CardContent>
      </Card>

      <MedicaoDoPeriodo />

      {naoReconhecidas > 0 && (
        <div role="status" className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning-bg p-3 text-sm text-warning-fg sm:flex-row sm:items-center sm:justify-between">
          <span>
            {t("Algumas formas de perguntar ainda não são reconhecidas: falta a chave da OpenAI (Credenciais) ou o cálculo falhou.")}
          </span>
          <Button variant="outline" size="sm" onClick={() => void calcularAgora()} disabled={calcular.isPending}>
            {t("Calcular agora")}
          </Button>
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={() => abrir()}>{t("Nova pergunta frequente")}</Button>
      </div>

      {itens.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("Nenhuma pergunta frequente cadastrada ainda.")}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {itens.map((item) => (
            <Card key={item.id} data-testid="resposta-pronta">
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <CardTitle className="text-base">{item.titulo}</CardTitle>
                  <CardDescription>
                    {t("Revisada em")} {formatarData(item.revisado_em)}
                  </CardDescription>
                </div>
                <Badge variant={item.ativo ? "success" : "neutral"}>{item.ativo ? t("Ativa") : t("Desativada")}</Badge>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="whitespace-pre-wrap text-sm">{item.resposta}</p>
                <ul className="flex flex-wrap gap-2">
                  {item.perguntas.map((p) => (
                    <li key={p.id} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs">
                      <span>{p.texto}</span>
                      {!p.reconhecida && <Badge variant="warning">{t("não reconhecida")}</Badge>}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => abrir(item)}>
                    {t("Editar")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void mudar({ id: item.id, revisado: true })}>
                    {t("Marcar como revisada")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void mudar({ id: item.id, ativo: !item.ativo })}>
                    {item.ativo ? t("Desativar") : t("Reativar")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={rascunho !== null} onOpenChange={(aberto) => !aberto && setRascunho(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{rascunho?.id ? t("Editar pergunta frequente") : t("Nova pergunta frequente")}</DialogTitle>
          </DialogHeader>
          {rascunho && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="rp-titulo">{t("Título")}</Label>
                <Input id="rp-titulo" value={rascunho.titulo} maxLength={80} onChange={(e) => setRascunho({ ...rascunho, titulo: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rp-resposta">{t("Resposta")}</Label>
                <Textarea id="rp-resposta" value={rascunho.resposta} maxLength={1000} rows={4} onChange={(e) => setRascunho({ ...rascunho, resposta: e.target.value })} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="rp-perguntas">{t("Formas de perguntar (uma por linha)")}</Label>
                <Textarea id="rp-perguntas" value={rascunho.perguntas} rows={5} onChange={(e) => setRascunho({ ...rascunho, perguntas: e.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRascunho(null)}>
              {t("Cancelar")}
            </Button>
            <Button onClick={() => void salvar()} disabled={salvarItem.isPending}>
              {t("Salvar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MedicaoDoPeriodo() {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const [dias, setDias] = React.useState<7 | 30 | 90>(30);
  const { data } = useMetricasRespostasProntas(dias);
  const dolar = (centavos: number | null) =>
    centavos === null
      ? "—"
      : (centavos / 100).toLocaleString(tagDoIdioma, { style: "currency", currency: "USD" });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <CardTitle>{t("Resultado")}</CardTitle>
        <div className="flex gap-1" role="group" aria-label={t("Período")}>
          {([7, 30, 90] as const).map((d) => (
            <Button key={d} size="sm" variant={d === dias ? "default" : "outline"} onClick={() => setDias(d)}>
              {d === 7 ? t("7 dias") : d === 30 ? t("30 dias") : t("90 dias")}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        <div>
          <p className="text-xs text-muted-foreground">{t("Resolvidas por resposta pronta")}</p>
          <p className="text-2xl font-semibold" data-testid="rp-resolvidas">{data?.resolvidas_por_resposta_pronta ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t("Respondidas pela IA (estimado)")}</p>
          <p className="text-2xl font-semibold">{data?.respondidas_pela_ia ?? "—"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t("Custo de IA evitado (estimado)")}</p>
          <p className="text-2xl font-semibold">{dolar(data?.custo_evitado_estimado_cents ?? null)}</p>
          {data?.custo_incompleto && (
            <p className="text-xs text-muted-foreground">
              {t("Parte das chamadas de IA não tem preço conhecido; a estimativa fica abaixo do real.")}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
