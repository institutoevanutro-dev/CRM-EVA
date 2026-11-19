/**
 * O código da auditoria (`lead.created`) em frase de gente ("criou um negócio").
 *
 * Cobre as áreas que a clínica lê no Histórico de alterações; o que não está
 * aqui volta `null` e a tela mostra o código cru — melhor que uma frase
 * inventada. Sem `import`, como `actions.ts`: vai para o bundle do navegador.
 *
 * Os textos são CHAVES do dicionário (`lib/i18n/dicionario.ts`): quem pinta
 * passa cada parte por `t()`.
 */

/** Áreas do filtro "O quê", na ordem em que aparecem. `objeto` completa o verbo. */
export const AREAS_DA_AUDITORIA = {
  contact: { nome: "Contatos", objeto: "um contato" },
  lead: { nome: "Negócios", objeto: "um negócio" },
  conversation: { nome: "Conversas", objeto: "uma conversa" },
  message: { nome: "Mensagens", objeto: "uma mensagem" },
  agenda: { nome: "Agenda", objeto: "a agenda" },
  crm_task: { nome: "Tarefas", objeto: "uma tarefa" },
  pipeline: { nome: "Funis", objeto: "um funil" },
  campaign: { nome: "Campanhas", objeto: "uma campanha" },
  ai_agent: { nome: "Agentes de IA", objeto: "um agente de IA" },
  followup_flow: { nome: "Follow-ups", objeto: "um follow-up" },
  template: { nome: "Respostas rápidas", objeto: "uma resposta rápida" },
  channel: { nome: "Conexões", objeto: "uma conexão" },
  member: { nome: "Equipe", objeto: "um membro da equipe" },
  auth: { nome: "Entrada no sistema", objeto: "o acesso" },
  lgpd: { nome: "LGPD", objeto: "um pedido de LGPD" },
  webhook: { nome: "Formulários", objeto: "um formulário" },
  automation: { nome: "Automações", objeto: "uma automação" },
  org: { nome: "Configurações", objeto: "a configuração da clínica" },
} as const;

export type AreaDaAuditoria = keyof typeof AREAS_DA_AUDITORIA;

const VERBO: Record<string, string> = {
  created: "criou",
  updated: "alterou",
  deleted: "apagou",
  archived: "arquivou",
  viewed: "abriu",
  exported: "exportou",
  imported: "importou",
  duplicated: "duplicou",
  paused: "pausou",
  resumed: "retomou",
  cancelled: "cancelou",
  reactivated: "reativou",
  published: "publicou",
  connected: "conectou",
  tags_changed: "mudou as etiquetas de",
  scheduled: "agendou",
  revoked: "revogou",
  closed: "encerrou",
  claimed: "assumiu",
  transferred: "transferiu",
  sent: "enviou",
  received: "recebeu",
};

/** Códigos que pedem frase própria (o verbo genérico ficaria errado). */
const FRASE_EXATA: Record<string, string> = {
  "auth.login_success": "entrou no sistema",
  "auth.login_failed": "errou a senha ao entrar",
  "auth.logout": "saiu do sistema",
  "auth.evalink_login": "entrou pelo EvaLink",
  "auth.password_reset_completed": "trocou a senha",
  "contact.viewed": "abriu a ficha de um contato",
  "contact.cpf_viewed": "viu o CPF de um contato",
  "contact.anonymized": "anonimizou um contato",
  "contact.merged": "juntou duas fichas de contato",
  "contact.blocked": "bloqueou um contato",
  "contact.unblocked": "desbloqueou um contato",
  "lead.moved": "mudou um negócio de etapa",
  "lead.won": "marcou um negócio como ganho",
  "lead.lost": "marcou um negócio como perdido",
  "conversation.note_added": "escreveu uma nota numa conversa",
  "member.invited": "convidou alguém para a equipe",
  "member.role_changed": "mudou o papel de alguém da equipe",
  "agenda.appointment_created": "marcou uma consulta",
  "agenda.appointment_updated": "alterou uma consulta",
  "agenda.appointment_rescheduled": "remarcou uma consulta",
  "agenda.appointment_cancelled": "desmarcou uma consulta",
};

/** A frase da ação, sem o sujeito; `null` quando não há tradução segura. */
export function fraseDaAcao(acao: string): { verbo: string; objeto?: string } | null {
  const exata = FRASE_EXATA[acao];
  if (exata) return { verbo: exata };
  const ponto = acao.indexOf(".");
  if (ponto < 0) return null;
  const area = acao.slice(0, ponto) as AreaDaAuditoria;
  const verbo = VERBO[acao.slice(ponto + 1)];
  const def = AREAS_DA_AUDITORIA[area];
  if (!verbo || !def) return null;
  return { verbo, objeto: def.objeto };
}
