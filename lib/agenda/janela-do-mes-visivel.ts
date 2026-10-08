import { addDays, endOfMonth, startOfMonth } from "date-fns";

/**
 * O recorte que a consulta de horários livres pede para o mês que o painel de
 * marcação está mostrando.
 *
 * Porte de melgarafael/DeskcommCRM d5efd698a (Ian Couto). A busca era "hoje +
 * 30 dias", fixa na abertura: o mês visível era estado local do painel, a
 * consulta não acompanhava, e "Próximo mês" desligava assim que acabavam os
 * dias já pedidos — retorno em 60 ou 90 dias não se marcava pelo calendário. O
 * motor já corta pelo `booking_window_days` do tipo; a tela só pergunta pelo
 * mês que a pessoa está vendo.
 *
 * Mês corrente começa em `agora`, não no dia 1: o sync do Google cobre a partir
 * de ontem, e pedir o mês inteiro fazia a cobertura acusar "ainda não
 * verificada neste período" à toa.
 */
export function janelaDoMesVisivel(mes: Date, agora: Date): { de: Date; ate: Date } {
  const inicio = startOfMonth(mes);
  const ate = addDays(endOfMonth(mes), 1);
  if (inicio.getTime() >= agora.getTime() || ate.getTime() <= agora.getTime()) {
    return { de: inicio, ate };
  }
  return { de: agora, ate };
}
