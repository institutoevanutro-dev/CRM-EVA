"use client";
/**
 * AGENDA DA CLINICORP — a ocupação de uma agenda de fora entrando na Agenda.
 *
 * Quem marca na Clinicorp precisa que a IA e a tela do CRM saibam o que já está
 * tomado. Dois caminhos, conforme o plano da clínica na Clinicorp:
 *
 * - WEBHOOK (migration 0434), para todos: o gestor gera aqui um endereço e o
 *   cadastra na "Gestão de Webhook" de lá. Por enquanto o CRM só MEDE o formato
 *   do que chega (nomes de campo e tipos, nunca valor), e a tela mostra o que
 *   foi medido; o parser que desconta a ocupação vem depois, contra esse formato.
 *   O endereço leva um token que só aparece UMA vez, ao ser gerado.
 * - API (migration 0433), só com o módulo API Externa da Clinicorp: o gestor
 *   cola a credencial, o CRM copia a ocupação a cada 10 minutos ou no "Copiar
 *   agora", e cada profissional de lá é ligado a uma pessoa da Agenda.
 *
 * Nenhum segredo volta do servidor: o token da API só entra (o campo fica vazio
 * e diz que há um guardado), e do webhook a rota devolve só se há endereço.
 * Rotas: `/api/v1/agenda/clinicorp`, `/copiar` e `/webhook`, manager+.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

type FormatoRecebido = {
  id: string;
  metodo: string;
  tipo_de_conteudo: string | null;
  cabecalhos: string[];
  linhas: string[];
  vezes: number;
  ultima_vez: string;
};

type Webhook = { ativo: boolean; ultima_batida: string | null; formatos: FormatoRecebido[] };

type Situacao =
  | { configurada: false }
  | {
      configurada: true;
      credencial: boolean;
      usuario_api: string | null;
      assinante: string | null;
      ultima_copia: string | null;
      erro: string | null;
      ocupacoes_futuras: number;
      webhook: Webhook;
      profissionais: Array<{ professional_id: string; nome: string | null; user_id: string | null }>;
    };

const CHAVE = ["agenda", "clinicorp"];

type Pessoas = Array<{ id: string; nome: string }>;

export function AgendaDaClinicorp({ pessoas }: { pessoas: Pessoas }) {
  const t = useT();
  // O endereço recém-gerado mora AQUI, acima da `key`: a releitura que vem depois
  // de gerar recria o formulário, e o endereço (que não volta do servidor) sumiria.
  const [endereco, setEndereco] = React.useState<string | null>(null);
  const query = useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: Situacao }>("/api/v1/agenda/clinicorp")).data,
  });
  if (query.isLoading) return <p>{t("Carregando…")}</p>;
  if (query.isError || !query.data) {
    return (
      <Button variant="outline" onClick={() => void query.refetch()}>
        {t("Tentar novamente")}
      </Button>
    );
  }
  // A `key` recria o formulário a cada leitura nova: o estado nasce do servidor,
  // sem efeito copiando dado para estado.
  return (
    <Conteudo
      key={query.dataUpdatedAt}
      situacao={query.data}
      pessoas={pessoas}
      endereco={endereco}
      setEndereco={setEndereco}
    />
  );
}

function Conteudo({
  situacao,
  pessoas,
  endereco,
  setEndereco,
}: {
  situacao: Situacao;
  pessoas: Pessoas;
  endereco: string | null;
  setEndereco: (e: string | null) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const configurada = situacao.configurada;
  const credencial = situacao.configurada && situacao.credencial;
  const [usuario, setUsuario] = React.useState(situacao.configurada ? (situacao.usuario_api ?? "") : "");
  const [token, setToken] = React.useState("");
  const [assinante, setAssinante] = React.useState(situacao.configurada ? (situacao.assinante ?? "") : "");
  const [mapa, setMapa] = React.useState<Record<string, string>>(
    situacao.configurada ? Object.fromEntries(situacao.profissionais.map((p) => [p.professional_id, p.user_id ?? ""])) : {},
  );

  // A Agenda também muda: a ocupação copiada tira horário da consulta.
  const recarregar = () => void qc.invalidateQueries({ queryKey: ["agenda"] });

  const copiar = useMutation({
    mutationFn: async () =>
      (await apiClient.post<{ data: { itens: number; gravados: number } }>("/api/v1/agenda/clinicorp/copiar", {})).data,
    onSuccess: (r) => {
      toast.success(`${t("Agenda da Clinicorp copiada")}: ${r.itens} ${t("horário(s) lido(s)")}.`);
      recarregar();
    },
    onError: (err) => {
      showApiError(err);
      recarregar();
    },
  });

  const salvar = useMutation({
    mutationFn: () =>
      apiClient.put("/api/v1/agenda/clinicorp", {
        usuario_api: usuario,
        ...(token.trim() ? { token_api: token } : {}),
        assinante: assinante.trim() || null,
      }),
    onSuccess: () => {
      setToken("");
      toast.success(t("Credencial da Clinicorp salva."));
      // Credencial nova já copia: quem salva quer ver se funcionou.
      copiar.mutate();
    },
    onError: showApiError,
  });

  const gerar = useMutation({
    mutationFn: async () =>
      (await apiClient.post<{ data: { caminho: string } }>("/api/v1/agenda/clinicorp/webhook", {})).data,
    onSuccess: (r) => {
      setEndereco(`${window.location.origin}${r.caminho}`);
      recarregar();
    },
    onError: showApiError,
  });

  const mapear = useMutation({
    mutationFn: () =>
      apiClient.patch("/api/v1/agenda/clinicorp", {
        profissionais: Object.entries(mapa).map(([professional_id, user_id]) => ({
          professional_id,
          user_id: user_id || null,
        })),
      }),
    onSuccess: () => {
      toast.success(t("Profissionais ligados."));
      recarregar();
    },
    onError: showApiError,
  });

  const desligar = useMutation({
    mutationFn: () => apiClient.delete("/api/v1/agenda/clinicorp", {}),
    onSuccess: () => {
      setUsuario("");
      setAssinante("");
      setMapa({});
      setEndereco(null);
      recarregar();
    },
    onError: showApiError,
  });

  const webhook = situacao.configurada ? situacao.webhook : null;

  return (
    <section className="space-y-4 rounded-xl border p-4" data-testid="agenda-da-clinicorp">
      <div>
        <h2 className="font-semibold">{t("Agenda da Clinicorp")}</h2>
        <p className="text-sm text-text-muted">
          {t(
            "Se as consultas são marcadas na Clinicorp, o CRM recebe de lá o que já está ocupado, e a Agenda e a IA deixam de oferecer esses horários. Só vêm início, fim e profissional: nada do paciente. Os horários de atendimento continuam sendo os da jornada e dos dias fora da rotina daqui.",
          )}
        </p>
      </div>

      <div className="space-y-2" data-testid="webhook-da-clinicorp">
        <h3 className="text-sm font-semibold">{t("Pelo webhook (qualquer plano da Clinicorp)")}</h3>
        <p className="text-sm text-text-muted">
          {t(
            "Gere o endereço e cadastre-o na Clinicorp, em Gerenciar Assinatura › Acesso Externo e integrações › Gestão de Webhook, com os eventos de agendamento.",
          )}
        </p>
        <p className="rounded-md bg-warning-bg p-2 text-sm text-warning-fg">
          {t(
            "Em teste: por enquanto o CRM só registra o formato do que a Clinicorp manda (nomes dos campos e tipos, nenhum valor). A Agenda passa a descontar esses horários depois que o formato for conferido.",
          )}
        </p>

        {endereco ? (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label={t("Endereço do webhook")}
                data-testid="endereco-do-webhook"
                className="min-w-0 flex-1 rounded-md border p-2 font-mono text-xs"
                readOnly
                value={endereco}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(endereco)
                    .then(() => toast.success(t("Endereço copiado.")))
                    .catch(() => toast.error(t("Não consegui copiar. Selecione o endereço e copie à mão.")))
                }
              >
                {t("Copiar")}
              </Button>
            </div>
            <p className="text-xs text-text-muted">
              {t("Guarde agora: por segurança, este endereço só aparece esta vez.")}
            </p>
          </div>
        ) : webhook?.ativo ? (
          <p className="text-sm">
            {t("Endereço já gerado. Ele só aparece uma vez; para ver de novo, gere outro (o anterior para de funcionar).")}
          </p>
        ) : null}

        <Button
          type="button"
          variant={webhook?.ativo || endereco ? "outline" : "default"}
          className="min-h-11"
          disabled={gerar.isPending}
          onClick={() => {
            if (
              !(webhook?.ativo || endereco) ||
              window.confirm(t("Gerar outro endereço? O atual para de funcionar e precisa ser trocado na Clinicorp."))
            ) {
              gerar.mutate();
            }
          }}
        >
          {gerar.isPending
            ? t("Gerando…")
            : webhook?.ativo || endereco
              ? t("Gerar novo endereço")
              : t("Gerar endereço do webhook")}
        </Button>

        {webhook?.ativo ? (
          <p className="text-sm" role="status" data-testid="batida-do-webhook">
            {webhook.ultima_batida
              ? `${t("Última batida recebida")}: ${new Date(webhook.ultima_batida).toLocaleString()}`
              : t("Nenhuma batida recebida ainda.")}
          </p>
        ) : null}

        {webhook && webhook.formatos.length > 0 ? (
          <details className="text-sm" data-testid="formatos-do-webhook">
            <summary className="cursor-pointer">
              {t("Formatos recebidos")} ({webhook.formatos.length})
            </summary>
            <div className="mt-2 space-y-3">
              {webhook.formatos.map((f) => (
                <div key={f.id} className="space-y-1">
                  <p className="text-xs text-text-muted">
                    {f.metodo} · {f.tipo_de_conteudo ?? "—"} · {f.vezes}× · {new Date(f.ultima_vez).toLocaleString()}
                  </p>
                  <pre className="overflow-x-auto rounded-md border p-2 text-xs">
                    {[`${t("cabeçalhos")}: ${f.cabecalhos.join(", ")}`, ...f.linhas].join("\n")}
                  </pre>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>

      <div className="space-y-2" data-testid="api-da-clinicorp">
        <h3 className="text-sm font-semibold">{t("Pela API (só com o módulo API Externa da Clinicorp)")}</h3>
        <p className="text-sm text-text-muted">
          {t(
            "O Usuário API e o Token API só existem para quem contratou o módulo API Externa. Com eles, o CRM copia a ocupação a cada 10 minutos. Sem o módulo, use o webhook acima.",
          )}
        </p>

        {situacao.configurada && situacao.credencial ? (
          <div className="space-y-1 text-sm" data-testid="situacao-da-clinicorp" role="status">
            <p>
              {situacao.ultima_copia
                ? `${t("Última cópia")}: ${new Date(situacao.ultima_copia).toLocaleString()} · ${situacao.ocupacoes_futuras} ${t("horário(s) ocupado(s) daqui para a frente")}`
                : t("Ainda não copiada.")}
            </p>
            {situacao.erro ? <p className="rounded-md bg-warning-bg p-2 text-warning-fg">{t(situacao.erro)}</p> : null}
          </div>
        ) : null}

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            salvar.mutate();
          }}
        >
          <label className="block">
            <span className="block text-sm">{t("Usuário API")}</span>
            <input
              aria-label={t("Usuário API")}
              className="mt-1 rounded-md border p-2"
              autoComplete="off"
              value={usuario}
              onChange={(e) => setUsuario(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-sm">{t("Token API")}</span>
            <input
              aria-label={t("Token API")}
              className="mt-1 rounded-md border p-2"
              type="password"
              autoComplete="new-password"
              placeholder={credencial ? t("Guardado. Digite só para trocar.") : ""}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="block text-sm">{t("ID do assinante (só conta de grupo)")}</span>
            <input
              aria-label={t("ID do assinante (só conta de grupo)")}
              className="mt-1 rounded-md border p-2"
              autoComplete="off"
              value={assinante}
              onChange={(e) => setAssinante(e.target.value)}
            />
          </label>
          <Button
            type="submit"
            className="min-h-11"
            disabled={!usuario.trim() || (!credencial && !token.trim()) || salvar.isPending}
          >
            {salvar.isPending ? t("Salvando…") : t("Salvar e copiar")}
          </Button>
          {credencial ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={copiar.isPending} onClick={() => copiar.mutate()}>
              {copiar.isPending ? t("Copiando…") : t("Copiar agora")}
            </Button>
          ) : null}
        </form>
        <p className="text-xs text-text-muted">
          {t("Onde achar: na Clinicorp, Gerenciar Assinatura › Acesso Externo e Integrações › Integrações.")}
        </p>
      </div>

      {situacao.configurada && situacao.profissionais.length > 0 ? (
        <div className="space-y-2" data-testid="profissionais-da-clinicorp">
          <h3 className="text-sm font-semibold">{t("Quem é quem")}</h3>
          <p className="text-sm text-text-muted">
            {t("Ligue cada profissional da Clinicorp à pessoa da Agenda. Sem pessoa ligada, a ocupação dele não tira horário de ninguém.")}
          </p>
          <ul className="space-y-1">
            {situacao.profissionais.map((p) => (
              <li key={p.professional_id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-48">{p.nome ?? `${t("Profissional")} ${p.professional_id}`}</span>
                <select
                  aria-label={`${t("Pessoa da Agenda para")} ${p.nome ?? p.professional_id}`}
                  className="rounded-md border p-2"
                  value={mapa[p.professional_id] ?? ""}
                  onChange={(e) => setMapa((m) => ({ ...m, [p.professional_id]: e.target.value }))}
                >
                  <option value="">{t("Ninguém")}</option>
                  {pessoas.map((pessoa) => (
                    <option key={pessoa.id} value={pessoa.id}>
                      {pessoa.nome}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
          <Button className="min-h-11" disabled={mapear.isPending} onClick={() => mapear.mutate()}>
            {mapear.isPending ? t("Salvando…") : t("Salvar quem é quem")}
          </Button>
        </div>
      ) : null}

      {configurada ? (
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          disabled={desligar.isPending}
          onClick={() => {
            if (
              window.confirm(
                t("Desligar a Clinicorp? A ocupação copiada sai da Agenda, a credencial é apagada e o endereço do webhook para de funcionar."),
              )
            ) {
              desligar.mutate();
            }
          }}
        >
          {t("Desligar")}
        </Button>
      ) : null}
    </section>
  );
}
