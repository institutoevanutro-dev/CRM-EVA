"use client";

/**
 * Os formulários de Conversões: as preferências da organização (origem e
 * etapas de sinal pago) e as duas conexões, cada uma com um interruptor por
 * evento.
 *
 * ── Por que os campos de segredo nascem VAZIOS e isso não é um bug ──────────
 *
 * A tela nunca recebe segredo — `lerEstadoDasConversoes` devolve só booleanos.
 * O input vazio significa "mantenha o que está gravado", e o placeholder diz
 * isso. Pré-preencher poria o segredo no HTML de uma página que o browser
 * cacheia.
 *
 * ── O switch pausa; NÃO existe remover ──────────────────────────────────────
 *
 * Desligar interrompe o envio, inclusive o que estava esperando nova tentativa,
 * e mantém a credencial. Remover a conexão de vez ainda não tem superfície.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { updateAdPlatformConnection } from "@/app/actions/settings/updateAdPlatformConnection";
import { updatePreferenciasDeConversao } from "@/app/actions/settings/updatePreferenciasDeConversao";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { EstadoGoogle, EstadoMeta } from "@/lib/conversoes/estado-da-conexao";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira os campos: algum valor não está no formato esperado.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta conexão.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  cifra_indisponivel:
    "Esta instalação está sem a chave mestra de criptografia, e o token não foi gravado. Quem instalou o sistema precisa configurá-la — refazer o cadastro aqui não resolve.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

function useSalvar(idioma: Idioma) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  function salvar(acao: () => Promise<{ ok: true } | { ok: false; error: string }>, depois?: () => void) {
    startTransition(async () => {
      const resultado = await acao();
      if (resultado.ok) {
        depois?.();
        toast.success(t("Salvo."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
    });
  }
  return { t, isPending, salvar };
}

function Campo(props: {
  id: string;
  rotulo: string;
  valor: string;
  onChange: (v: string) => void;
  ajuda: string;
  placeholder?: string;
  segredo?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={props.id}>{props.rotulo}</Label>
      <Input
        id={props.id}
        type={props.segredo ? "password" : "text"}
        autoComplete="off"
        value={props.valor}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
      />
      <p className="text-xs text-muted-foreground">{props.ajuda}</p>
    </div>
  );
}

function Ligar(props: { id: string; rotulo: string; ligado: boolean; onChange: (v: boolean) => void; ajuda: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border p-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor={props.id}>{props.rotulo}</Label>
        <p className="text-xs text-muted-foreground">{props.ajuda}</p>
      </div>
      <Switch id={props.id} checked={props.ligado} onCheckedChange={props.onChange} />
    </div>
  );
}

export function PreferenciaDeOrigem({ somenteDeAnuncio, idioma }: { somenteDeAnuncio: boolean; idioma: Idioma }) {
  const { t, isPending, salvar } = useSalvar(idioma);
  return (
    <Card className="p-6">
      <Ligar
        id="somente_de_anuncio"
        rotulo={t("Só pacientes que vieram de anúncio")}
        ligado={somenteDeAnuncio}
        onChange={(v) => {
          if (!isPending) salvar(() => updatePreferenciasDeConversao({ somente_de_anuncio: v }));
        }}
        ajuda={t(
          "Ligado (o padrão): só sai o agendamento de quem chegou por um anúncio daquela plataforma. Desligado: todo agendamento com telefone sai para as plataformas ligadas abaixo.",
        )}
      />
    </Card>
  );
}

export interface EtapaParaEscolher {
  id: string;
  /** Nome que o operador deu à etapa e ao funil: aparece só aqui, nunca sai para plataforma. */
  nome: string;
  funil: string;
}

export function EtapasDeSinalPago({
  etapas,
  marcadas,
  idioma,
}: {
  etapas: EtapaParaEscolher[];
  marcadas: string[];
  idioma: Idioma;
}) {
  const { t, isPending, salvar } = useSalvar(idioma);
  const [escolhidas, setEscolhidas] = useState<string[]>(marcadas);
  const alternar = (id: string, ligada: boolean) =>
    setEscolhidas((atual) => (ligada ? [...atual, id] : atual.filter((x) => x !== id)));

  return (
    <Card className="p-6">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          salvar(() => updatePreferenciasDeConversao({ etapas_de_sinal_pago: escolhidas }));
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t("Etapas que querem dizer sinal pago")}</h2>
          <p className="text-sm text-muted-foreground">
            {t(
              "Quando um negócio entra numa etapa marcada aqui, o sistema avisa as plataformas em que o sinal pago estiver ligado. Uma vez por negócio; sair da etapa depois não manda nada. O nome da etapa nunca sai.",
            )}
          </p>
        </div>
        {etapas.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhuma etapa de funil cadastrada.")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {etapas.map((etapa) => (
              <li key={etapa.id}>
                <label className="flex items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={escolhidas.includes(etapa.id)}
                    onChange={(e) => alternar(etapa.id, e.target.checked)}
                  />
                  <span>
                    {etapa.nome}
                    <span className="text-muted-foreground"> · {etapa.funil}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <div>
          <Button type="submit" disabled={isPending}>
            {isPending ? t("Salvando…") : t("Salvar etapas")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function FormularioMeta({ estado, idioma }: { estado: EstadoMeta; idioma: Idioma }) {
  const { t, isPending, salvar } = useSalvar(idioma);
  const [datasetId, setDatasetId] = useState(estado.datasetId ?? "");
  const [token, setToken] = useState("");
  const [codigoDeTeste, setCodigoDeTeste] = useState(estado.testEventCode ?? "");
  const [habilitada, setHabilitada] = useState(estado.habilitada);
  const [sinalPago, setSinalPago] = useState(estado.sinalPagoHabilitado);
  const podeSalvar = datasetId.trim().length >= 5 && (estado.temToken || token.trim().length >= 20);

  return (
    <Card className="p-6">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          salvar(
            () =>
              updateAdPlatformConnection({
                platform: "meta_ads",
                dataset_id: datasetId.trim(),
                access_token: token.trim() || undefined,
                test_event_code: codigoDeTeste.trim() || null,
                enabled: habilitada,
                deposit_paid_enabled: sinalPago,
              }),
            () => setToken(""),
          );
        }}
      >
        <h2 className="text-lg font-semibold">Meta</h2>
        <Campo
          id="dataset_id"
          rotulo={t("Identificador do conjunto de dados (pixel)")}
          valor={datasetId}
          onChange={setDatasetId}
          placeholder="123456789012345"
          ajuda={t("Só números. Fica no Gerenciador de Eventos, na fonte de dados que recebe as conversões.")}
        />
        <Campo
          id="access_token"
          rotulo={t("Token de acesso da API de Conversões")}
          valor={token}
          onChange={setToken}
          segredo
          placeholder={estado.temToken ? t("Gravado. Deixe em branco para manter.") : t("Cole o token gerado na plataforma")}
          ajuda={t("Guardado criptografado. Ele nunca volta para esta tela depois de salvo.")}
        />
        <Campo
          id="test_event_code"
          rotulo={t("Código de teste (opcional)")}
          valor={codigoDeTeste}
          onChange={setCodigoDeTeste}
          placeholder="TEST12345"
          ajuda={t("Enquanto preenchido, os agendamentos vão marcados como teste e não contam para a otimização. Apague quando terminar de conferir.")}
        />
        <Ligar
          id="meta_enabled"
          rotulo={t("Avisar a Meta quando um paciente agendar")}
          ligado={habilitada}
          onChange={setHabilitada}
          ajuda={t("Ao desligar, o envio para na hora, inclusive o que estava esperando nova tentativa, e a credencial continua gravada.")}
        />
        <Ligar
          id="meta_deposit_paid_enabled"
          rotulo={t("Avisar a Meta quando o sinal for pago")}
          ligado={sinalPago}
          onChange={setSinalPago}
          ajuda={t("Vai como o evento padrão CompleteRegistration, sem valor. Só sai para as etapas marcadas acima.")}
        />
        <div>
          <Button type="submit" disabled={isPending || !podeSalvar}>
            {isPending ? t("Salvando…") : t("Salvar Meta")}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function FormularioGoogle({ estado, idioma }: { estado: EstadoGoogle; idioma: Idioma }) {
  const { t, isPending, salvar } = useSalvar(idioma);
  const [customerId, setCustomerId] = useState(estado.customerId ?? "");
  const [loginCustomerId, setLoginCustomerId] = useState(estado.loginCustomerId ?? "");
  const [acao, setAcao] = useState(estado.conversionActionId ?? "");
  const [clientId, setClientId] = useState(estado.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [developerToken, setDeveloperToken] = useState("");
  const [habilitada, setHabilitada] = useState(estado.habilitada);
  const [acaoSinal, setAcaoSinal] = useState(estado.conversionActionIdSinalPago ?? "");
  const [sinalPago, setSinalPago] = useState(estado.sinalPagoHabilitado);
  const gravado = t("Gravado. Deixe em branco para manter.");
  const podeSalvar =
    customerId.trim().length >= 6 &&
    (!habilitada || acao.trim().length >= 1) &&
    (!sinalPago || acaoSinal.trim().length >= 1) &&
    clientId.trim().length >= 10 &&
    (estado.temClientSecret || clientSecret.trim().length >= 8) &&
    (estado.temRefreshToken || refreshToken.trim().length >= 10) &&
    (estado.temDeveloperToken || developerToken.trim().length >= 10);

  return (
    <Card className="p-6">
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          salvar(
            () =>
              updateAdPlatformConnection({
                platform: "google_ads",
                customer_id: customerId.trim(),
                login_customer_id: loginCustomerId.trim() || null,
                conversion_action_id: acao.trim() || null,
                deposit_paid_conversion_action_id: acaoSinal.trim() || null,
                client_id: clientId.trim(),
                client_secret: clientSecret.trim() || undefined,
                refresh_token: refreshToken.trim() || undefined,
                developer_token: developerToken.trim() || undefined,
                enabled: habilitada,
                deposit_paid_enabled: sinalPago,
              }),
            () => {
              setClientSecret("");
              setRefreshToken("");
              setDeveloperToken("");
            },
          );
        }}
      >
        <h2 className="text-lg font-semibold">Google Ads</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Vai como conversão aprimorada para leads: o Google casa pelo telefone criptografado. A ação de conversão precisa ser do tipo importação.",
          )}
        </p>
        <Campo id="customer_id" rotulo={t("ID do cliente do Google Ads")} valor={customerId} onChange={setCustomerId} placeholder="123-456-7890" ajuda={t("O número da conta, no canto de cima do Google Ads.")} />
        <Campo id="login_customer_id" rotulo={t("ID da conta administradora (opcional)")} valor={loginCustomerId} onChange={setLoginCustomerId} placeholder="123-456-7890" ajuda={t("Só se o acesso à conta for por uma conta administradora (MCC).")} />
        <Campo id="conversion_action_id" rotulo={t("ID da ação de conversão")} valor={acao} onChange={setAcao} placeholder="987654321" ajuda={t("Só números. Em Metas › Conversões, abra a ação e copie o id do endereço (ctId).")} />
        <Campo id="deposit_paid_conversion_action_id" rotulo={t("ID da ação de conversão do sinal pago")} valor={acaoSinal} onChange={setAcaoSinal} placeholder="987654322" ajuda={t("Outra ação de conversão, também do tipo importação, só para o sinal pago. Obrigatória se o sinal pago estiver ligado.")} />
        <Campo id="client_id" rotulo={t("ID do cliente OAuth")} valor={clientId} onChange={setClientId} placeholder="…apps.googleusercontent" ajuda={t("Do projeto no Google Cloud que tem a API do Google Ads ligada.")} />
        <Campo id="client_secret" rotulo={t("Chave secreta do cliente OAuth")} valor={clientSecret} onChange={setClientSecret} segredo placeholder={estado.temClientSecret ? gravado : ""} ajuda={t("Guardada criptografada.")} />
        <Campo id="refresh_token" rotulo={t("Token de atualização (refresh token)")} valor={refreshToken} onChange={setRefreshToken} segredo placeholder={estado.temRefreshToken ? gravado : ""} ajuda={t("Gerado com o mesmo cliente OAuth, com o escopo do Google Ads. Guardado criptografado.")} />
        <Campo id="developer_token" rotulo={t("Token de desenvolvedor")} valor={developerToken} onChange={setDeveloperToken} segredo placeholder={estado.temDeveloperToken ? gravado : ""} ajuda={t("Na Central de API da conta administradora. Guardado criptografado.")} />
        <Ligar
          id="google_enabled"
          rotulo={t("Avisar o Google Ads quando um paciente agendar")}
          ligado={habilitada}
          onChange={setHabilitada}
          ajuda={t("Ao desligar, o envio para na hora, inclusive o que estava esperando nova tentativa, e a credencial continua gravada.")}
        />
        <Ligar
          id="google_deposit_paid_enabled"
          rotulo={t("Avisar o Google Ads quando o sinal for pago")}
          ligado={sinalPago}
          onChange={setSinalPago}
          ajuda={t("Vai para a ação de conversão do sinal pago, sem valor. Só sai para as etapas marcadas acima.")}
        />
        <div>
          <Button type="submit" disabled={isPending || !podeSalvar}>
            {isPending ? t("Salvando…") : t("Salvar Google Ads")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
