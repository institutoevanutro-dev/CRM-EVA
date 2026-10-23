/**
 * Ação `send_email`: o e-mail como SAÍDA das regras (porte do upstream #2794,
 * de @webtecnica, issue #2726 lá).
 *
 * O que esta ação NÃO faz: escolher transporte ou conhecer credencial. Quem
 * entrega é `lib/email/resend.ts`, o MESMO caminho do convite de equipe e do
 * alarme de LGPD. Nesta instalação não há SMTP: sem `RESEND_API_KEY` e
 * `RESEND_FROM_EMAIL` a ação registra a recusa `email_nao_configurado` e nada
 * sai. Ela não lança, e não gasta o teto.
 *
 * O que ela faz:
 *   1. resolve PARA QUEM (contato do negócio, responsável do negócio, uma
 *      PESSOA DA EQUIPE ou um endereço fixo escrito na regra);
 *   2. renderiza assunto e corpo com as MESMAS variáveis do WhatsApp;
 *   3. registra o desfecho honesto: sucesso só com o id do provedor na mão,
 *      recusa de destinatário como `skipped`, falha do transporte como
 *      `failed` com o CÓDIGO no `error` (a aba Atividade traduz, ver
 *      `MOTIVO_DA_PARADA`) e a frase crua do provedor no `detail.error`.
 *
 * É INERTE: só roda quando uma regra tem esta ação. E nunca dispara em massa
 * sozinha: há teto por REGRA e teto por ORGANIZAÇÃO, por hora.
 *
 * O consentimento segue o gate de `guarda-do-contato.ts` (lê `declined_at`).
 *
 * O destinatário "membro da equipe" (porte do upstream #2834, issue #2642 lá)
 * é uma PESSOA (`user_organizations.user_id`), com o endereço lido do acesso
 * dela, nunca digitado na regra. O VÍNCULO é conferido NO MOMENTO DO ENVIO, e
 * não no save: a regra é salva uma vez e dispara para sempre, então quem foi
 * removido da organização continuaria recebendo se a checagem morasse na tela.
 */
import { registerAction } from "@/lib/automation/actions";
import type { ActionCtx, ActionResultDetail } from "@/lib/automation/types";
import { renderTemplate } from "@/lib/automation/template";
import { isEmailConfigured, sendEmail } from "@/lib/email/resend";
import { marcaDaSaida } from "@/lib/branding/saida";
import { checkRateLimit, peekRateLimit } from "@/lib/ai/dispatcher/rate-limit";

/**
 * Tetos por janela de uma hora. O remetente é da INSTALAÇÃO, então uma regra
 * desgovernada queimaria a reputação de envio de todas as outras; e uma regra
 * só não pode virar disparo em massa para pacientes.
 *
 *  - por REGRA: 50 por hora;
 *  - por ORGANIZAÇÃO: 200 por hora, somando todas as regras.
 *
 * `postponeUntil` só CONSULTA (o motor pré-checa todas as ações a cada nova
 * tentativa, e um adiamento por OUTRA ação não pode gastar o orçamento); o
 * `execute` só CONTA quando há tentativa real de envio. Quem segura de verdade
 * é o `checkRateLimit` do `execute` (INCR atômico); o resto vira `skipped`
 * com `email_limite_atingido`.
 *
 * ponytail: constantes, não env; viram knob quando alguém pedir.
 */
export const LIMITE_DE_EMAILS_POR_REGRA = 50;
export const LIMITE_DE_EMAILS_POR_JANELA = 200;
export const JANELA_DO_LIMITE_SEG = 3600;

const baldeDaOrg = (ctx: ActionCtx) => `automacao-email:${ctx.organizationId}`;
const baldeDaRegra = (ctx: ActionCtx) => `automacao-email:${ctx.organizationId}:regra:${ctx.ruleId}`;

function proximaJanela(): string {
  const janelaMs = JANELA_DO_LIMITE_SEG * 1000;
  return new Date((Math.floor(Date.now() / janelaMs) + 1) * janelaMs).toISOString();
}

async function postponeUntil(ctx: ActionCtx): Promise<string | null> {
  const [daOrg, daRegra] = await Promise.all([
    peekRateLimit(baldeDaOrg(ctx), JANELA_DO_LIMITE_SEG),
    peekRateLimit(baldeDaRegra(ctx), JANELA_DO_LIMITE_SEG),
  ]);
  if (daOrg < LIMITE_DE_EMAILS_POR_JANELA && daRegra < LIMITE_DE_EMAILS_POR_REGRA) return null;
  return proximaJanela();
}

/** Quem recebe: o contato, o responsável do negócio, uma pessoa da equipe ou um endereço gravado na regra. */
type Destinatario = "contato" | "dono_do_lead" | "membro_da_equipe" | "fixo";

/**
 * Endereço com cara de endereço. NÃO é validação de entregabilidade: é o
 * piso: `to: "sem arroba"` não é um endereço a tentar, é configuração torta
 * que o provedor devolveria como erro genérico três segundos depois.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function emailValido(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();
  return EMAIL.test(limpo) ? limpo : null;
}

interface ContatoDoContexto {
  id: string;
  is_blocked?: boolean;
  email?: string | null;
  consent?: { marketing?: { declined_at?: string | null } | null } | null;
}

/** O veredito do destinatário: o `motivo` é o que vira `detail.reason`. */
type DestinatarioResolvido = { ok: true; endereco: string } | { ok: false; motivo: string };

/**
 * PARA QUEM este envio sai, com as recusas na frente.
 *
 * A ordem importa: bloqueio e opt-out vêm ANTES do endereço, porque dizer
 * "sem e-mail" para um contato que pediu para não receber ensinaria quem lê
 * a caçar um cadastro que não é o problema.
 */
async function resolverDestinatario(
  ctx: ActionCtx,
  destinatario: Destinatario,
  fixo: string,
  membroId: string,
): Promise<DestinatarioResolvido> {
  if (destinatario === "fixo") return { ok: true, endereco: fixo };

  if (destinatario === "membro_da_equipe") {
    if (membroId === "") return { ok: false, motivo: "sem_membro" };
    // O VÍNCULO, conferido AGORA: revogar a pessoa não reescreve a regra.
    // Mesmo filtro do caminho do dono logo abaixo: só membro ativo DESTA
    // organização.
    const { data: membro, error: erroDaConsulta } = await ctx.admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", ctx.organizationId)
      .eq("user_id", membroId)
      .is("revoked_at", null)
      .maybeSingle();
    if (erroDaConsulta) return { ok: false, motivo: "membro_indeterminado" };
    if (!membro) return { ok: false, motivo: "membro_fora_da_equipe" };
    try {
      const { data } = await ctx.admin.auth.admin.getUserById(membroId);
      const email = emailValido(data?.user?.email);
      return email ? { ok: true, endereco: email } : { ok: false, motivo: "membro_sem_email" };
    } catch {
      // Mesma tolerância do caminho do dono: o acesso da pessoa nunca derruba o
      // envio inteiro, aqui ele só não tem endereço para mandar.
      return { ok: false, motivo: "membro_sem_email" };
    }
  }

  if (destinatario === "dono_do_lead") {
    const lead = ctx.context.lead as { owner_user_id?: string | null } | undefined;
    const ownerId = typeof lead?.owner_user_id === "string" ? lead.owner_user_id : null;
    if (!ownerId) return { ok: false, motivo: "dono_sem_email" };
    // Só quem ainda é da equipe recebe: revogar um membro não limpa
    // `crm_leads.owner_user_id`, então o responsável gravado pode ser um
    // ex-membro. Mesma régua de `assign-owner.ts` e das funções de agenda.
    const { data: membro, error: erroDaConsulta } = await ctx.admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", ctx.organizationId)
      .eq("user_id", ownerId)
      .is("revoked_at", null)
      .maybeSingle();
    // Consulta que não voltou não é "não é membro": não envia, e diz que foi a
    // consulta (frase de `membro_indeterminado`), não a configuração.
    if (erroDaConsulta) return { ok: false, motivo: "membro_indeterminado" };
    if (!membro) return { ok: false, motivo: "dono_fora_da_equipe" };
    try {
      const { data } = await ctx.admin.auth.admin.getUserById(ownerId);
      const email = emailValido(data?.user?.email);
      return email ? { ok: true, endereco: email } : { ok: false, motivo: "dono_sem_email" };
    } catch {
      // Mesma tolerância de `call-webhook.ts`: o apelido/contato do dono nunca
      // derruba o envio inteiro: aqui ele só não tem endereço para mandar.
      return { ok: false, motivo: "dono_sem_email" };
    }
  }

  const contact = ctx.context.contact as ContatoDoContexto | undefined;
  if (!contact) return { ok: false, motivo: "no_contact" };
  if (contact.is_blocked) return { ok: false, motivo: "contact_blocked" };
  // Recusa registrada: não "grant ausente". Ver `guarda-do-contato.ts`.
  if (contact.consent?.marketing?.declined_at) return { ok: false, motivo: "consent_declined" };
  const email = emailValido(contact.email);
  return email ? { ok: true, endereco: email } : { ok: false, motivo: "no_email" };
}

/**
 * O CÓDIGO da falha que vai para a tela, um por vocabulário do provedor.
 *
 * Não é tradução: é o mapa que `MOTIVO_DA_PARADA` (aba Atividade) usa para
 * dar a frase. `not_configured` e `sender_rejected` mandam para lugares
 * diferentes (uma chave em branco, um remetente rejeitado), e achatar os dois
 * em "falhou" é o defeito que o roteador já pagou uma vez.
 */
function codigoDaFalha(erro: string | undefined): string {
  switch (erro) {
    case "not_configured":
      return "email_nao_configurado";
    case "rate_limited":
      return "email_limite_atingido";
    case "dominio_nao_verificado":
      return "dominio_nao_verificado";
    default:
      return "email_recusado";
  }
}

function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * O corpo nos DOIS formatos que a tela oferece.
 *
 * Em `texto`, o `<` digitado pelo operador é dado de quem escreve, não HTML -
 * escapar é o que impede `a < b` de virar tag quebrada no cliente de e-mail.
 * Em `html`, a marcação do OPERADOR entra como está (é a promessa do
 * formato), mas os valores interpolados já chegam escapados: o nome do
 * contato é texto, não marcação. A versão `text` tira as tags: cliente sem
 * HTML e leitor de tela comem a mesma frase.
 */
function corpoParaHtml(corpo: string, formato: string): string {
  if (formato === "html") return corpo;
  return escaparHtml(corpo).replace(/\n/g, "<br />\n");
}

function corpoParaTexto(corpo: string, formato: string): string {
  if (formato === "texto") return corpo;
  return corpo.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

async function execute(
  ctx: ActionCtx,
  config: Record<string, unknown>,
): Promise<ActionResultDetail> {
  const bruto = config.destinatario;
  const destinatario: Destinatario | null =
    bruto === "contato" || bruto === "dono_do_lead" || bruto === "membro_da_equipe" || bruto === "fixo"
      ? bruto
      : null;
  const assunto = typeof config.assunto === "string" ? config.assunto.trim() : "";
  const corpo = typeof config.corpo === "string" ? config.corpo.trim() : "";
  const formato = config.formato === "html" ? "html" : "texto";
  const fixo = typeof config.email_fixo === "string" ? config.email_fixo.trim() : "";
  const membroId = typeof config.membro_id === "string" ? config.membro_id.trim() : "";

  // Mesma recusa de `send-whatsapp.ts`: sem o essencial a regra não roda, e
  // dizer "failed silencioso" aqui deixaria quem opera procurando o transporte.
  if (
    !destinatario ||
    !assunto ||
    !corpo ||
    (destinatario === "fixo" && !fixo) ||
    (destinatario === "membro_da_equipe" && !membroId)
  ) {
    return { type: "send_email", status: "failed", error: "missing_config" };
  }

  // Sem serviço de e-mail na instalação: recusa clara, antes de qualquer
  // consulta e sem gastar o teto. Nunca lança.
  if (!isEmailConfigured()) {
    return { type: "send_email", status: "failed", error: "email_nao_configurado", detail: { destinatario, via: null } };
  }

  const para = await resolverDestinatario(ctx, destinatario, fixo, membroId);
  if (!para.ok) {
    return { type: "send_email", status: "skipped", detail: { reason: para.motivo } };
  }

  const assuntoPronto = renderTemplate(assunto, ctx.context);
  const corpoPronto = renderTemplate(corpo, ctx.context);
  // No HTML, cada valor de fora (contato, negócio) entra como texto.
  const corpoHtml = formato === "html" ? renderTemplate(corpo, ctx.context, escaparHtml) : corpoPronto;

  // A consulta do `postponeUntil` é só o atalho; quem decide é esta contagem.
  // `skipped`, não `postponed`: o motor não reexecuta um evento por resultado
  // de `execute`, então "adiado" aqui diria que o e-mail ainda vai sair.
  const tetoDaRegra = await checkRateLimit(baldeDaRegra(ctx), LIMITE_DE_EMAILS_POR_REGRA, JANELA_DO_LIMITE_SEG);
  if (!tetoDaRegra.allowed) {
    return { type: "send_email", status: "skipped", detail: { reason: "email_limite_atingido", destinatario } };
  }
  const teto = await checkRateLimit(baldeDaOrg(ctx), LIMITE_DE_EMAILS_POR_JANELA, JANELA_DO_LIMITE_SEG);
  if (!teto.allowed) {
    return { type: "send_email", status: "skipped", detail: { reason: "email_limite_atingido", destinatario } };
  }
  const marca = await marcaDaSaida(ctx.organizationId);
  const resultado = await sendEmail({
    to: para.endereco,
    subject: assuntoPronto,
    html: corpoParaHtml(corpoHtml, formato),
    text: corpoParaTexto(corpoPronto, formato),
    // Mesma tag da cobrança, com o valor que diz de ONDE veio: no painel da
    // Resend dá para separar o envio de automação do convite de equipe.
    tags: [{ name: "origem", value: "automacao" }],
    fromName: marca.nome,
  });

  const base = { destinatario, via: "resend" as const };
  if (!resultado.ok) {
    return {
      type: "send_email",
      status: "failed",
      error: codigoDaFalha(resultado.error),
      // A frase do provedor é detalhe TÉCNICO (aba Atividade mostra em corpo
      // menor): ela é em inglês e vem do provedor, não é o que quem opera lê
      // primeiro: por isso mora aqui e não no `error`.
      detail: { ...base, error: resultado.details ?? null },
    };
  }
  return {
    type: "send_email",
    status: "success",
    detail: { ...base, email_id: resultado.id ?? null },
  };
}

registerAction({ type: "send_email", postponeUntil, execute });
