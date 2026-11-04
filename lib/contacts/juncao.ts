/**
 * As regras da TELA de junção, puras (porte do #3640): quem fica por padrão, o
 * que impede juntar e os avisos da confirmação. Valem para "Parecidos —
 * confira" e para "Juntar com outra ficha", sobre o recorte que
 * `GET /api/v1/contacts/compare` devolve.
 *
 * Cada aviso descreve o que `fn_mesclar_contatos` faz DE VERDADE com a ficha
 * absorvida: herda o bloqueio (0319); a rota de fusão aperta as travas da IA em
 * quem fica; telefone, CPF, endereço (`custom_fields`) e o oculto do Inbox não
 * passam. O aviso do telefone só sai quando as DUAS têm número: se quem fica não
 * tem, a fusão herda o número, e avisar empurraria a escolha para o lado errado.
 */
import { ApiError } from "@/lib/api/types";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { chaveDeTelefone } from "@/lib/contacts/duplicados";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";

/** Uma ficha na comparação lado a lado — o recorte de `GET /api/v1/contacts/compare`. */
export interface FichaParaComparar {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  email: string | null;
  birthdate: string | null;
  /** Há CPF guardado. O número nunca vem. */
  cpf_available: boolean;
  /** `custom_fields.endereco`, quando é texto. */
  endereco: string | null;
  /** Ligada a um paciente do prontuário (`prontuario_contact_links`). */
  prontuario_linked: boolean;
  is_blocked: boolean;
  force_human: boolean;
  ai_opt_out: boolean;
  inbox_hidden_at: string | null;
  source: string | null;
  created_at: string;
  last_activity_at: string | null;
  conversas: number;
  negocios: number;
}

type T = (texto: string) => string;

/**
 * Quem fica quando a pessoa ainda não escolheu: a ficha ligada ao prontuário
 * (absorvê-la apaga o vínculo), senão a que tem CPF (o CPF da absorvida não
 * passa), senão o `padrao` de quem chama.
 */
export function quemFicaPorPadrao(a: FichaParaComparar, b: FichaParaComparar, padrao: string): string {
  if (a.prontuario_linked !== b.prontuario_linked) return a.prontuario_linked ? a.id : b.id;
  if (a.cpf_available !== b.cpf_available) return a.cpf_available ? a.id : b.id;
  return padrao;
}

/** O mesmo caso que `POST /api/v1/contacts/merge` recusa com 409, dito antes do clique. */
export function motivoQueImpedeAJuncao(fica: FichaParaComparar, absorvida: FichaParaComparar, t: T): string | null {
  if (fica.prontuario_linked && absorvida.prontuario_linked) {
    return t("As duas fichas estão ligadas a pacientes diferentes do prontuário. Não dá para juntar.");
  }
  if (absorvida.prontuario_linked) return t("A ficha ligada ao prontuário tem de ser a que fica.");
  return null;
}

/**
 * O 409 de `POST /api/v1/contacts/merge` quando quem fica está ligado ao
 * prontuário e a confirmação não veio. A tela que o recebe (dados velhos, ou o
 * grupo forte, que não sabe do vínculo) reabre a confirmação com a caixa.
 */
export function pedeConfirmacaoDoProntuario(err: unknown): boolean {
  return err instanceof ApiError && err.code === "prontuario_confirmar_juncao";
}

/** O que a junção faz com a ficha absorvida, só o que se aplica, na ordem da confirmação. */
export function avisosDaJuncao(fica: FichaParaComparar, absorvida: FichaParaComparar, t: T): string[] {
  // O nome entra por FUNÇÃO no replace: com string, "$&", "$'" e "$`" de um nome
  // (o pushName do WhatsApp chega cru) viram padrão e desfiguram o aviso.
  const nome = rotuloDoContato(absorvida, t);
  const avisos: string[] = [];
  if (absorvida.is_blocked && !fica.is_blocked) {
    avisos.push(
      t("{nome} pediu para não receber mensagens. Quem fica também deixa de receber, inclusive lembretes de consulta.").replace("{nome}", () => nome),
    );
  }
  if (absorvida.ai_opt_out && !fica.ai_opt_out) {
    avisos.push(t("{nome} está como Sempre atendimento humano. Quem fica passa a ter a mesma marca.").replace("{nome}", () => nome));
  } else if (absorvida.force_human && !fica.force_human) {
    avisos.push(
      t("{nome} está com a IA pausada. Quem fica passa a ser atendido só pela equipe até alguém devolver ao automático.").replace("{nome}", () => nome),
    );
  }
  if (absorvida.inbox_hidden_at && !fica.inbox_hidden_at) {
    avisos.push(t("{nome} está oculta do Inbox. Quem fica continua no Inbox, e a IA pode responder.").replace("{nome}", () => nome));
  }
  if (
    absorvida.phone_number &&
    fica.phone_number &&
    chaveDeTelefone(absorvida.phone_number) !== chaveDeTelefone(fica.phone_number)
  ) {
    avisos.push(
      t(
        "O número {tel} não passa para quem fica: a ficha guarda um telefone só. Se chegar mensagem desse número, pode nascer uma ficha nova. Se é o número que a pessoa usa, troque o telefone depois de juntar.",
      ).replace("{tel}", () => phoneForDisplay(absorvida.phone_number)),
    );
  }
  if (absorvida.cpf_available && fica.cpf_available) {
    avisos.push(
      t("As duas fichas têm CPF, e são CPFs diferentes: confira se não são duas pessoas. O CPF de {nome} não passa para quem fica.").replace("{nome}", () => nome),
    );
  } else if (absorvida.cpf_available) {
    avisos.push(t("O CPF de {nome} não passa para quem fica.").replace("{nome}", () => nome));
  }
  const endereco = absorvida.endereco?.trim();
  if (endereco && endereco !== fica.endereco?.trim()) {
    avisos.push(t("O endereço de {nome} não passa para quem fica.").replace("{nome}", () => nome));
  }
  return avisos;
}
