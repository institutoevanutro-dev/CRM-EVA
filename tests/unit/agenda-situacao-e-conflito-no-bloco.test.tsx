/**
 * A2 (pacote 2 de design): a situação e o conflito aparecem no próprio bloco.
 *
 * A cor do bloco diz quem atende; a forma e o ícone dizem a situação; o anel e
 * a faixa acima da grade avisam o conflito com bloqueio, "Ocupado" do Google ou
 * outro compromisso do MESMO profissional. Nomes fictícios.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { GradeDaAgenda } from "@/components/agenda/GradeDaAgenda";
import { conflitosDaGrade, formaDaSituacao, lembreteSemResposta } from "@/components/agenda/situacao-do-bloco";
import type { Agendamento, Pessoa } from "@/components/agenda/tipos";

afterEach(cleanup);

const ANA = "ana";
const BIA = "bia";
const PESSOAS = [
  { id: ANA, nome: "Dra. Ana Teste", trilha: 1 },
  { id: BIA, nome: "Dra. Bia Teste", trilha: 2 },
] as Pessoa[];

function ag(id: string, extra: Partial<Agendamento> = {}): Agendamento {
  return {
    id,
    titulo: "Consulta",
    quemSeraAtendido: "Carla Fictícia",
    responsavelId: ANA,
    comeca: "2026-09-16T13:00:00-03:00",
    termina: "2026-09-16T14:00:00-03:00",
    origem: "ui",
    situacao: "confirmed",
    ...extra,
  };
}

describe("situação → forma e ícone", () => {
  it("cada situação tem a sua forma", () => {
    expect(formaDaSituacao("pending")).toEqual({ icone: "relogio", tracejado: true, tituloDeApoio: false });
    expect(formaDaSituacao("confirmed")).toEqual({ icone: null, tracejado: false, tituloDeApoio: false });
    expect(formaDaSituacao("completed")).toEqual({ icone: "realizado", tracejado: false, tituloDeApoio: true });
    expect(formaDaSituacao("no_show")).toEqual({ icone: "falta", tracejado: false, tituloDeApoio: false });
    // Valor fora do vocabulário (servidor mais novo, dado legado): bloco de sempre, nunca quebrado.
    expect(formaDaSituacao("scheduled" as never)).toEqual({ icone: null, tracejado: false, tituloDeApoio: false });
  });
});

describe("detecção de conflito", () => {
  it("bloqueio por cima de paciente do mesmo profissional é conflito, só o nosso acusa", () => {
    const bloqueio = ag("bloqueio:1", { origem: "google_sync", bloqueio: true, quemSeraAtendido: undefined });
    expect([...conflitosDaGrade([ag("a"), bloqueio])]).toEqual(["a"]);
  });

  it("'Ocupado' do Google do mesmo profissional também", () => {
    const google = ag("g1", {
      origem: "google_sync",
      titulo: "Ocupado",
      quemSeraAtendido: undefined,
      comeca: "2026-09-16T13:30:00-03:00",
      termina: "2026-09-16T15:00:00-03:00",
    });
    expect([...conflitosDaGrade([ag("a"), google])]).toEqual(["a"]);
  });

  it("dois compromissos do mesmo profissional: os dois acusam", () => {
    expect(conflitosDaGrade([ag("a"), ag("b")])).toEqual(new Set(["a", "b"]));
  });

  it("profissionais diferentes no mesmo horário não conflitam", () => {
    expect(conflitosDaGrade([ag("a"), ag("b", { responsavelId: BIA })]).size).toBe(0);
  });

  it("encostar não é sobrepor, e o que não está de pé não conta", () => {
    const depois = ag("b", { comeca: "2026-09-16T14:00:00-03:00", termina: "2026-09-16T15:00:00-03:00" });
    expect(conflitosDaGrade([ag("a"), depois]).size).toBe(0);
    expect(conflitosDaGrade([ag("a", { situacao: "completed" }), ag("b")]).size).toBe(0);
    expect(conflitosDaGrade([ag("a", { situacao: "cancelled" }), ag("b")]).size).toBe(0);
  });

  it("item sem responsável não acusa ninguém", () => {
    const semDono = ag("g1", { origem: "google_sync", responsavelId: "" });
    expect(conflitosDaGrade([ag("a"), semDono]).size).toBe(0);
  });
});

function grade(agendamentos: Agendamento[], onAbrirAgendamento?: (id: string) => void) {
  render(
    <GradeDaAgenda
      visao="semana"
      ancora={new Date("2026-09-16T12:00:00-03:00")}
      agora={new Date("2026-09-16T08:00:00-03:00")}
      fuso="America/Sao_Paulo"
      agendamentos={agendamentos}
      pessoas={PESSOAS}
      onAbrirAgendamento={onAbrirAgendamento}
    />,
  );
}

describe("o bloco na grade", () => {
  it("aguardando: borda tracejada, relógio, e o nome da situação no title e no aria-label", () => {
    grade([ag("a", { situacao: "pending" })]);
    const bloco = screen.getByTestId("agendamento-a");
    expect(bloco.className).toContain("border-dashed");
    expect(screen.getByTestId("situacao-a")).toHaveAttribute("data-icone", "relogio");
    expect(bloco).toHaveAttribute("title", "Aguardando confirmação");
    expect(bloco.getAttribute("aria-label")).toContain(", Aguardando confirmação");
  });

  it("confirmado fica como era: sem ícone e sem tracejado", () => {
    grade([ag("a")]);
    const bloco = screen.getByTestId("agendamento-a");
    expect(bloco.className).not.toContain("border-dashed");
    expect(screen.queryByTestId("situacao-a")).toBeNull();
    expect(bloco).toHaveAttribute("title", "Confirmado");
  });

  it("realizado: ícone de confirmação e título em cinza de apoio; não compareceu: X", () => {
    grade([ag("a", { situacao: "completed" }), ag("b", { situacao: "no_show", responsavelId: BIA, quemSeraAtendido: "Dora Teste" })]);
    expect(screen.getByTestId("situacao-a")).toHaveAttribute("data-icone", "realizado");
    expect(screen.getByText("Carla F.").className).toContain("text-text-muted");
    expect(screen.getByTestId("situacao-b")).toHaveAttribute("data-icone", "falta");
    expect(screen.getByTestId("agendamento-b").getAttribute("aria-label")).toContain("Não compareceu");
  });

  it("conflito: anel, aviso no bloco e faixa acima da grade com link para o compromisso", () => {
    const onAbrir = vi.fn();
    const bloqueio = ag("bloqueio:1", { origem: "google_sync", bloqueio: true, quemSeraAtendido: undefined, titulo: "Horário bloqueado" });
    grade([ag("a"), bloqueio], onAbrir);
    const bloco = screen.getByTestId("agendamento-a");
    expect(bloco.className).toContain("ring-error");
    expect(bloco.getAttribute("aria-label")).toContain("conflito de horário");
    expect(screen.getByTestId("conflito-a")).toBeInTheDocument();
    expect(screen.getByTestId("agendamento-bloqueio:1").className).not.toContain("ring-error");
    expect(screen.getByTestId("faixa-de-conflito").textContent).toContain("1 paciente em horário bloqueado, remarque.");
    fireEvent.click(screen.getByTestId("ver-conflito"));
    expect(onAbrir).toHaveBeenCalledWith("a");
  });

  it("sem conflito, sem faixa; a legenda está no rodapé", () => {
    grade([ag("a"), ag("b", { responsavelId: BIA })]);
    expect(screen.queryByTestId("faixa-de-conflito")).toBeNull();
    expect(screen.getByTestId("legenda-da-grade").textContent).toContain("Aguardando confirmação");
  });
});

/**
 * 0441: o paciente confirma a presença respondendo ao lembrete. A grade mostra
 * quem confirmou e, na véspera, quem recebeu o lembrete que pede SIM e não
 * respondeu (a recepção liga para esses). As duas marcas têm forma própria, não
 * só cor, e entram na legenda.
 */
describe("presença confirmada e sem confirmação", () => {
  const AGORA = new Date("2026-09-16T08:00:00-03:00");
  const semResposta = (extra: Partial<Agendamento> = {}) =>
    ag("a", { lembretePedeConfirmacao: true, lembreteEnviadoEm: "2026-09-15T13:00:00Z", ...extra });

  it("a regra do 'sem resposta': chave do tipo, lembrete saído, sem confirmação, Agendado e por vir", () => {
    expect(lembreteSemResposta(semResposta(), AGORA)).toBe(true);
    expect(lembreteSemResposta(semResposta({ lembretePedeConfirmacao: false }), AGORA)).toBe(false);
    expect(lembreteSemResposta(semResposta({ lembretePedeConfirmacao: undefined }), AGORA)).toBe(false);
    expect(lembreteSemResposta(semResposta({ lembreteEnviadoEm: undefined }), AGORA)).toBe(false);
    expect(lembreteSemResposta(semResposta({ presencaConfirmadaEm: "2026-09-15T14:00:00Z" }), AGORA)).toBe(false);
    for (const situacao of ["pending", "completed", "no_show", "cancelled"] as const) {
      expect(lembreteSemResposta(semResposta({ situacao }), AGORA), situacao).toBe(false);
    }
    // Já começou: não há mais o que confirmar.
    expect(lembreteSemResposta(semResposta(), new Date("2026-09-16T13:00:00-03:00"))).toBe(false);
  });

  it("presença confirmada: ícone de check duplo no canto, com nome no title e no aria-label do cartão", () => {
    grade([ag("a", { presencaConfirmadaEm: "2026-09-15T14:00:00Z", presencaConfirmadaOrigem: "mensagem" })]);
    const icone = screen.getByTestId("presenca-confirmada-a");
    expect(icone).toHaveAttribute("aria-label", "Presença confirmada");
    expect(icone.querySelector("title")?.textContent).toBe("Presença confirmada");
    const bloco = screen.getByTestId("agendamento-a");
    expect(bloco.getAttribute("title")).toContain("Presença confirmada");
    expect(bloco.getAttribute("aria-label")).toContain(", presença confirmada");
    expect(screen.queryByTestId("lembrete-sem-resposta-a")).toBeNull();
  });

  it("presença confirmada some do cartão que já não está Agendado (o ícone da situação diz o que houve)", () => {
    grade([ag("a", { situacao: "completed", presencaConfirmadaEm: "2026-09-15T14:00:00Z" })]);
    expect(screen.queryByTestId("presenca-confirmada-a")).toBeNull();
    expect(screen.getByTestId("situacao-a")).toHaveAttribute("data-icone", "realizado");
  });

  it("sem confirmação: sino no canto, com nome; some depois do horário e com a confirmação", () => {
    grade([semResposta()]);
    const sino = screen.getByTestId("lembrete-sem-resposta-a");
    expect(sino).toHaveAttribute("aria-label", "Sem confirmação");
    expect(sino.querySelector("title")?.textContent).toBe("Sem confirmação");
    expect(screen.getByTestId("agendamento-a").getAttribute("aria-label")).toContain(", sem confirmação");
    cleanup();

    grade([semResposta({ comeca: "2026-09-16T07:00:00-03:00", termina: "2026-09-16T07:30:00-03:00" })]);
    expect(screen.queryByTestId("lembrete-sem-resposta-a")).toBeNull();
    cleanup();

    grade([semResposta({ lembretePedeConfirmacao: false })]);
    expect(screen.queryByTestId("lembrete-sem-resposta-a")).toBeNull();
  });

  it("a legenda só explica a marca que algum bloco mostra: com a chave desligada, nenhuma das duas", () => {
    const legenda = () => screen.getByTestId("legenda-da-grade").textContent ?? "";

    grade([ag("a"), semResposta({ id: "b", lembretePedeConfirmacao: false, responsavelId: BIA })]);
    expect(legenda()).toContain("Sem lembrete");
    expect(legenda()).not.toContain("Presença confirmada");
    expect(legenda()).not.toContain("Sem confirmação");
    cleanup();

    grade([ag("a", { presencaConfirmadaEm: "2026-09-15T14:00:00Z" })]);
    expect(legenda()).toContain("Presença confirmada");
    expect(legenda()).not.toContain("Sem confirmação");
    cleanup();

    grade([semResposta()]);
    expect(legenda()).toContain("Sem confirmação");
    expect(legenda()).not.toContain("Presença confirmada");
    cleanup();

    // A marca que o bloco não mostra também não entra: realizado com confirmação, Google.
    grade([
      ag("a", { situacao: "completed", presencaConfirmadaEm: "2026-09-15T14:00:00Z" }),
      semResposta({ id: "g", origem: "google_sync", responsavelId: BIA }),
    ]);
    expect(legenda()).not.toContain("Presença confirmada");
    expect(legenda()).not.toContain("Sem confirmação");
  });
});
