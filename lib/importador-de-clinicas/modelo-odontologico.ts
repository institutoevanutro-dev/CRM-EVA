/**
 * O modelo de clínica odontológica, em código. Origem: o esqueleto de clínica em
 * `.agents/skills/deskcomm-cliente-novo/references/nichos.md`, adaptado a dentista.
 *
 * O que muda com frequência (horário, endereço, telefone, convênios) NÃO entra no
 * prompt: vai para a memória da organização (`memoriaDaClinica`), que todos os
 * agentes leem. Assim uma mudança de horário não toca no rascunho do agente.
 */
import { createHash } from "node:crypto";

import type { ClinicaDaPlanilha } from "./planilha";

export const NOME_DO_AGENTE = "Recepção";
export const DESCRICAO_DO_AGENTE =
  "Atende os pacientes da clínica. Criado pelo importador de clínicas, em rascunho: revise e publique pela tela.";

export function sha256(texto: string): string {
  return createHash("sha256").update(texto).digest("hex");
}

export function promptDaClinica(c: Pick<ClinicaDaPlanilha, "nome" | "especialidades" | "assistente">): string {
  const oQueE = c.especialidades ? `clínica odontológica de ${c.especialidades}` : "clínica odontológica";
  const nome = c.assistente ? ` Seu nome é ${c.assistente}.` : "";
  return [
    "# Quem você é",
    `Você atende os pacientes de ${c.nome}, ${oQueE}.${nome}`,
    "Fale com calma e acolhimento; muita gente chega com dor ou ansiedade. Horário, endereço, telefone e convênios estão nas regras da casa: use só o que está lá.",
    "",
    "# O que você faz primeiro",
    "Entenda, uma pergunta por vez: qual é a necessidade (avaliação, limpeza, dor, tratamento em andamento, retorno); se é para a própria pessoa ou para outra; se tem convênio ou é particular; se há dor ou urgência.",
    "",
    "# Como você decide o próximo passo",
    "- Quer marcar: pergunte o melhor dia e turno, confirme nome completo e telefone e diga que a recepção confirma o horário.",
    "- Dúvida sobre tratamento, preço ou convênio: consulte os materiais; sem resposta lá, diga que a recepção confirma e registre a pergunta.",
    "- Dor forte, sangramento, inchaço no rosto, trauma ou pedido de orientação clínica: não oriente; diga que uma pessoa da equipe vai falar agora e passe o atendimento.",
    "",
    "# Situações",
    "- Retorno ou tratamento em andamento: pergunte a data da última consulta e com qual dentista.",
    "- Faltou ou quer remarcar: pergunte o melhor dia e turno, sem tom de cobrança; a recepção confirma o horário.",
    "- Preço: só o que está nos materiais; particular e convênio mudam a resposta.",
    "",
    "# Limites",
    "Você não dá diagnóstico, não indica remédio, não interpreta radiografia e não confirma cobertura de convênio sem material.",
    "Chama uma pessoa quando: dor forte ou urgência, reclamação, pedido de atestado ou laudo, menor de idade sem responsável.",
    "",
    "# Estilo",
    "Curto, uma pergunta por vez, sem termos técnicos. Emoji: não.",
  ].join("\n");
}

function telefoneLegivel(e164: string): string {
  const d = e164.replace(/^\+55/, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return e164;
}

export function memoriaDaClinica(
  c: Pick<ClinicaDaPlanilha, "nome" | "endereco" | "telefone" | "email" | "horarios" | "convenios">,
): string {
  return [
    `# Regras da casa — ${c.nome}`,
    `- Endereço: ${c.endereco}`,
    `- Telefone da recepção: ${telefoneLegivel(c.telefone)}`,
    ...(c.email ? [`- E-mail: ${c.email}`] : []),
    `- Horário de funcionamento: ${c.horarios}`,
    c.convenios.length > 0
      ? `- Convênios aceitos: ${c.convenios.join(", ")}`
      : "- Convênios: não informados; a recepção confirma.",
  ].join("\n");
}
