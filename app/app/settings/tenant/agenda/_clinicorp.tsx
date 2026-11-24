"use client";
/**
 * AGENDA DA CLINICORP — a ocupação de uma agenda de fora entrando na Agenda.
 *
 * Quem marca na Clinicorp precisa que a IA e a tela do CRM saibam o que já está
 * tomado. Aqui o gestor cola a credencial da API da Clinicorp, o CRM copia a
 * ocupação (a cada 10 minutos, ou no "Copiar agora") e cada profissional de lá é
 * ligado a uma pessoa da Agenda. Só a ocupação de quem tem pessoa ligada conta.
 *
 * O token só entra: a rota nunca o devolve, então o campo fica vazio e diz que
 * há um guardado. Rotas: `/api/v1/agenda/clinicorp` e `/copiar`, manager+.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

type Situacao =
  | { configurada: false }
  | {
      configurada: true;
      usuario_api: string;
      assinante: string | null;
      ultima_copia: string | null;
      erro: string | null;
      ocupacoes_futuras: number;
      profissionais: Array<{ professional_id: string; nome: string | null; user_id: string | null }>;
    };

const CHAVE = ["agenda", "clinicorp"];

type Pessoas = Array<{ id: string; nome: string }>;

export function AgendaDaClinicorp({ pessoas }: { pessoas: Pessoas }) {
  const t = useT();
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
  return <Conteudo key={query.dataUpdatedAt} situacao={query.data} pessoas={pessoas} />;
}

function Conteudo({ situacao, pessoas }: { situacao: Situacao; pessoas: Pessoas }) {
  const t = useT();
  const qc = useQueryClient();
  const configurada = situacao.configurada;
  const [usuario, setUsuario] = React.useState(situacao.configurada ? situacao.usuario_api : "");
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
      recarregar();
    },
    onError: showApiError,
  });

  return (
    <section className="space-y-4 rounded-xl border p-4" data-testid="agenda-da-clinicorp">
      <div>
        <h2 className="font-semibold">{t("Agenda da Clinicorp")}</h2>
        <p className="text-sm text-text-muted">
          {t(
            "Se as consultas são marcadas na Clinicorp, o CRM copia de lá o que já está ocupado, a cada 10 minutos, e a Agenda e a IA deixam de oferecer esses horários. Só vêm início, fim e profissional: nada do paciente. Os horários de atendimento continuam sendo os da jornada e dos dias fora da rotina daqui.",
          )}
        </p>
      </div>

      {situacao.configurada ? (
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
            placeholder={configurada ? t("Guardado. Digite só para trocar.") : ""}
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
          disabled={!usuario.trim() || (!configurada && !token.trim()) || salvar.isPending}
        >
          {salvar.isPending ? t("Salvando…") : t("Salvar e copiar")}
        </Button>
        {configurada ? (
          <>
            <Button type="button" variant="outline" className="min-h-11" disabled={copiar.isPending} onClick={() => copiar.mutate()}>
              {copiar.isPending ? t("Copiando…") : t("Copiar agora")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={desligar.isPending}
              onClick={() => {
                if (window.confirm(t("Desligar a Clinicorp? A ocupação copiada sai da Agenda e a credencial é apagada."))) {
                  desligar.mutate();
                }
              }}
            >
              {t("Desligar")}
            </Button>
          </>
        ) : null}
      </form>
      <p className="text-xs text-text-muted">
        {t("Onde achar: na Clinicorp, Gerenciar Assinatura › Acesso Externo e Integrações › Integrações.")}
      </p>

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
    </section>
  );
}
