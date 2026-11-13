/**
 * O FERIADO NACIONAL NO TURNO — o fato que faltava no contexto do agente.
 *
 * Portado do projeto original (DeskcommCRM, PRs #3894 e #4469, que absorveu o
 * #4169). Em 02/11/2026 (Finados) agentes diziam "atendemos hoje até as 18h":
 * sabiam o dia da semana (`## Agora`) e o horário semanal, e não sabiam que
 * aquele dia é feriado.
 *
 * A régua é a única do repo, `isHolidayBR` (`lib/lgpd/holidays-br.ts`). A data
 * civil é a do FUSO da organização (às 21h30 de Finados em São Paulo já é dia
 * 03 em UTC) e é ancorada ao meio-dia UTC antes de ir a `isHolidayBR`, que lê a
 * data em `America/Sao_Paulo`: 12:00Z é o mesmo dia lá.
 *
 * O fork não tem `organizations.country`: a clínica é brasileira, e o
 * calendário brasileiro vale sempre.
 *
 * Isto INFORMA o modelo. Quem quer o feriado como dia FECHADO liga a opção do
 * agente "Não atender em feriado nacional" (`janela-de-atendimento.ts`).
 */
import { isHolidayBR } from '@/lib/lgpd/holidays-br';
import { FUSO_PADRAO, fusoValido } from '@/lib/tempo/fusos';

export interface FeriadoNoTurno {
  /** Data civil de HOJE na organização, `YYYY-MM-DD`. */
  hojeEm: string;
  /** Data civil de AMANHÃ na organização, `YYYY-MM-DD`. */
  amanhaEm: string;
  hoje: boolean;
  amanha: boolean;
}

function dataNoFuso(instante: Date, fuso: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: fusoValido(fuso) ? fuso : FUSO_PADRAO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instante);
}

function ehFeriadoNaData(dataIso: string): boolean {
  return isHolidayBR(new Date(`${dataIso}T12:00:00.000Z`));
}

/** O dia civil de `instante`, no `fuso`, é feriado nacional? */
export function ehFeriadoNacionalNoFuso(instante: Date, fuso: string): boolean {
  return ehFeriadoNaData(dataNoFuso(instante, fuso));
}

/** Hoje e amanhã, no fuso da organização, são feriado nacional? */
export function feriadoNacionalNoTurno(agora: Date, fuso: string): FeriadoNoTurno {
  const hojeEm = dataNoFuso(agora, fuso);
  const amanha = new Date(`${hojeEm}T12:00:00.000Z`);
  amanha.setUTCDate(amanha.getUTCDate() + 1);
  const amanhaEm = amanha.toISOString().slice(0, 10);
  return { hojeEm, amanhaEm, hoje: ehFeriadoNaData(hojeEm), amanha: ehFeriadoNaData(amanhaEm) };
}

function diaMesAno(dataIso: string): string {
  const [ano, mes, dia] = dataIso.split('-');
  return `${dia}/${mes}/${ano}`;
}

/**
 * O bloco `## Feriado nacional` do sufixo por-lead, ao lado do `## Agora`. Dia
 * comum também rende bloco (a negativa explícita): o silêncio é onde o modelo
 * inventa. Não cita o nome do feriado: o calendário é de datas.
 */
export function blocoDoFeriado(f: FeriadoNoTurno): string {
  const hoje = `Hoje (${diaMesAno(f.hojeEm)})`;
  const amanha = `amanhã (${diaMesAno(f.amanhaEm)})`;
  const titulo = '## Feriado nacional';

  if (f.hoje && f.amanha) {
    return `${titulo}\n${hoje} e ${amanha} são feriados nacionais no Brasil. ` +
      'Feriado nacional não é dia útil: o expediente normal do horário de funcionamento NÃO vale para nenhum dos dois dias. ' +
      'Não prometa atendimento nesses dias e não convide a pessoa a vir à clínica sem antes confirmar com a equipe.';
  }
  if (f.hoje) {
    return `${titulo}\n${hoje} é feriado nacional no Brasil. ` +
      'Feriado nacional não é dia útil: o expediente normal do horário de funcionamento NÃO vale para hoje. ' +
      'Não diga que a clínica atende hoje nem convide a pessoa a vir à clínica sem antes confirmar com a equipe.';
  }
  if (f.amanha) {
    return `${titulo}\nAmanhã (${diaMesAno(f.amanhaEm)}) é feriado nacional no Brasil. ` +
      'Feriado nacional não é dia útil: o expediente normal do horário de funcionamento NÃO vale para amanhã. ' +
      'Não prometa atendimento para amanhã assumindo dia útil nem marque compromisso lá; se a pessoa pedir, confirme com a equipe.';
  }
  return `${titulo}\n${hoje} e ${amanha} NÃO são feriados nacionais no Brasil.`;
}
