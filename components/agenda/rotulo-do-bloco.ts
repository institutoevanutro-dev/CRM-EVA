import { format, type Locale } from "date-fns";

import { dataDeParede, diaLocalISO } from "@/lib/agenda/fuso";

import type { VisaoDaAgenda } from "./tipos";

/**
 * "Maria Souza Lima" → "Maria L." — primeiro nome e a inicial do último.
 *
 * É o nome que cabe numa coluna da semana: o primeiro nome sozinho repete rápido
 * numa clínica cheia, e o nome inteiro corta antes da inicial que desempata.
 */
export function nomeCurto(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length < 2) return partes[0] ?? "";
  return `${partes[0]} ${partes[partes.length - 1]![0]!.toUpperCase()}.`;
}

/**
 * O que o bloco da grade escreve — A1 do pacote 2a de design.
 *
 * Quem vem é a primeira coisa que a recepção procura, então o paciente é a linha
 * 1; o procedimento desce para a linha de apoio, junto da hora. Sem paciente
 * (reunião, bloqueio, ocupação do Google) quem fala é o título.
 *
 * 45 min é o corte da segunda linha porque é o que a régua de 48 px por hora
 * comporta: um bloco de 30 min tem 22 px e só cabe uma linha — e aí a hora vai
 * NA FRENTE do nome, numa linha só, em vez de sumir.
 */
export function rotuloDoBloco(entrada: {
  titulo: string;
  paciente?: string;
  /** "09:30", já no fuso da organização. */
  hora: string;
  duracaoMin: number;
  visao: VisaoDaAgenda;
}): { principal: string; apoio: string | null } {
  const { titulo, paciente, hora, duracaoMin, visao } = entrada;
  const quem = paciente ? (visao === "semana" ? nomeCurto(paciente) : paciente) : titulo;
  if (duracaoMin < 45) return { principal: `${hora} ${quem}`, apoio: null };
  return { principal: quem, apoio: paciente ? `${hora} · ${titulo}` : hora };
}


/**
 * "hoje 10:00" ou "ter 4/11 10:00", na hora de parede da organização.
 *
 * `hoje` chega já traduzido por quem chama: este módulo não lê o idioma.
 */
export function quandoCurto(
  instante: Date,
  fuso: string,
  agora: Date,
  locale: Locale,
  hoje: string,
): string {
  const parede = dataDeParede(instante, fuso);
  if (diaLocalISO(instante, fuso) === diaLocalISO(agora, fuso)) {
    return `${hoje} ${format(parede, "HH:mm")}`;
  }
  return `${format(parede, "EEEEEE", { locale }).replace(".", "")} ${format(parede, "d/M HH:mm")}`;
}

/**
 * A pergunta antes de remarcar — A8.
 *
 * ⚠️ NÃO PROMETE AVISO. Remarcar emite `appointment.rescheduled`, mas nenhuma
 * mensagem sai para o paciente por padrão: só sai se a clínica tiver uma
 * automação ligada a esse gatilho (ou o convite do Google, quando há e-mail de
 * convidado). A frase antiga dizia "recebe o aviso da mudança" e a recepção
 * deixava de ligar. Por isso a segunda frase diz a condição.
 *
 * Os moldes chegam já traduzidos (`t()` com `{chaves}`), e a troca usa função
 * para um `$` no nome não virar padrão de substituição.
 */
export function fraseDaRemarcacao(entrada: {
  paciente?: string;
  titulo: string;
  de: string;
  para: string;
  moldes: { comPaciente: string; semPaciente: string; aviso: string };
}): string {
  const { paciente, titulo, de, para, moldes } = entrada;
  const troca = (molde: string) =>
    molde
      .replace("{paciente}", () => paciente ?? "")
      .replace("{titulo}", () => titulo)
      .replace("{de}", () => de)
      .replace("{para}", () => para);
  if (!paciente) return troca(moldes.semPaciente);
  return `${troca(moldes.comPaciente)} ${troca(moldes.aviso)}`;
}
