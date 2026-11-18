"use client";
/**
 * Criar campanha (PRD §8).
 *
 * ═══ Por que SEÇÕES e não um wizard de cinco passos ═══
 *
 * O PRD recomenda o wizard; a ordem das perguntas aqui é a mesma dele
 * (Informações → Público → Mensagem → Entrega), mas numa página só. O wizard
 * acrescentaria estado de passo, navegação entre passos e rascunho parcial
 * gravado a cada etapa — máquina para um formulário que cabe numa tela. O que
 * ele daria de útil, que é não deixar apertar "enviar" antes de conferir, já
 * existe: criar uma campanha cria um RASCUNHO, e preparar/testar/iniciar são
 * ações da tela de detalhe, cada uma com sua confirmação.
 *
 * A prévia do público fica ao lado do filtro, e não depois: o número que o
 * operador precisa ver antes de apertar é "quantas pessoas isto pega".
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCriarCampanha } from "@/hooks/campanhas/useCampanhas";
import { useConfiguracaoDeCampanhas } from "@/hooks/campanhas/useConfiguracao";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import {
  useAgentesPublicados,
  useEtapas,
  useFunis,
} from "@/hooks/campanhas/useDestinoDaCampanha";

import {
  CamposDeRitmo,
  RITMO_EM_BRANCO,
  errosDoRitmo,
  ritmoNosCampos,
  ritmoParaEnviar,
} from "../_components/CamposDeRitmo";
import { MensagemDaCampanha } from "../_components/MensagemDaCampanha";
import {
  PUBLICO_EM_BRANCO,
  PublicoDaCampanha,
  conferirPublico,
  filtroDoPublico,
} from "../_components/PublicoDaCampanha";

export function NovaCampanha() {
  const t = useT();
  const router = useRouter();
  const canais = useChannelSessions();
  const criar = useCriarCampanha();

  const [nome, setNome] = useState("");
  const [canal, setCanal] = useState("");
  const [baseLegal, setBaseLegal] = useState<"consent" | "legitimate_interest">("consent");
  const [liaRef, setLiaRef] = useState("");
  const [publico, setPublico] = useState(PUBLICO_EM_BRANCO);
  const [texto, setTexto] = useState("");
  const [ritmo, setRitmo] = useState(RITMO_EM_BRANCO);
  const [extras, setExtras] = useState<string[]>([]);
  const [funil, setFunil] = useState("");
  const [etapa, setEtapa] = useState("");
  const [agente, setAgente] = useState("");

  const funis = useFunis();
  const etapas = useEtapas(funil || null);
  const agentes = useAgentesPublicados();

  // Os PADRÕES da organização (Campanhas › Ritmo de envio) entram uma vez, ao
  // carregar: a tela de padrões promete que "toda campanha nova nasce com estes
  // valores", e nada os usava (auditoria de 17/11/2026, item 16). Uma vez só —
  // depois quem manda é o que a pessoa digita, inclusive apagar.
  // Ajuste durante o render (e não num efeito): é estado derivado de uma carga
  // que chega depois, e o React recomenda este padrão para não pintar duas vezes.
  const padroes = useConfiguracaoDeCampanhas().data?.configuracao;
  const [padroesAplicados, setPadroesAplicados] = useState(false);
  if (padroes && !padroesAplicados) {
    setPadroesAplicados(true);
    setRitmo((atual) => (Object.values(atual).every((v) => v === "") ? ritmoNosCampos(padroes) : atual));
  }

  const filtro = filtroDoPublico(publico);
  const errosDeRitmo = errosDoRitmo(ritmo);

  const podeSalvar =
    nome.trim() !== "" &&
    canal !== "" &&
    texto.trim() !== "" &&
    conferirPublico(filtro).valido &&
    Object.keys(errosDeRitmo).length === 0 &&
    (baseLegal !== "legitimate_interest" || liaRef.trim() !== "");

  function salvar() {
    // Falhou: o toast diz por quê e a tela fica com o que foi digitado.
    criar.mutate({
      name: nome.trim(),
      channel_session_id: canal,
      message_body: texto.trim(),
      base_legal: baseLegal,
      lia_ref: liaRef.trim() || null,
      audience_filter: filtro,
      ...ritmoParaEnviar(ritmo),
      channel_session_ids: extras,
      pipeline_id: funil || null,
      stage_id: etapa || null,
      agent_id: agente || null,
    }, { onSuccess: (criada) => router.push(`/app/campaigns/${criada.id}`) });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <header>
        <h1 className="titulo-tela">{t("Nova campanha")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("Isto cria um rascunho. Nada é enviado antes de você preparar a lista e iniciar.")}
        </p>
      </header>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Informações")}</h2>
        <div className="space-y-2">
          <Label htmlFor="nome">{t("Nome da campanha")}</Label>
          <Input
            id="nome"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder={t("Ex.: Retorno de pacientes parados")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="canal">{t("Enviar pelo número")}</Label>
          <select
            id="canal"
            className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
            value={canal}
            onChange={(e) => setCanal(e.target.value)}
          >
            <option value="">{t("Escolha um número")}</option>
            {(canais.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {channelLabel(c, t)}
              </option>
            ))}
          </select>
          {canais.data?.length === 0 && (
            <p className="text-sm text-warning-fg">
              {t("Nenhum número conectado. Conecte um em Conexões antes de criar a campanha.")}
            </p>
          )}
        </div>

        {(canais.data ?? []).length > 1 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("Falar também por estes números")}</legend>
            <p className="text-sm text-muted-foreground">
              {t(
                "A campanha reveza entre os números marcados, escolhendo a cada envio o que tem mais folga no teto do dia. Quem já conversa com você por um deles recebe por esse mesmo, para não chegar de um número desconhecido.",
              )}
            </p>
            {(canais.data ?? [])
              .filter((c) => c.id !== canal)
              .map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={extras.includes(c.id)}
                    onChange={(e) =>
                      setExtras((atual) =>
                        e.target.checked ? [...atual, c.id] : atual.filter((id) => id !== c.id),
                      )
                    }
                  />
                  {channelLabel(c, t)}
                </label>
              ))}
            {extras.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {t(
                  "Atenção: o intervalo e os tetos da CAMPANHA somam todos os números. Para o rodízio aumentar o volume, deixe o ritmo da campanha em branco e cada número usa o dele.",
                )}
              </p>
            )}
          </fieldset>
        )}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("Base legal do envio")}</legend>
          <p className="text-sm text-muted-foreground">
            {t(
              "Quem recebe pode perguntar por que recebeu, e a resposta precisa existir antes do envio.",
            )}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="base-legal"
              value="consent"
              checked={baseLegal === "consent"}
              onChange={() => setBaseLegal("consent")}
            />
            {t("Consentimento — estas pessoas pediram para receber")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="base-legal"
              value="legitimate_interest"
              checked={baseLegal === "legitimate_interest"}
              onChange={() => setBaseLegal("legitimate_interest")}
            />
            {t("Interesse legítimo — com avaliação (LIA) registrada")}
          </label>
          {baseLegal === "legitimate_interest" && (
            <div className="space-y-2">
              <Label htmlFor="lia">{t("Referência da avaliação (LIA)")}</Label>
              <Input
                id="lia"
                value={liaRef}
                onChange={(e) => setLiaRef(e.target.value)}
                placeholder={t("Ex.: LIA-2026-01")}
              />
            </div>
          )}
        </fieldset>
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Público")}</h2>
        <PublicoDaCampanha campos={publico} onChange={setPublico} texto={texto} />
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
            <Label htmlFor="funil">{t("Vira card no funil")}</Label>
            <select
              id="funil"
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
              value={funil}
              onChange={(e) => {
                setFunil(e.target.value);
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
            <Label htmlFor="etapa">{t("Na etapa")}</Label>
            <select
              id="etapa"
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
              value={etapa}
              onChange={(e) => setEtapa(e.target.value)}
              disabled={!funil}
            >
              <option value="">{t("Primeira etapa do funil")}</option>
              {(etapas.data ?? [])
                .filter((e) => !e.is_won && !e.is_lost)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="agente">{t("Quem atende a resposta")}</Label>
          <select
            id="agente"
            className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
            value={agente}
            onChange={(e) => setAgente(e.target.value)}
          >
            <option value="">{t("Agente publicado no número (padrão)")}</option>
            {(agentes.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <p className="text-sm text-muted-foreground">
            {t("Vale só para conversas que nascem desta campanha: quem já falava com você continua com quem o atendia. Quem aborda precisa saber dizer de onde veio o contato — essa resposta tem de estar no material do agente escolhido.")}
          </p>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <h2 className="font-medium">{t("Ritmo desta campanha")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Em branco, vale o ritmo do número (Conexões › Proteção de envio). O que você puser aqui só pode deixar mais devagar.",
          )}
        </p>
        <CamposDeRitmo prefixo="nova" valores={ritmo} onChange={setRitmo} />
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" onClick={() => router.push("/app/campaigns")}>
          {t("Cancelar")}
        </Button>
        <Button disabled={!podeSalvar || criar.isPending} onClick={salvar}>
          {criar.isPending ? t("Salvando…") : t("Salvar rascunho")}
        </Button>
      </div>
    </div>
  );
}
