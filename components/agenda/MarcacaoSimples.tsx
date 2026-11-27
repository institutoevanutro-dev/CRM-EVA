"use client";

import { format } from "date-fns";
import Link from "next/link";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useContact } from "@/hooks/contacts/useContact";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { DURACAO_MAXIMA_MIN, DURACAO_MINIMA_MIN, duracaoDoCampo } from "@/lib/agenda/duracao-escolhida";
import { dataDeParede } from "@/lib/agenda/fuso";
import {
  fimDoHorario,
  ofertaDeUnidades,
  pacienteNovoPeloTipo,
  procedimentosDoProfissional,
  profissionaisComProcedimento,
  unidadeDaMarcacao,
} from "@/lib/agenda/marcacao-simples";
import type { CanalDaMarcacao } from "@/lib/agenda/tipos";
import { ApiError } from "@/lib/api/types";
import {
  ORIGENS_INFORMADAS,
  ROTULO_DA_ORIGEM_INFORMADA,
  origemDe,
  origemInformadaDe,
  type OrigemInformada,
} from "@/lib/contacts/origem-informada";
import {
  ehNomeCompleto,
  faltaNomeCompleto,
  nomeCompletoLimpo,
  nomeDoContato,
  sugestaoDeNomeCompleto,
} from "@/lib/contacts/rotulo-do-contato";
import { CaretRight, CheckCircle, Warning } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { AvisoSemLembrete } from "./AvisoSemLembrete";
import { BloqueioDeHorario } from "./BloqueioDeHorario";
import { CAMPO, ROTULO, Seletor, TITULO_DO_GRUPO } from "./CampoDaMarcacao";
import { NomeCompletoDoPaciente } from "./NomeCompletoDoPaciente";
import { QuandoDaMarcacao } from "./QuandoDaMarcacao";
import type { HorarioLivre, Pessoa } from "./tipos";
import { type ContatoDaMarcacao, VinculoDaMarcacao } from "./VinculoDaMarcacao";

/**
 * O "Novo agendamento" simples, no molde do que a clínica já usava: um modal
 * com duas abas, "Novo agendamento" e "Bloquear horário".
 *
 * A ordem dos campos é a ordem da decisão na recepção: PROFISSIONAL, depois o
 * PROCEDIMENTO e a UNIDADE que são dele (`procedimentosDoProfissional`,
 * `ofertaDeUnidades`), depois o paciente — com o cartão de conferência dos
 * dados dele —, o dia e o horário livre.
 *
 * Duas colunas no computador, e não um fluxo vertical, porque o dono da clínica
 * pediu marcar SEM ROLAR (`tests/e2e/agenda-painel-cabe-na-tela.spec.ts` mede em
 * 1280×800): à esquerda quem, o quê e para quem; à direita quando. No celular
 * vira uma coluna só, na mesma ordem. Os horários vêm da MESMA rota que a IA usa
 * (`useHorariosLivres`, montada em `_client.tsx`), então tela e agente oferecem
 * as mesmas vagas. O painel antigo, em três colunas, continua existindo para
 * REMARCAR e na vitrine; aqui é só a marcação nova.
 */

type Tipo = {
  id: string;
  nome: string;
  duracaoMin: number;
  donoId: string | null;
  localDetalhes: string | null;
  /** `requires_patient` (0411): sem paciente, a tela nem envia. */
  exigePaciente: boolean;
  /** `calendar_event_types.category`: decide o "Paciente novo / antigo" padrão. */
  categoria?: string | null;
};

type Unidade = { id: string; name: string; active: boolean };

/** O que a marcação leva ao POST, além de profissional, procedimento e paciente. */
export type MarcacaoConfirmada = {
  instante: string;
  /** Só quando a recepção mudou a duração (upstream #3714); ausente = a do procedimento. */
  duracaoMin?: number;
  convidado?: string;
  endereco: string;
  observacao: string;
  /** Mensagem ou ligação: obrigatório na tela, é a base do bônus por comparecimento. */
  canal: CanalDaMarcacao;
  /**
   * Quem converteu o lead (migration 0422). `null` = PACIENTE ANTIGO, sem
   * conversão: o POST manda `converted_by_kind: null` e a linha fica com as duas
   * colunas nulas (27/11/2026). Ausente não serve: a rota gravaria quem marca.
   */
  quemConverteu: { kind: "user"; userId: string } | { kind: "ai" } | null;
};

const ROTULO_DO_CANAL: Record<CanalDaMarcacao, string> = { mensagem: "Mensagem", ligacao: "Ligação" };

/** Foco visível dos botões crus do modal (dias, horários, canal). */
const FOCO = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500";
/** "(opcional)" ao lado do rótulo, mais leve que ele. */
const OPCIONAL = "font-normal text-text-subtle";

export function MarcacaoSimples({
  ancora,
  agora,
  usuarioId,
  pessoas,
  tipos,
  profissionalId,
  onProfissional,
  tipoId,
  onTipo,
  contactId,
  conversationId,
  onVinculo,
  unidades,
  unidadeId,
  onUnidade,
  fuso,
  horariosPorDia,
  publicouHorarios,
  erroAoCarregar,
  fusoSuposto,
  fontesDefasadas,
  googleCoberturaParcial,
  onMesVisivel,
  mesCarregado,
  horarioInicial,
  permiteEncaixe,
  podeBloquearDeOutros,
  duracao = null,
  onDuracao,
  onConfirmar,
  onVerNaAgenda,
}: {
  /** O dia de hoje NA ORGANIZAÇÃO: é onde o calendário abre. */
  ancora: Date;
  agora: Date;
  usuarioId: string;
  pessoas: Pessoa[];
  tipos: Tipo[];
  profissionalId: string;
  onProfissional: (id: string) => void;
  tipoId: string;
  onTipo: (id: string) => void;
  contactId: string;
  conversationId: string;
  onVinculo: (contact: string, conversation: string) => void;
  unidades: Unidade[];
  unidadeId: string;
  onUnidade: (id: string) => void;
  fuso?: string;
  horariosPorDia: Record<string, HorarioLivre[]>;
  publicouHorarios: boolean;
  erroAoCarregar: boolean;
  fusoSuposto: boolean;
  fontesDefasadas?: Array<{ nome?: string; desde?: string }>;
  googleCoberturaParcial?: boolean;
  onMesVisivel: (mes: Date) => void;
  mesCarregado: Date | null;
  /** O bloco clicado na grade: abre com dia e hora já escolhidos. */
  horarioInicial?: HorarioLivre;
  /** Hora fora dos horários livres vale (encaixe): só para quem é da equipe e pode marcar. */
  permiteEncaixe: boolean;
  /** manager+ bloqueia a agenda de qualquer pessoa; o resto, só a própria. */
  podeBloquearDeOutros: boolean;
  /**
   * O texto do campo "Duração (min)"; `null` = a do procedimento (upstream
   * #3714). Mora em quem chama porque entra na consulta dos horários livres.
   */
  duracao?: string | null;
  onDuracao?: (texto: string | null) => void;
  onConfirmar: (m: MarcacaoConfirmada) => Promise<unknown>;
  onVerNaAgenda: (instante: string) => void;
}) {
  const t = useT();
  const locale = useLocaleDeData();
  const [aba, setAba] = React.useState<"marcar" | "bloquear">("marcar");

  // Só quem tem procedimento entra na lista; um escolhido de fora dela (a grade
  // abre o modal com a pessoa filtrada) é limpo, para o campo não mostrar uma
  // pessoa que a lista não tem.
  const profissionais = profissionaisComProcedimento(pessoas, tipos);
  const profissionalForaDaLista = Boolean(profissionalId) && !profissionais.some((p) => p.id === profissionalId);
  React.useEffect(() => {
    if (profissionalForaDaLista) onProfissional("");
  }, [profissionalForaDaLista, onProfissional]);
  const procedimentos = procedimentosDoProfissional(tipos, profissionalId);
  // Só vale o procedimento que é DESTE profissional: um id que sobrou de outro
  // (a grade abre o modal com o tipo dela) não conta como escolhido.
  const tipo = procedimentos.find((p) => p.id === tipoId) ?? null;
  const profissional = pessoas.find((p) => p.id === profissionalId);

  // UNIDADE: só onde o profissional atende (a jornada dele), e a que valer passa a
  // ser a do formulário — trocar de profissional limpa a que deixou de valer e
  // pré-escolhe a única. Quem mora em `_client.tsx` é o estado, porque a unidade
  // entra na consulta dos horários livres.
  const temUnidades = unidades.some((u) => u.active);
  const oferta = ofertaDeUnidades(unidades, profissional);
  const unidadeValida = profissionalId ? unidadeDaMarcacao(oferta, unidadeId) : unidadeId;
  React.useEffect(() => {
    if (temUnidades && profissionalId && unidadeValida !== unidadeId) onUnidade(unidadeValida);
  }, [temUnidades, profissionalId, unidadeValida, unidadeId, onUnidade]);
  const faltaUnidade = temUnidades && Boolean(profissionalId) && !oferta.semUnidade && unidadeValida === "";
  const nomeDaUnidade = unidades.find((u) => u.id === unidadeValida)?.name ?? null;
  // `null` = texto inválido: o aviso aparece e o Confirmar trava.
  const duracaoMin = tipo ? duracaoDoCampo(duracao, tipo.duracaoMin) : null;

  const [dia, setDia] = React.useState<Date>(() =>
    horarioInicial ? new Date(horarioInicial.instante) : ancora,
  );
  const [horario, setHorario] = React.useState<HorarioLivre | null>(horarioInicial ?? null);
  const [marcado, setMarcado] = React.useState<HorarioLivre | null>(null);
  const [recusa, setRecusa] = React.useState<{ instante: string; mensagem: string } | null>(null);
  const [enviando, setEnviando] = React.useState(false);
  // O tipo em que se pediu para confirmar sem paciente (tela ou 422 `patient_required`).
  // Some sozinho ao escolher o paciente ou trocar de procedimento.
  const [semPacienteNoTipo, setSemPacienteNoTipo] = React.useState<string | null>(null);
  const faltaPaciente = !contactId && semPacienteNoTipo !== null && semPacienteNoTipo === tipo?.id;
  const [observacao, setObservacao] = React.useState("");
  // "Mensagem" já vem escolhida (pedido do dono da clínica em 21/11/2026): é o
  // caso comum, e a recepção só toca em "Ligação" quando foi por telefone.
  const [canal, setCanal] = React.useState<CanalDaMarcacao | null>("mensagem");
  const [convidado, setConvidado] = React.useState("");
  // Endereço não editado herda o do procedimento; trocar de procedimento volta
  // ao dele, senão o endereço de um viaja para outro atendimento.
  const [enderecoEditado, setEnderecoEditado] = React.useState<string | null>(null);
  const endereco = enderecoEditado ?? tipo?.localDetalhes ?? "";

  const convidadoLimpo = convidado.trim();
  const convidadoInvalido = convidadoLimpo.length > 0 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(convidadoLimpo);

  // NOME COMPLETO: o prontuário abre o atendimento pelo nome do CADASTRO e
  // recusa sem ele. Paciente que só tem o nome do WhatsApp ganha o campo, já
  // preenchido com ele, e o Confirmar espera até a recepção conferir. O cadastro
  // vem do `VinculoDaMarcacao` (é ele que busca o contato); enquanto não chega,
  // não dá para dizer que o nome está completo, e o Confirmar espera também.
  const [contato, setContato] = React.useState<ContatoDaMarcacao | null>(null);
  const doPaciente = contactId && contato?.id === contactId ? contato : null;
  const cadastroCarregado = !contactId || doPaciente !== null;
  const pedeNome = doPaciente !== null && faltaNomeCompleto(doPaciente);
  // A10: quem pediu para não receber mensagens não recebe o lembrete
  // (`cron/agenda-reminder` pula `contato_bloqueado`). Marcar continua
  // permitido; o rodapé avisa para confirmar por telefone.
  const semLembrete = doPaciente?.is_blocked === true ? (nomeDoContato(doPaciente) ?? t("O paciente")) : null;
  // O nome digitado vale para AQUELE paciente: trocar de paciente volta à
  // sugestão do novo, senão o nome de um viajaria para o cadastro do outro.
  const [nomeEditado, setNomeEditado] = React.useState<{ contactId: string; valor: string } | null>(null);
  const nomeCompleto =
    nomeEditado && nomeEditado.contactId === contactId ? nomeEditado.valor : sugestaoDeNomeCompleto(doPaciente);
  const nomeResolvido = !pedeNome || ehNomeCompleto(nomeCompleto);
  const gravarContato = useUpdateContact(contactId);

  // QUEM CONVERTEU (migration 0422): quem está marcando, até alguém escolher
  // outra pessoa da equipe ou a IA do atendimento (pedido de 21/11/2026).
  const [quemConverteu, setQuemConverteu] = React.useState<string>(() => `user:${usuarioId}`);

  // ORIGEM DO LEAD: a MESMA conta do funil por origem do Marketing (`origemDe`),
  // lida da ficha do paciente. Mudar aqui grava o "Como chegou" da ficha no
  // Confirmar, pelo mesmo PATCH do nome; a marca do anúncio não se troca à mão.
  const ficha = useContact(contactId);
  const dadosDaFicha = contactId && ficha.data?.data?.id === contactId ? ficha.data.data : null;
  const metaDaFicha = (dadosDaFicha?.source_metadata ?? null) as Record<string, unknown> | null;
  const plataformaDoAnuncio = typeof metaDaFicha?.ad_platform === "string" ? metaDaFicha.ad_platform : null;
  const veioDoAnuncio = plataformaDoAnuncio === "meta_ads" || plataformaDoAnuncio === "google_ads";
  const origemDaFicha: OrigemInformada | null = dadosDaFicha
    ? origemDe({
        adPlatform: plataformaDoAnuncio,
        tags: [...(dadosDaFicha.tags ?? []), dadosDaFicha.source].filter((x): x is string => Boolean(x)),
        informada: origemInformadaDe(metaDaFicha),
      })
    : null;
  const [origemEditada, setOrigemEditada] = React.useState<{ contactId: string; valor: OrigemInformada } | null>(null);
  const origem = origemEditada && origemEditada.contactId === contactId ? origemEditada.valor : origemDaFicha;
  const origemMudou = origem !== null && origemDaFicha !== null && origem !== origemDaFicha;

  // PACIENTE NOVO OU ANTIGO (decisão do André, 27/11/2026). O padrão sai do
  // procedimento (`pacienteNovoPeloTipo`); a troca da recepção vale só para o
  // procedimento em que foi feita — escolher outro volta ao padrão dele. O modo
  // em si não é gravado (DIRC: calcular, não duplicar); o que ele muda na linha
  // é a conversão: em antigo, `converted_by_kind` e `converted_by_user_id` nulos.
  const [modoEscolhido, setModoEscolhido] = React.useState<{ tipoId: string; novo: boolean } | null>(null);
  const pacienteNovo =
    modoEscolhido !== null && modoEscolhido.tipoId === (tipo?.id ?? "")
      ? modoEscolhido.novo
      : pacienteNovoPeloTipo(tipo);

  const parede = (iso: string): Date => (fuso ? dataDeParede(new Date(iso), fuso) : new Date(iso));

  // Trocar profissional ou procedimento muda as vagas: o horário escolhido
  // deixa de valer. O DIA fica, que é o que a recepção combinou com o paciente.
  const trocarProfissional = (id: string) => {
    onProfissional(id);
    if (!id) onTipo("");
    onDuracao?.(null);
    setHorario(null);
  };
  const trocarProcedimento = (id: string) => {
    onTipo(id);
    onDuracao?.(null);
    setEnderecoEditado(null);
    setHorario(null);
  };
  // A lista de horários era de outra duração: o horário escolhido deixa de valer.
  const trocarDuracao = (texto: string) => {
    onDuracao?.(texto);
    setHorario(null);
  };

  const pronto = Boolean(
    profissionalId &&
      tipo &&
      duracaoMin !== null &&
      horario &&
      canal &&
      !faltaUnidade &&
      !convidadoInvalido &&
      cadastroCarregado &&
      nomeResolvido,
  );
  const tempo = marcado ? "marcado" : horario ? "confirmando" : tipo ? "escolhendo-horario" : "escolhendo-dia";

  const confirmar = async () => {
    if (!horario || !pronto || !canal) return;
    if (tipo?.exigePaciente && !contactId) {
      setSemPacienteNoTipo(tipo.id);
      return;
    }
    setEnviando(true);
    try {
      // O nome vai ANTES do agendamento, pelo caminho de sempre da ficha
      // (`PATCH /api/v1/contacts/[id]`, auditado como `contact.updated`). Se a
      // gravação for recusada, nada é marcado: a recusa aparece no rodapé.
      // Nome e origem vão juntos, num PATCH só, e só o que mudou.
      // Paciente antigo não mexe na origem: os campos nem estão na tela.
      const origemParaGravar = pacienteNovo && origemMudou ? origem : null;
      if (pedeNome || origemParaGravar) {
        await gravarContato.mutateAsync({
          ...(pedeNome ? { name: nomeCompletoLimpo(nomeCompleto) } : {}),
          ...(origemParaGravar ? { origem_informada: origemParaGravar } : {}),
        });
      }
      await onConfirmar({
        instante: horario.instante,
        duracaoMin: duracao === null ? undefined : (duracaoMin ?? undefined),
        convidado: convidadoLimpo || undefined,
        endereco: endereco.trim(),
        observacao: observacao.trim(),
        canal,
        // Paciente antigo grava SEM conversão (as duas colunas nulas): ela foi na
        // primeira consulta, e não é de quem marca a aplicação.
        quemConverteu: !pacienteNovo
          ? null
          : quemConverteu.startsWith("user:")
            ? { kind: "user", userId: quemConverteu.slice("user:".length) }
            : { kind: "ai" },
      });
      setRecusa(null);
      setMarcado(horario);
    } catch (err) {
      if (err instanceof ApiError && err.code === "patient_required" && tipo) {
        setSemPacienteNoTipo(tipo.id);
        return;
      }
      setRecusa({
        instante: horario.instante,
        mensagem:
          err instanceof ApiError && err.status >= 400 && err.status < 500
            ? err.message
            : t("Não foi marcado. Tente de novo."),
      });
    } finally {
      setEnviando(false);
    }
  };

  const faixaDoHorario = (h: HorarioLivre) =>
    tipo
      ? `${h.rotulo} ${t("às")} ${format(parede(fimDoHorario(h.instante, duracaoMin ?? tipo.duracaoMin)), "HH:mm")}`
      : h.rotulo;

  // O que vai ser marcado, numa linha: procedimento, quem atende, onde e para quem.
  const resumo = [tipo?.nome, profissional?.nome, nomeDaUnidade, doPaciente ? nomeDoContato(doPaciente) : null]
    .filter(Boolean)
    .join(" · ");

  if (marcado) {
    return (
      <div data-testid="painel-de-marcacao" data-tempo="marcado" className="flex flex-col items-center px-6 py-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-success-bg">
          <CheckCircle size={28} weight="duotone" className="text-success" aria-hidden />
        </span>
        <h3 className="mt-4 text-lg font-semibold tracking-tight">{t("Marcado.")}</h3>
        <p className="mt-1 text-sm text-text first-letter:uppercase">
          {format(parede(marcado.instante), t("EEEE, d 'de' MMMM"), { locale })},{" "}
          <span className="tabular-nums">{faixaDoHorario(marcado)}</span>
        </p>
        <p className="mt-1 max-w-md text-xs text-text-muted">{resumo}</p>
        {/* Repetido no sucesso: o rodapé sumiu, e quem fecha agora não saberia
            que este agendamento não terá lembrete. */}
        {semLembrete ? <AvisoSemLembrete nome={semLembrete} className="mt-4 text-left" /> : null}
        <div className="mt-6 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setMarcado(null);
              setHorario(null);
              setObservacao("");
              setConvidado("");
              setEnderecoEditado(null);
            }}
          >
            {t("Marcar outro")}
          </Button>
          <Button size="sm" data-testid="ver-na-agenda" onClick={() => onVerNaAgenda(marcado.instante)}>
            {t("Ver na agenda")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Tabs value={aba} onValueChange={(v) => setAba(v === "bloquear" ? "bloquear" : "marcar")} className="flex min-h-0 flex-col">
      <TabsList className="mx-5 mt-1 self-start bg-surface-muted" data-testid="abas-da-marcacao">
        <TabsTrigger value="marcar" data-testid="aba-novo-agendamento">
          {t("Novo agendamento")}
        </TabsTrigger>
        <TabsTrigger value="bloquear" data-testid="aba-bloquear-horario">
          {t("Bloquear horário")}
        </TabsTrigger>
      </TabsList>

      {/* Montada sempre: ir até "Bloquear horário" e voltar não apaga o que já
          foi escolhido para o paciente. */}
      <TabsContent value="marcar" forceMount className="mt-0 data-[state=inactive]:hidden">
        <div data-testid="painel-de-marcacao" data-tempo={tempo} className="flex flex-col">
          <div className="grid gap-x-6 gap-y-5 px-5 pb-5 pt-4 md:grid-cols-2">
            {/* ── esquerda: quem, o quê, onde e para quem ──────────────────── */}
            <div className="flex min-w-0 flex-col gap-4">
              <h3 className={cn(TITULO_DO_GRUPO, "-mb-2")}>{t("Quem e o quê")}</h3>
              <div className="grid gap-x-3 gap-y-4 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
                <div className="min-w-0">
                  <label htmlFor="profissional-da-marcacao" className={ROTULO}>
                    {t("Profissional")} *
                  </label>
                  <Seletor
                    id="profissional-da-marcacao"
                    data-testid="profissional-da-marcacao"
                    value={profissionalId}
                    onChange={(e) => trocarProfissional(e.target.value)}
                  >
                    <option value="">{t("Escolha o profissional")}</option>
                    {profissionais.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.id === usuarioId ? `${p.nome} (${t("você")})` : p.nome}
                      </option>
                    ))}
                  </Seletor>
                </div>

                <div data-testid="tipos-de-agendamento" className="min-w-0">
                  <label htmlFor="procedimento-da-marcacao" className={ROTULO}>
                    {t("Procedimento")} *
                  </label>
                  <Seletor
                    id="procedimento-da-marcacao"
                    data-testid="procedimento-da-marcacao"
                    value={tipo?.id ?? ""}
                    disabled={!profissionalId || procedimentos.length === 0}
                    aria-describedby={profissionais.length === 0 ? "sem-procedimento" : undefined}
                    onChange={(e) => trocarProcedimento(e.target.value)}
                  >
                    <option value="">
                      {!profissionalId
                        ? t("Escolha antes o profissional")
                        : procedimentos.length === 0
                          ? t("Nenhum procedimento cadastrado")
                          : t("Escolha o procedimento")}
                    </option>
                    {procedimentos.map((p) => (
                      <option key={p.id} value={p.id}>
                        {`${p.nome} · ${p.duracaoMin} ${t("min")}`}
                      </option>
                    ))}
                  </Seletor>
                </div>
              </div>

              {/* Ninguém com procedimento (instalação nova): dizer POR QUÊ e ONDE
                  resolver, em vez de uma lista vazia e muda. */}
              {profissionais.length === 0 ? (
                <div
                  id="sem-procedimento"
                  data-testid="sem-procedimento-do-profissional"
                  className="rounded-md border border-dashed border-border-strong px-3 py-2.5"
                >
                  <p className="text-xs font-medium text-text">
                    {t("Nenhum profissional tem procedimento cadastrado.")}
                  </p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {t("Cadastre em Tipos de agendamento, no campo “Quem atende”.")}{" "}
                    <Link
                      href="/app/settings/tenant/agenda"
                      className="font-medium text-accent underline underline-offset-2"
                    >
                      {t("Abrir Tipos de agendamento")}
                    </Link>
                  </p>
                </div>
              ) : null}

              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
                <div>
                  <label htmlFor="duracao-da-marcacao" className={ROTULO}>
                    {t("Duração (minutos)")}
                  </label>
                  {/* Sempre na tela, desligada até o procedimento: o formulário não
                      pula de lugar quando ele é escolhido. */}
                  <input
                    id="duracao-da-marcacao"
                    data-testid="duracao-da-marcacao"
                    type="number"
                    inputMode="numeric"
                    min={DURACAO_MINIMA_MIN}
                    max={DURACAO_MAXIMA_MIN}
                    step={5}
                    disabled={!tipo}
                    placeholder="—"
                    className={cn(CAMPO, "w-28 tabular-nums")}
                    value={tipo ? (duracao ?? String(tipo.duracaoMin)) : ""}
                    onChange={(e) => trocarDuracao(e.target.value)}
                    aria-invalid={(tipo && duracaoMin === null) || undefined}
                    aria-describedby={tipo ? "ajuda-da-duracao" : undefined}
                  />
                </div>
                {temUnidades ? (
                  <div className="min-w-0">
                    <label htmlFor="unidade-do-agendamento" className={ROTULO}>
                      {t("Unidade")}
                      {faltaUnidade ? " *" : null}
                    </label>
                    <Seletor
                      id="unidade-do-agendamento"
                      data-testid="unidade-do-agendamento"
                      value={unidadeValida}
                      disabled={!profissionalId}
                      aria-invalid={(faltaUnidade && Boolean(horario)) || undefined}
                      onChange={(e) => {
                        onUnidade(e.target.value);
                        setHorario(null);
                      }}
                    >
                      {!profissionalId ? (
                        <option value="">{t("Escolha antes o profissional")}</option>
                      ) : oferta.semUnidade ? (
                        <option value="">{t("Teleconsulta ou sem unidade")}</option>
                      ) : (
                        <option value="" disabled>
                          {t("Escolha a unidade")}
                        </option>
                      )}
                      {profissionalId
                        ? oferta.unidades.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))
                        : null}
                    </Seletor>
                  </div>
                ) : null}
                {tipo ? (
                  <p
                    id="ajuda-da-duracao"
                    role={duracaoMin === null ? "alert" : undefined}
                    data-testid={duracaoMin === null ? "duracao-invalida" : undefined}
                    className={cn("col-span-2 text-xs", duracaoMin === null ? "text-warning-fg" : "text-text-subtle")}
                  >
                    {duracaoMin === null
                      ? t("Escolha uma duração entre 5 e 1440 minutos.")
                      : t("Já vem do procedimento. Mude só se este atendimento precisar.")}
                  </p>
                ) : null}
                {/* A jornada dele não diz onde atende: todas aparecem, e a tela
                    diz por quê (`ofertaDeUnidades`). */}
                {temUnidades && profissionalId && !oferta.daJornada ? (
                  <p data-testid="unidades-sem-jornada" className="col-span-2 text-xs text-text-subtle">
                    {t("A jornada deste profissional não diz em que unidade ele atende, por isso todas aparecem.")}{" "}
                    <Link href="/app/team?aba=atendimento" className="font-medium text-accent underline underline-offset-2">
                      {t("Definir na jornada")}
                    </Link>
                  </p>
                ) : null}
              </div>

              <div className="-mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className={TITULO_DO_GRUPO}>{t("Paciente")}</h3>
                <fieldset data-testid="tipo-de-paciente" className="flex items-center">
                  <legend className="sr-only">{t("Tipo de paciente")}</legend>
                  <span className="inline-flex rounded-md border border-border-input bg-surface p-0.5">
                    {(
                      [
                        ["novo", "Paciente novo"],
                        ["antigo", "Paciente antigo"],
                      ] as const
                    ).map(([valor, rotulo]) => {
                      const ativo = (valor === "novo") === pacienteNovo;
                      return (
                        <button
                          key={valor}
                          type="button"
                          data-testid={`paciente-${valor}`}
                          aria-pressed={ativo}
                          onClick={() => setModoEscolhido({ tipoId: tipo?.id ?? "", novo: valor === "novo" })}
                          className={cn(
                            "h-7 rounded-sm px-3 text-xs font-medium transition-colors duration-fast toque:h-10",
                            FOCO,
                            ativo ? "bg-accent text-accent-foreground shadow-xs" : "text-text-muted hover:text-text",
                          )}
                        >
                          {t(rotulo)}
                        </button>
                      );
                    })}
                  </span>
                </fieldset>
              </div>
              <div>
                <VinculoDaMarcacao
                  compacto
                  contactId={contactId}
                  conversationId={conversationId}
                  onChange={onVinculo}
                  onContato={setContato}
                />
                {faltaPaciente ? (
                  <p data-testid="falta-paciente-na-marcacao" role="alert" className="mt-1.5 text-xs text-warning-fg">
                    {t("Escolha o paciente para marcar uma consulta.")}
                  </p>
                ) : null}
              </div>

              {pedeNome ? (
                <NomeCompletoDoPaciente
                  id="nome-completo-da-marcacao"
                  valor={nomeCompleto}
                  onValor={(valor) => setNomeEditado({ contactId, valor })}
                />
              ) : null}

              {pacienteNovo ? (
              <div className="grid gap-x-3 gap-y-4 sm:grid-cols-2">
                <div className="min-w-0">
                  <label htmlFor="quem-converteu" className={ROTULO}>
                    {t("Quem converteu")}
                  </label>
                  <Seletor
                    id="quem-converteu"
                    data-testid="quem-converteu"
                    value={quemConverteu}
                    onChange={(e) => setQuemConverteu(e.target.value)}
                  >
                    {/* Quem marca é o padrão e precisa estar na lista mesmo antes de a
                        equipe carregar, senão o campo mostraria outra pessoa. */}
                    {pessoas.some((p) => p.id === usuarioId) ? null : (
                      <option value={`user:${usuarioId}`}>{t("Você")}</option>
                    )}
                    {pessoas.map((p) => (
                      <option key={p.id} value={`user:${p.id}`}>
                        {p.id === usuarioId ? `${p.nome} (${t("você")})` : p.nome}
                      </option>
                    ))}
                    <option value="ai">{t("IA do atendimento")}</option>
                  </Seletor>
                </div>
                <div className="min-w-0">
                  <label htmlFor="origem-do-lead" className={ROTULO}>
                    {t("Origem do lead")}
                  </label>
                  <Seletor
                    id="origem-do-lead"
                    data-testid="origem-do-lead"
                    value={origem ?? ""}
                    disabled={!dadosDaFicha || veioDoAnuncio}
                    aria-describedby={veioDoAnuncio ? "origem-pelo-anuncio" : undefined}
                    onChange={(e) =>
                      setOrigemEditada({ contactId, valor: e.target.value as OrigemInformada })
                    }
                  >
                    {!dadosDaFicha ? (
                      <option value="">{contactId ? t("Carregando…") : t("Escolha antes o paciente")}</option>
                    ) : null}
                    {ORIGENS_INFORMADAS.map((o) => (
                      <option key={o} value={o}>
                        {t(ROTULO_DA_ORIGEM_INFORMADA[o])}
                      </option>
                    ))}
                  </Seletor>
                  {veioDoAnuncio ? (
                    <p id="origem-pelo-anuncio" className="mt-1 text-xs text-text-subtle">
                      {t("Marcada pelo clique no anúncio.")}
                    </p>
                  ) : null}
                </div>
              </div>
              ) : null}

              <div>
                <label htmlFor="observacao-do-compromisso" className={ROTULO}>
                  {t("Observação")} <span className={OPCIONAL}>({t("opcional")})</span>
                </label>
                <textarea
                  id="observacao-do-compromisso"
                  data-testid="observacao-do-compromisso"
                  rows={2}
                  maxLength={2000}
                  value={observacao}
                  onChange={(e) => setObservacao(e.target.value)}
                  className={cn(CAMPO, "h-auto resize-none py-2 leading-snug")}
                  placeholder={t("Aparece na descrição do compromisso.")}
                />
              </div>

              {/* O que quase nunca se usa fica recolhido: convite por e-mail e
                  endereço fora do padrão do procedimento. */}
              <details data-testid="mais-opcoes" className="group -mt-1 text-sm">
                <summary
                  className={cn(
                    "inline-flex cursor-pointer select-none list-none items-center gap-1 rounded-sm text-xs font-medium text-accent [&::-webkit-details-marker]:hidden",
                    FOCO,
                  )}
                >
                  <CaretRight
                    size={12}
                    weight="bold"
                    aria-hidden
                    className="transition-transform duration-fast ease-out group-open:rotate-90"
                  />
                  {t("Mais opções")}
                </summary>
                <div className="mt-3 flex flex-col gap-4">
                  <div>
                    <label htmlFor="email-do-convidado" className={ROTULO}>
                      {t("E-mail do convidado")} <span className={OPCIONAL}>({t("opcional")})</span>
                    </label>
                    <input
                      id="email-do-convidado"
                      data-testid="email-do-convidado"
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      value={convidado}
                      onChange={(e) => setConvidado(e.target.value)}
                      aria-invalid={convidadoInvalido || undefined}
                      aria-describedby="ajuda-do-convidado"
                      className={CAMPO}
                      placeholder={t("cliente@empresa.com")}
                    />
                    <p
                      id="ajuda-do-convidado"
                      className={cn("mt-1.5 text-xs", convidadoInvalido ? "text-error-fg" : "text-text-subtle")}
                    >
                      {convidadoInvalido
                        ? t("Endereço inválido. Confira antes de marcar.")
                        : t("Preenchido, o Google envia o convite por e-mail para esta pessoa.")}
                    </p>
                  </div>
                  <div>
                    <label htmlFor="endereco-do-compromisso" className={ROTULO}>
                      {t("Endereço ou local")} <span className={OPCIONAL}>({t("opcional")})</span>
                    </label>
                    <input
                      id="endereco-do-compromisso"
                      data-testid="endereco-do-compromisso"
                      type="text"
                      maxLength={300}
                      value={endereco}
                      onChange={(e) => setEnderecoEditado(e.target.value)}
                      className={CAMPO}
                      placeholder={t("Sala, unidade ou endereço deste horário")}
                    />
                  </div>
                </div>
              </details>
            </div>

            {/* ── direita: quando (o mesmo componente do Remarcar do painel) ── */}
            <QuandoDaMarcacao
              ancora={ancora}
              agora={agora}
              fuso={fuso}
              horariosPorDia={horariosPorDia}
              publicouHorarios={publicouHorarios}
              erroAoCarregar={erroAoCarregar}
              fusoSuposto={fusoSuposto}
              fontesDefasadas={fontesDefasadas}
              googleCoberturaParcial={googleCoberturaParcial}
              onMesVisivel={onMesVisivel}
              mesCarregado={mesCarregado}
              temTipo={Boolean(tipo)}
              avisoSemTipo={t("Escolha o profissional e o procedimento para ver os horários livres.")}
              permiteEncaixe={permiteEncaixe}
              abriuComHorario={Boolean(horarioInicial)}
              dia={dia}
              onDia={setDia}
              horario={horario}
              onHorario={setHorario}
            />
          </div>

          {/* ── rodapé: o resumo com o fim calculado e o Confirmar ──────────── */}
          <div
            data-testid="confirmacao"
            className="sticky bottom-0 flex flex-col gap-3 border-t border-border bg-surface px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 text-sm">
              {horario && tipo ? (
                <>
                  <p className="text-text">
                    <span className="font-semibold first-letter:uppercase">
                      {format(parede(horario.instante), t("EEEE, d 'de' MMMM"), { locale })}
                    </span>
                    <span className="text-text-muted">
                      {", "}
                      <span data-testid="faixa-do-horario" className="tabular-nums">
                        {faixaDoHorario(horario)}
                      </span>{" "}
                      ({duracaoMin ?? tipo.duracaoMin} {t("min")})
                    </span>
                  </p>
                  <p data-testid="resumo-da-marcacao" className="mt-0.5 truncate text-xs text-text-muted">
                    {resumo}
                  </p>
                </>
              ) : (
                <p className="text-text-subtle">{t("Escolha profissional, procedimento, dia e horário.")}</p>
              )}
              {horario && faltaUnidade ? (
                <p data-testid="falta-unidade-na-marcacao" className="mt-1 text-xs text-warning-fg">
                  {t("Escolha a unidade do atendimento.")}
                </p>
              ) : null}
              {horario && !canal ? (
                // Com tudo escolhido, o Confirmar ficava cinza sem dizer por quê
                // (achado 17, 16/11): falta só como a consulta foi marcada.
                <p data-testid="falta-canal-na-marcacao" className="mt-1 text-xs text-warning-fg">
                  {t("Escolha como foi marcada: Mensagem ou Ligação.")}
                </p>
              ) : null}
              {semLembrete ? <AvisoSemLembrete nome={semLembrete} className="mt-2" /> : null}
              {!nomeResolvido ? (
                <p data-testid="falta-nome-na-marcacao" className="mt-1 text-xs text-warning-fg">
                  {t("Complete o nome do paciente para marcar.")}
                </p>
              ) : null}
              {recusa && horario && recusa.instante === horario.instante ? (
                <p data-testid="recusa-da-marcacao" role="alert" className="mt-1 flex gap-1.5 text-xs text-text">
                  <Warning size={14} weight="fill" className="mt-0.5 shrink-0 text-warning" aria-hidden />
                  {recusa.mensagem}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
              <fieldset className="flex items-center gap-2" data-testid="canal-da-marcacao">
                <legend className="sr-only">{t("Como a consulta foi marcada")}</legend>
                <span aria-hidden className="text-xs text-text-muted">
                  {t("Marcada por")}
                </span>
                <span className="inline-flex rounded-md border border-border-input bg-surface p-0.5">
                  {(["mensagem", "ligacao"] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      data-testid={`canal-${c}`}
                      aria-pressed={canal === c}
                      onClick={() => setCanal(c)}
                      className={cn(
                        "h-7 rounded-sm px-3 text-xs font-medium transition-colors duration-fast toque:h-10",
                        FOCO,
                        canal === c ? "bg-accent text-accent-foreground shadow-xs" : "text-text-muted hover:text-text",
                      )}
                    >
                      {t(ROTULO_DO_CANAL[c])}
                    </button>
                  ))}
                </span>
              </fieldset>
              <Button
                data-testid="confirmar-marcacao"
                disabled={!pronto || enviando}
                onClick={() => void confirmar()}
                className="flex-1 sm:flex-none"
              >
                {enviando ? t("Marcando…") : t("Confirmar")}
              </Button>
            </div>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="bloquear" className="mt-0">
        <BloqueioDeHorario
          pessoas={pessoas}
          euId={usuarioId}
          podeEscolherQuem={podeBloquearDeOutros}
          profissionalInicial={profissionalId}
          dataInicial={format(dia, "yyyy-MM-dd")}
        />
      </TabsContent>
    </Tabs>
  );
}
