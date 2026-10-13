/**
 * O INTERRUPTOR "PACIENTES PELO CADASTRO": o que a tela promete antes de ligar.
 *
 * A suíte protege a ordem: ligar primeiro CONTA (a action de prévia, que não
 * grava), o diálogo mostra o número que o banco devolveu, e só a confirmação
 * chama a action que grava. Cancelar não grava. Desligar não pede confirmação,
 * porque a regra não escreve em contato nenhum.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const definir = vi.fn();
const contar = vi.fn();
vi.mock("@/app/actions/settings/definirPacientePeloCadastro", () => ({
  definirPacientePeloCadastro: (...a: unknown[]) => definir(...a),
  contarPacientesPeloCadastro: (...a: unknown[]) => contar(...a),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { PacientePeloCadastro } from "./PacientePeloCadastro";

const corpo = (n: { pacientes: number; ja?: number; funil?: boolean; ligado?: boolean }) => ({
  ok: true,
  ligado: n.ligado ?? false,
  mudou: false,
  pacientes: n.pacientes,
  ja_clientes_pela_agenda: n.ja ?? 0,
  tem_funil_de_clientes: n.funil ?? true,
});

beforeEach(() => {
  definir.mockReset();
  contar.mockReset();
});

describe("PacientePeloCadastro", () => {
  it("quem não é admin vê o interruptor desabilitado e a razão", () => {
    render(<PacientePeloCadastro ligadoInicial={false} podeLigar={false} />);
    expect(screen.getByTestId("paciente-pelo-cadastro-interruptor")).toBeDisabled();
    expect(screen.getByText("Só um administrador pode mudar essa regra.")).toBeInTheDocument();
  });

  it("diz que NÃO põe a etiqueta, e o que não resolve (número novo)", () => {
    render(<PacientePeloCadastro ligadoInicial={false} podeLigar />);
    const secao = screen.getByTestId("paciente-pelo-cadastro");
    expect(secao).toHaveTextContent("Esta opção não põe a etiqueta “cliente” em ninguém");
    expect(secao).toHaveTextContent("Quem escreve de um número que não está no cadastro");
    expect(screen.getByTestId("paciente-pelo-cadastro-estado")).toHaveTextContent(/^Desligado:/);
  });

  it("ligar CONTA antes: o diálogo mostra o número do banco, e nada foi gravado ainda", async () => {
    contar.mockResolvedValue(corpo({ pacientes: 1200, ja: 130 }));
    const user = userEvent.setup();
    render(<PacientePeloCadastro ligadoInicial={false} podeLigar />);
    await user.click(screen.getByTestId("paciente-pelo-cadastro-interruptor"));

    const previa = await screen.findByTestId("paciente-pelo-cadastro-previa");
    expect(previa).toHaveTextContent("1200 contatos têm cadastro de paciente");
    expect(previa).toHaveTextContent("130 deles já entravam por ter horário marcado.");
    expect(previa).toHaveTextContent("Nenhum contato é alterado");
    expect(contar).toHaveBeenCalledTimes(1);
    expect(definir).not.toHaveBeenCalled();
    expect(screen.getByTestId("paciente-pelo-cadastro-estado")).toHaveTextContent(/^Desligado:/);
  });

  it("singular, zero e sem funil de clientes têm frase própria", async () => {
    contar.mockResolvedValue(corpo({ pacientes: 1, ja: 1, funil: false }));
    const user = userEvent.setup();
    const { unmount } = render(<PacientePeloCadastro ligadoInicial={false} podeLigar />);
    await user.click(screen.getByTestId("paciente-pelo-cadastro-interruptor"));
    let previa = await screen.findByTestId("paciente-pelo-cadastro-previa");
    expect(previa).toHaveTextContent("1 contato tem cadastro de paciente");
    expect(previa).toHaveTextContent("1 deles já entrava por ter horário marcado.");
    expect(previa).toHaveTextContent("Nenhum funil está marcado como funil de clientes.");
    unmount();

    contar.mockResolvedValue(corpo({ pacientes: 0 }));
    render(<PacientePeloCadastro ligadoInicial={false} podeLigar />);
    await user.click(screen.getByTestId("paciente-pelo-cadastro-interruptor"));
    previa = await screen.findByTestId("paciente-pelo-cadastro-previa");
    expect(previa).toHaveTextContent("Nenhum contato tem cadastro de paciente ainda.");
    expect(previa).not.toHaveTextContent("deles já");
  });

  it("cancelar o diálogo não grava", async () => {
    contar.mockResolvedValue(corpo({ pacientes: 3 }));
    const user = userEvent.setup();
    render(<PacientePeloCadastro ligadoInicial={false} podeLigar />);
    await user.click(screen.getByTestId("paciente-pelo-cadastro-interruptor"));
    await screen.findByTestId("paciente-pelo-cadastro-previa");
    await user.click(screen.getByText("Cancelar"));
    await waitFor(() =>
      expect(screen.queryByTestId("paciente-pelo-cadastro-previa")).not.toBeInTheDocument(),
    );
    expect(definir).not.toHaveBeenCalled();
    expect(screen.getByTestId("paciente-pelo-cadastro-estado")).toHaveTextContent(/^Desligado:/);
  });

  it("confirmar grava; sem funil de clientes, o aviso fica na tela com a porta para Funis", async () => {
    contar.mockResolvedValue(corpo({ pacientes: 3, funil: false }));
    definir.mockResolvedValue({ ...corpo({ pacientes: 3, funil: false, ligado: true }), mudou: true });
    const user = userEvent.setup();
    render(<PacientePeloCadastro ligadoInicial={false} podeLigar />);
    await user.click(screen.getByTestId("paciente-pelo-cadastro-interruptor"));
    await user.click(await screen.findByTestId("paciente-pelo-cadastro-confirmar"));

    await waitFor(() =>
      expect(screen.getByTestId("paciente-pelo-cadastro-estado")).toHaveTextContent(/^Ligado:/),
    );
    expect(definir).toHaveBeenCalledExactlyOnceWith(true);
    const aviso = screen.getByTestId("paciente-pelo-cadastro-sem-funil");
    expect(aviso).toHaveTextContent("Nenhum funil está marcado como funil de clientes.");
    expect(screen.getByText("Abrir Funis")).toHaveAttribute("href", "/app/kanban");
  });

  it("desligar não pede confirmação nem conta: grava direto", async () => {
    definir.mockResolvedValue({ ...corpo({ pacientes: 3 }), mudou: true });
    const user = userEvent.setup();
    render(<PacientePeloCadastro ligadoInicial podeLigar />);
    await user.click(screen.getByTestId("paciente-pelo-cadastro-interruptor"));
    await waitFor(() =>
      expect(screen.getByTestId("paciente-pelo-cadastro-estado")).toHaveTextContent(/^Desligado:/),
    );
    expect(definir).toHaveBeenCalledExactlyOnceWith(false);
    expect(contar).not.toHaveBeenCalled();
  });

  it("recusa na contagem (verificação em duas etapas) aparece ANTES do diálogo", async () => {
    contar.mockResolvedValue({ ok: false, erro: "mfa" });
    const user = userEvent.setup();
    render(<PacientePeloCadastro ligadoInicial={false} podeLigar />);
    await user.click(screen.getByTestId("paciente-pelo-cadastro-interruptor"));
    expect(await screen.findByTestId("paciente-pelo-cadastro-erro")).toHaveTextContent(
      "Confirme a verificação em duas etapas.",
    );
    expect(screen.queryByTestId("paciente-pelo-cadastro-previa")).not.toBeInTheDocument();
    expect(definir).not.toHaveBeenCalled();
  });
});
