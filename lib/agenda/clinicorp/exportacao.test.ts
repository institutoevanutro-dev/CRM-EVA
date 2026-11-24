/**
 * O relatório exportado da Clinicorp vira horário ocupado, e nada do paciente
 * atravessa. A planilha é fictícia, montada no formato medido em 24/11/2026
 * (colunas, ordem, "H:MM às HH:MM", status "N-Texto" ou vazio, coluna sem
 * cabeçalho de quem agendou).
 */
import { describe, expect, it } from "vitest";

import { gerarXlsx } from "@/lib/importador-de-clinicas/xlsx";

import { ExportacaoIlegivel, lerExportacaoDaClinicorp } from "./exportacao";

const PACIENTE = { nome: "Paciente Ficticia Relatorio", fone: "(27) 90000-4444" };
const CABECALHO = ["Data", "Paciente", "Contato", "Horário", "", "Status", "Profissional", "Equipamento", "Sala", "Categoria"];
const linha = (data: string, horario: string, status: string, profissional: string) => [
  data,
  PACIENTE.nome,
  PACIENTE.fone,
  horario,
  "Recepcao Ficticia",
  status,
  profissional,
  "",
  "",
  "Consulta",
];

const planilha = (linhas: string[][]) => gerarXlsx([{ nome: "Agendamentos", linhas: [CABECALHO, ...linhas] }]);

describe("lerExportacaoDaClinicorp", () => {
  const lida = lerExportacaoDaClinicorp(
    planilha([
      linha("24/11/2026", "13:45 às 14:00", "1-Confirmado", "Dra Ficticia"),
      linha("24/11/2026", "8:00 às 9:30", "", "Unidade - Dra Ficticia"),
      linha("25/11/2026", "14:00 às 15:00", "4-Atendido", "Dra Ficticia"),
      linha("25/11/2026", "18:40 às 19:05", "6-Faltou", "Dra Ficticia"),
      linha("26/11/2026", "10:00 às 11:00", "Desmarcado", "Dra Ficticia"),
      linha("31/02/2026", "10:00 às 11:00", "", "Dra Ficticia"),
      linha("27/11/2026", "11:00 às 10:00", "", "Dra Ficticia"),
      linha("27/11/2026", "sem horário", "", "Dra Ficticia"),
      ["", "", "", "", "", "", "", "", "", ""],
    ]),
  );

  it("lê dia, início, fim e o nome do profissional; nada do paciente", () => {
    expect(lida.horarios).toEqual([
      { dia: "2026-11-24", de: "13:45", ate: "14:00", profissional: "Dra Ficticia" },
      { dia: "2026-11-24", de: "08:00", ate: "09:30", profissional: "Unidade - Dra Ficticia" },
      { dia: "2026-11-25", de: "14:00", ate: "15:00", profissional: "Dra Ficticia" },
    ]);
    const tudo = JSON.stringify(lida);
    expect(tudo).not.toContain(PACIENTE.nome);
    expect(tudo).not.toContain(PACIENTE.fone);
    expect(tudo).not.toContain("Recepcao Ficticia");
    expect(tudo).not.toContain("Consulta");
  });

  it("falta e desmarcado não ocupam; data, horário invertido ou ilegível são contados", () => {
    expect(lida.semOcupar).toBe(2);
    expect(lida.ilegiveis).toBe(3);
  });

  it("acha as colunas pelo cabeçalho, mesmo fora de ordem e sem acento", () => {
    const fora = gerarXlsx([
      { nome: "x", linhas: [["Profissional", "Horario", "Data"], ["Dra Ficticia", "09:00 às 10:00", "01/12/2026"]] },
    ]);
    expect(lerExportacaoDaClinicorp(fora).horarios).toEqual([
      { dia: "2026-12-01", de: "09:00", ate: "10:00", profissional: "Dra Ficticia" },
    ]);
  });

  it("planilha sem as colunas de data, horário e profissional é recusada", () => {
    expect(() => lerExportacaoDaClinicorp(gerarXlsx([{ nome: "x", linhas: [["Nome", "Telefone"]] }]))).toThrow(
      ExportacaoIlegivel,
    );
  });
});
