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
 * A ordem: o DONO DO TIPO (quem de fato atende); senão quem está logado, se
 * estiver na lista; senão o dono do tipo sem nome conhecido — "Sem nome", o
 * mesmo texto de `usePessoasDaAgenda` para `full_name` nulo. "Você" só sai
 * quando o id resolvido é o de quem está logado.
 */
export function resolverResponsavelDoPainel(entrada: {
  pessoas: Pessoa[];
  donoId: string | null;
  usuarioId: string;
}): Pessoa {
  const { pessoas, donoId, usuarioId } = entrada;
  const pessoa = pessoas.find((p) => p.id === donoId) ??
    pessoas.find((p) => p.id === usuarioId) ?? { id: donoId ?? usuarioId, nome: "Sem nome", trilha: 1 };
  return { ...pessoa, nome: pessoa.id === usuarioId ? "Você" : pessoa.nome };
}
