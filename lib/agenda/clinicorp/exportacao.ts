/**
 * O relatório exportado da Clinicorp, reduzido a HORÁRIO OCUPADO — no navegador.
 *
 * Clinicorp › Relatórios › Agendamentos › Geral › Exportar devolve um .xlsx
 * (medido em 24/11/2026): uma aba com Data ("dd/mm/aaaa"), Paciente, Contato,
 * Horário ("H:MM às HH:MM"), uma coluna sem cabeçalho (quem agendou), Status
 * ("N-Texto", muitas vezes vazio), Profissional (o NOME), Equipamento, Sala e
 * Categoria. Não tem id do agendamento nem do profissional (migration 0435).
 *
 * Este módulo roda na tela de Configurações, e o arquivo nunca sai do navegador.
 * Dele só se lê Data, Horário, Profissional e Status, achados pelo cabeçalho; a
 * coluna de paciente e a de contato nem são consultadas, e o que sai daqui não
 * tem campo para elas.
 *
 * Status de falta ou desmarcado não ocupa horário. Status vazio, confirmado ou
 * atendido ocupa: é agendamento de pé.
 */
import { lerXlsx } from "@/lib/importador-de-clinicas/xlsx";

/** Um horário ocupado, no relógio da clínica. */
export interface HorarioExportado {
  /** `YYYY-MM-DD` */
  dia: string;
  /** `HH:MM` */
  de: string;
  /** `HH:MM` */
  ate: string;
  /** O nome do profissional como a Clinicorp o escreve: quem é na Agenda, o gestor escolhe. */
  profissional: string;
}

export interface ExportacaoLida {
  horarios: HorarioExportado[];
  /** Falta ou desmarcado: não ocupa. */
  semOcupar: number;
  /** Data ou horário que não deu para ler. */
  ilegiveis: number;
}

export class ExportacaoIlegivel extends Error {}

const normal = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();

const NAO_OCUPA = /falt|desmarc|cancel/i;

const hhmm = (h: string, m: string) => `${h.padStart(2, "0")}:${m}`;

function diaValido(d: string, m: string, a: string): string | null {
  const data = new Date(Date.UTC(Number(a), Number(m) - 1, Number(d)));
  return data.getUTCMonth() === Number(m) - 1 && data.getUTCDate() === Number(d) ? `${a}-${m}-${d}` : null;
}

export function lerExportacaoDaClinicorp(bytes: Uint8Array): ExportacaoLida {
  for (const linhas of lerXlsx(bytes).values()) {
    const iCabecalho = linhas.findIndex((l) => ["data", "horario", "profissional"].every((h) => l.map(normal).includes(h)));
    if (iCabecalho < 0) continue;
    const cabecalho = linhas[iCabecalho]!.map(normal);
    const coluna = (h: string) => cabecalho.indexOf(h);
    const [cData, cHorario, cProfissional, cStatus] = [coluna("data"), coluna("horario"), coluna("profissional"), coluna("status")];

    const lida: ExportacaoLida = { horarios: [], semOcupar: 0, ilegiveis: 0 };
    for (const linha of linhas.slice(iCabecalho + 1)) {
      const celula = (i: number) => (i < 0 ? "" : (linha[i] ?? "").trim());
      const [data, horario, profissional] = [celula(cData), celula(cHorario), celula(cProfissional)];
      if (!data && !horario && !profissional) continue; // linha em branco
      if (NAO_OCUPA.test(celula(cStatus))) {
        lida.semOcupar += 1;
        continue;
      }
      const d = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(data);
      const f = /^(\d{1,2}):([0-5]\d)\s*(?:às|as|a|-)\s*(\d{1,2}):([0-5]\d)$/i.exec(horario);
      const dia = d ? diaValido(d[1]!, d[2]!, d[3]!) : null;
      const de = f ? hhmm(f[1]!, f[2]!) : "";
      const ate = f ? hhmm(f[3]!, f[4]!) : "";
      if (!dia || !f || !profissional || Number(f[1]) > 23 || Number(f[3]) > 23 || ate <= de) {
        lida.ilegiveis += 1;
        continue;
      }
      lida.horarios.push({ dia, de, ate, profissional: profissional.slice(0, 200) });
    }
    return lida;
  }
  throw new ExportacaoIlegivel("sem_cabecalho");
}
