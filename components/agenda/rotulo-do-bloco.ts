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

