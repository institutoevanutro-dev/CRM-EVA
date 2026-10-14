/**
 * QUEM É O TITULAR de um pedido LGPD, do jeito que a lista mostra.
 *
 * A lista mostrava `ctt:1a2b3c4d`: o começo do id do contato. Quem cuida dos
 * pedidos é a recepção da clínica, e ela procura a paciente pelo nome.
 *
 * Três casos, e a ordem importa:
 *
 * 1. Contato ANONIMIZADO: só o rótulo da anonimização ("Cliente Anonimizado
 *    #…"), nunca um nome. Se a linha ainda tiver resto de nome (anonimização
 *    pela metade), o resto não volta para a tela.
 * 2. Contato vivo: `rotuloDoContato`, a mesma regra do resto do CRM.
 * 3. Sem contato (o webhook da loja não achou ninguém): o que o próprio pedido
 *    traz, o e-mail ou o telefone. Pedido de anonimização já concluído não
 *    mostra nem isso: o dado foi apagado do resto do sistema.
 */
import { rotuloDoContato, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";

export interface ContatoDoTitular extends ContatoNomeavel {
  id: string;
  is_anonymized?: boolean | null;
}

export interface PedidoDoTitular {
  request_type: string;
  status: string;
  scope?: string | null;
  request_payload?: unknown;
}

/** O rótulo que a cascata do banco grava (`fn_lgpd_cascade_redact_contact`). */
const ROTULO_ANONIMIZADO = /^Cliente Anonimizado #\S+$/;

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : null;
}

/** E-mail ou telefone que o pedido carrega: o do webhook da loja ou o de entrega. */
function contatoDoPedido(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { customer?: Record<string, unknown> | null; delivery?: Record<string, unknown> | null };
  return texto(p.customer?.email) ?? texto(p.customer?.phone) ?? texto(p.delivery?.address);
}

export function rotuloDoTitular(
  pedido: PedidoDoTitular,
  contato: ContatoDoTitular | null | undefined,
  t: (texto: string) => string = (x) => x,
): string {
  if (contato) {
    if (contato.is_anonymized) {
      const nome = (contato.name ?? "").trim();
      return ROTULO_ANONIMIZADO.test(nome) ? nome : t("Cliente anonimizado");
    }
    return rotuloDoContato(contato, t);
  }
  if (pedido.scope === "tenant") return t("Loja inteira");
  const anonimizacaoFeita = pedido.request_type !== "data_request" && pedido.status === "completed";
  return (!anonimizacaoFeita && contatoDoPedido(pedido.request_payload)) || t("Sem contato vinculado");
}
