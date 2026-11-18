"use client";
/**
 * Editar o rascunho (Spec 12 §6).
 *
 * ═══ Por que esta tela é obrigatória, e não um luxo ═══
 *
 * Sem ela, um erro de digitação no texto não tinha conserto: a API aceitava o
 * PATCH, mas nenhuma tela o oferecia, e duplicar não resolvia — a cópia também
 * não podia ser editada. O caminho real era recriar a campanha do zero, com o
 * público e o ritmo de novo. Medido em produção, no dia em que a feature subiu.
 *
 * ═══ O público é o MESMO componente da criação ═══
 *
 * Esta tela tinha a sua cópia do formulário, sem "com negócio no funil / na
 * etapa" — e salvar apagava esse critério do público (auditoria de 17/11/2026,
 * item 13, P0). Agora o público e a mensagem são os componentes da criação, e o
 * filtro sai INTEIRO: o gravado, com o que a tela mostra por cima.
 *
 * ═══ O que esta tela NÃO faz ═══
 *
 * Não edita campanha que já foi preparada. Depois do snapshot, cada destinatário
 * carrega o texto congelado com que vai receber, e trocar a campanha ali faria a
 * tela mostrar uma coisa e a fila enviar outra. Para mexer no conteúdo é preciso
 * voltar ao rascunho — o botão está aqui e na tela da campanha —, e isso só vale
 * enquanto nada saiu. O RITMO é a exceção, e ele se edita na própria tela de
 * detalhe, com a campanha em pé.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useAcaoDeCampanha, useCampanha, useEditarCampanha } from "@/hooks/campanhas/useCampanhas";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import { useAgentesPublicados, useEtapas, useFunis } from "@/hooks/campanhas/useDestinoDaCampanha";
import { destinosDe } from "@/lib/campanhas/maquina-de-estados";

import { MensagemDaCampanha } from "../../_components/MensagemDaCampanha";
import {
  PUBLICO_EM_BRANCO,
  PublicoDaCampanha,
  conferirPublico,
  filtroDoPublico,
  publicoDoFiltro,
} from "../../_components/PublicoDaCampanha";

export function EditarCampanha({ id }: { id: string }) {
  const t = useT();
  const router = useRouter();
  const campanha = useCampanha(id);
  const canais = useChannelSessions();
  const salvar = useEditarCampanha(id);
  const acao = useAcaoDeCampanha(id);

  const [nome, setNome] = useState("");
  const [canal, setCanal] = useState("");
  const [baseLegal, setBaseLegal] = useState<"consent" | "legitimate_interest">("consent");
  const [liaRef, setLiaRef] = useState("");
  const [publico, setPublico] = useState(PUBLICO_EM_BRANCO);
  const [texto, setTexto] = useState("");
  const [funil, setFunil] = useState("");
  const [etapa, setEtapa] = useState("");
  const [agente, setAgente] = useState("");
  const [carregado, setCarregado] = useState(false);

  const funis = useFunis();
  const etapas = useEtapas(funil || null);
  const agentes = useAgentesPublicados();

  // Uma carga só: depois disso quem manda é o que a pessoa está digitando. Sem
  // a trava, o `refetchInterval` do detalhe apagaria a edição em andamento.
  useEffect(() => {
    const c = campanha.data;
    if (!c || carregado) return;
    setNome(c.name);
    setCanal(c.channel_session_id);
    setBaseLegal(c.base_legal === "legitimate_interest" ? "legitimate_interest" : "consent");
    setLiaRef(c.lia_ref ?? "");
    setPublico(publicoDoFiltro(c.audience_filter));
    setTexto(c.message_body ?? "");
    setFunil(c.pipeline_id ?? "");
    setEtapa(c.stage_id ?? "");
    setAgente(c.agent_id ?? "");
    setCarregado(true);
  }, [campanha.data, carregado]);

  // Falha ANTES de "carregando": sem isto, um erro deixava a tela no cinza para
  // sempre, sem "Tentar novamente" (auditoria de 17/11/2026, item 27).
  if (campanha.isError) {
    return (
      <Card className="p-6 text-center">
        <p className="text-sm text-error-fg">{t("Não foi possível carregar a campanha.")}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => void campanha.refetch()}>
          {t("Tentar novamente")}
        </Button>
      </Card>
    );
  }

  if (campanha.isLoading || !carregado || !campanha.data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const c = campanha.data;

  if (c.status !== "draft") {
    const podeVoltar = destinosDe(c.status).includes("draft");
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="titulo-tela">{t("Editar campanha")}</h1>
        <Card className="space-y-3 p-4">
          <p className="text-sm">
            {podeVoltar
              ? t(
                  "Esta campanha já foi preparada: cada pessoa da lista tem o texto que vai receber guardado. Para mudar o texto ou o público, volte a campanha para rascunho — isso descarta a lista montada.",
                )
              : t("Só um rascunho aceita mudar o texto e o público. O ritmo você pode ajustar a qualquer momento.")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("O ritmo você ajusta na própria tela da campanha, sem descartar nada.")}
          </p>
          <div className="flex flex-wrap gap-2">
            {podeVoltar && (
              <Button disabled={acao.isPending} onClick={() => acao.mutate({ acao: "rascunho" })}>
                {acao.isPending ? t("Voltando…") : t("Voltar para rascunho")}
              </Button>
            )}
            <Button variant="outline" onClick={() => router.push(`/app/campaigns/${id}`)}>
              {t("Voltar para a campanha")}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const gravado = c.audience_filter ?? {};
  const filtro = filtroDoPublico(publico, gravado);
  const podeSalvar =
    nome.trim() !== "" &&
    canal !== "" &&
    texto.trim() !== "" &&
    conferirPublico(filtro).valido &&
    (baseLegal !== "legitimate_interest" || liaRef.trim() !== "");

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header>
        <h1 className="titulo-tela">{t("Editar campanha")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Enquanto é rascunho, tudo muda. Depois de preparada, só o ritmo.")}
        </p>
      </header>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Informações")}</h2>
        <div className="space-y-2">
          <Label htmlFor="e-nome">{t("Nome da campanha")}</Label>
          <Input id="e-nome" value={nome} onChange={(e) => setNome(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="e-canal">{t("Enviar pelo número")}</Label>
          <select
            id="e-canal"
            className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
            value={canal}
            onChange={(e) => setCanal(e.target.value)}
          >
            {(canais.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {channelLabel(s, t)}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("Base legal do envio")}</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="e-base-legal"
              checked={baseLegal === "consent"}
              onChange={() => setBaseLegal("consent")}
            />
            {t("Consentimento — estas pessoas pediram para receber")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="e-base-legal"
              checked={baseLegal === "legitimate_interest"}
              onChange={() => setBaseLegal("legitimate_interest")}
            />
            {t("Interesse legítimo — com avaliação (LIA) registrada")}
          </label>
          {baseLegal === "legitimate_interest" && (
            <div className="space-y-2">
              <Label htmlFor="e-lia">{t("Referência da avaliação (LIA)")}</Label>
              <Input id="e-lia" value={liaRef} onChange={(e) => setLiaRef(e.target.value)} />
            </div>
          )}
        </fieldset>
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Público")}</h2>
        <PublicoDaCampanha campos={publico} onChange={setPublico} gravado={gravado} texto={texto} campanhaId={id} />
      </Card>

      <Card className="p-4">
        <MensagemDaCampanha texto={texto} onChange={setTexto} />
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Quem responder")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Em branco, tudo segue como hoje: o card nasce no funil do número e quem atende é o agente publicado nele.")}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="e-funil">{t("Vira card no funil")}</Label>
            <select
              id="e-funil"
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
              value={funil}
              onChange={(ev) => {
                setFunil(ev.target.value);
                setEtapa("");
              }}
            >
              <option value="">{t("Funil do número (padrão)")}</option>
              {(funis.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="e-etapa">{t("Na etapa")}</Label>
            <select
              id="e-etapa"
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
              value={etapa}
              onChange={(ev) => setEtapa(ev.target.value)}
              disabled={!funil}
            >
              <option value="">{t("Primeira etapa do funil")}</option>
              {(etapas.data ?? [])
                .filter((x) => !x.is_won && !x.is_lost)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="e-agente">{t("Quem atende a resposta")}</Label>
          <select
            id="e-agente"
            className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
            value={agente}
            onChange={(ev) => setAgente(ev.target.value)}
          >
            <option value="">{t("Agente publicado no número (padrão)")}</option>
            {(agentes.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => router.push(`/app/campaigns/${id}`)}>
          {t("Cancelar")}
        </Button>
        <Button
          disabled={!podeSalvar || salvar.isPending}
          onClick={() =>
            // Falhou: o toast diz por quê e a tela fica com o que foi digitado.
            salvar.mutate(
              {
                name: nome.trim(),
                channel_session_id: canal,
                message_body: texto.trim(),
                base_legal: baseLegal,
                lia_ref: liaRef.trim() || null,
                audience_filter: filtro,
                pipeline_id: funil || null,
                stage_id: etapa || null,
                agent_id: agente || null,
              },
              { onSuccess: () => router.push(`/app/campaigns/${id}`) },
            )
          }
        >
          {salvar.isPending ? t("Salvando…") : t("Salvar alterações")}
        </Button>
      </div>
    </div>
  );
}
