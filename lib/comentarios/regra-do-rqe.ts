/**
 * A REGRA DO RQE DOS COMENTÁRIOS, por organização (migration 0381).
 *
 * Ligada, a IA nunca chama o dono do perfil de especialista ou nutrólogo nas
 * respostas aos comentários do Instagram, e comentário sobre especialidade
 * espera um humano: médico sem RQE não pode anunciar especialidade (regra de
 * publicidade médica do CFM). O administrador desliga quando o médico tem RQE
 * ou quando a clínica não é médica.
 *
 * Mora em `organizations.settings.medico_sem_rqe`, no nível de cima, e só o
 * booleano `false` desliga. Ausente, `null`, a string "false", `0`, qualquer
 * coisa que não seja o booleano: vale LIGADA. É o comportamento de antes de a
 * regra ser configurável, e o lado seguro quando o dado está estranho.
 *
 * Quem grava é `fn_definir_medico_sem_rqe` (só administrador). Quem lê passa o
 * `settings` inteiro da organização: a forma da chave mora aqui, num lugar só.
 */
export function medicoSemRqe(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null) return true;
  return (settings as { medico_sem_rqe?: unknown }).medico_sem_rqe !== false;
}
