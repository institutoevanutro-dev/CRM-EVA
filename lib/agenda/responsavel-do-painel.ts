import type { Pessoa } from "@/components/agenda/tipos";

/**
 * QUEM a agenda mostra no painel de marcação — e a única condição em que ele
 * pode dizer "Você".
 *
 * Porte de melgarafael/DeskcommCRM d7d18345b (issue #896, item a).
 *
 * O defeito: com a lista da equipe vazia (a recepção tomava 403 na rota da
 * equipe), o painel caía num fallback fixo `{ id: "", nome: "Você" }` e dizia
 * "com Você" e "Você ainda não publicou seus horários" sobre a jornada da
 * médica, que não estava naquela sessão.
 *
 * A ordem: o DONO DO TIPO (quem de fato atende), com o nome da lista ou, fora
 * dela, "Sem nome" — o mesmo texto de `usePessoasDaAgenda` para `full_name`
 * nulo. Quem está logado só entra quando o tipo não tem dono. "Você" só sai
 * quando o id resolvido é o de quem está logado.
 *
 * O dono fora da lista NÃO cai em quem está logado: o Prestador recebe da lista
 * só a si mesmo e abre tipos da médica — cair nele dizia "com Você" sobre a
 * jornada dela (revisão do PR #142).
 *
 * Os dois rótulos são CHAVES do dicionário, não texto final: quem desenha
 * traduz com `rotuloDoResponsavel`.
 */
export const ROTULO_VOCE = "Você";
export const ROTULO_SEM_NOME = "Sem nome";

export function resolverResponsavelDoPainel(entrada: {
  pessoas: Pessoa[];
  donoId: string | null;
  usuarioId: string;
}): Pessoa {
  const { pessoas, donoId, usuarioId } = entrada;
  const alvo = donoId ?? usuarioId;
  const pessoa = pessoas.find((p) => p.id === alvo) ?? { id: alvo, nome: ROTULO_SEM_NOME, trilha: 1 };
  return { ...pessoa, nome: pessoa.id === usuarioId ? ROTULO_VOCE : pessoa.nome };
}

/** O nome a desenhar: os rótulos do resolvedor passam por `t`, nomes de gente não. */
export function rotuloDoResponsavel(nome: string, t: (texto: string) => string): string {
  return nome === ROTULO_VOCE || nome === ROTULO_SEM_NOME ? t(nome) : nome;
}
