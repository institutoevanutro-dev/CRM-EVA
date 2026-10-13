/**
 * "ESTE CONTATO É CLIENTE, PARA FINS DE FUNIL?" — o único lugar que responde.
 *
 * Quem pergunta: o nascimento do lead (`lib/leads/nascimento-do-lead.ts`, que
 * escolhe entre o funil de entrada e o de clientes) e toda tela que mostra o
 * selo "Cliente" (lista e ficha de contatos). Enquanto a pergunta morava
 * espalhada (`clientesLigado && first_service_at` em cada tela), uma segunda
 * regra faria o selo dizer uma coisa e o card nascer em outro funil.
 *
 * DUAS REGRAS, independentes, as duas desligadas por padrão em toda organização:
 *
 *   - `pelaAgenda` (`settings.crm.cliente_pela_agenda`, migration 0262): quem
 *     tem `first_service_at`, a data que só o banco grava a partir da agenda.
 *     Com só ela ligada, a resposta é byte a byte a de antes deste arquivo.
 *   - `peloCadastro` (`settings.crm.paciente_pelo_cadastro`, migration 0360):
 *     quem TEM CADASTRO DE PACIENTE, que são dois fatos que já existiam:
 *     o contato está ligado a um paciente do prontuário
 *     (`prontuario_contact_links`, a identidade que o prontuário grava pela API)
 *     ou tem CPF guardado. O vínculo é o sinal forte; o CPF é o que alcança o
 *     cadastro importado que o prontuário ainda não ligou.
 *
 * ⚠️ A SEGUNDA REGRA NÃO ESCREVE NADA NO CONTATO. Nem `first_service_at` (que
 * continua querendo dizer "primeiro horário que conta"), nem a etiqueta
 * `cliente` (que continua sendo só da regra da agenda e da equipe). Ligar e
 * desligar não tem o que desfazer: o fato é lido na hora.
 *
 * ⚠️ O ESPELHO SQL deste predicado é a contagem de
 * `fn_definir_paciente_pelo_cadastro`. Os dois são comparados contato a contato
 * em `tests/invariants/paciente-pelo-cadastro.test.ts`.
 *
 * Este arquivo não importa nada de propósito: componentes de cliente o importam.
 */

/** As duas regras da organização. Ausente é desligado. */
export interface RegrasDeCliente {
  pelaAgenda: boolean;
  peloCadastro: boolean;
}

/** O que se precisa saber do contato. Nada aqui é dado sensível: são presenças. */
export interface FatosDoContato {
  first_service_at?: string | null;
  /** Existe CPF guardado (`cpf_available` na API; `cpf_encrypted` não nulo no banco). */
  temCpf?: boolean;
  /** Existe linha em `prontuario_contact_links` para este contato. */
  temProntuario?: boolean;
  is_anonymized?: boolean | null;
  is_merged_into?: string | null;
}

/**
 * O contato tem cadastro de paciente? Anonimizado e mesclado nunca têm: o
 * primeiro deixou de ser uma pessoa identificável, o segundo deixou de ser um
 * cadastro vivo (é a mesma exclusão da migration 0262).
 */
export function temCadastroDePaciente(contato: FatosDoContato): boolean {
  if (contato.is_anonymized === true || contato.is_merged_into != null) return false;
  return contato.temProntuario === true || contato.temCpf === true;
}

/** As regras como o layout de `/app` as entrega à tela (`ActiveOrg`). */
export function regrasDeClienteDe(
  org: { cliente_pela_agenda?: boolean; paciente_pelo_cadastro?: boolean } | null | undefined,
): RegrasDeCliente {
  return {
    pelaAgenda: org?.cliente_pela_agenda === true,
    peloCadastro: org?.paciente_pelo_cadastro === true,
  };
}

/** Os fatos como a API de contatos os entrega (`lib/types/contacts.ts`). */
export function fatosDoContatoDaApi(c: {
  first_service_at?: string | null;
  cpf_available?: boolean;
  prontuario_linked?: boolean;
  is_anonymized?: boolean | null;
  is_merged_into?: string | null;
}): FatosDoContato {
  return {
    first_service_at: c.first_service_at,
    temCpf: c.cpf_available === true,
    temProntuario: c.prontuario_linked === true,
    is_anonymized: c.is_anonymized,
    is_merged_into: c.is_merged_into,
  };
}

export function ehClienteParaOFunil(
  contato: FatosDoContato | null | undefined,
  regras: RegrasDeCliente,
): boolean {
  if (!contato) return false;
  // A regra da agenda fica como o upstream a escreveu: só a data e o interruptor.
  if (regras.pelaAgenda && contato.first_service_at != null) return true;
  return regras.peloCadastro && temCadastroDePaciente(contato);
}
