import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { ensureConversation, sessaoProntaParaEnvio } from "@/lib/automation/start-conversation";
import { espacarEnvio } from "@/lib/automation/throttle";
import { sessaoEstaConectada } from "@/lib/agendamento-mensagem/envio";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";

// Envio do PDF semanal do Marketing pelo WhatsApp da clínica. Mesmo caminho do lembrete da agenda
// (ensureConversation + sendMessageHandler, ator webhook_source). Uma vez por semana por número,
// garantido pela unique da 0431; o número completo nunca volta na resposta nem no audit.
//
// Revisão final (22/11): o token do Marketing passou a ESCREVER (manda WhatsApp), então a semana só
// pode ser a que acabou de terminar ou o teste de hoje, no relógio do servidor — um token vazado não
// inventa semanas para furar o "uma vez por semana".
const PDF_MAX = 8 * 1024 * 1024;
const comecaComPdf = (b64: string) => Buffer.from(b64.slice(0, 12), "base64").subarray(0, 5).toString("latin1") === "%PDF-";
const digitosValidos = (t: string) => {
  const n = t.replace(/\D/g, "").length;
  return n >= 10 && n <= 13;
};
export const EntradaDoResumo = z.object({
  semana: z.string().regex(/^(\d{4}-W\d{2}|teste-\d{4}-\d{2}-\d{2})$/),
  legenda: z.string().trim().min(1).max(700),
  nome_arquivo: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,75}\.pdf$/),
  pdf_base64: z.string().min(8).max(Math.ceil(PDF_MAX / 3) * 4).refine(comecaComPdf, "pdf_invalido"),
  destinatarios: z
    .array(z.object({ nome: z.string().trim().min(1).max(80), telefone: z.string().trim().min(8).max(25).refine(digitosValidos, "telefone_invalido") }))
    .min(1)
    .max(5),
});
export type EntradaDoResumo = z.infer<typeof EntradaDoResumo>;
/** Espelho do CHECK de `marketing_resumo_envios.status` (0431). */
export const STATUS_DO_ENVIO_DO_RESUMO = ["enviando", "enviado", "falhou"] as const;
export type StatusDoEnvioDoResumo = (typeof STATUS_DO_ENVIO_DO_RESUMO)[number];
export type Resultado = { enviados: number; ja_enviados: number; falhas: { final: string; codigo: string }[] };

const RETOMAR_ENVIANDO_MS = 10 * 60 * 1000;
const SILENCIO_DO_BOT_MS = 7 * 24 * 60 * 60 * 1000;

const diaSP = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
function semanaIso(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const quinta = new Date(d);
  quinta.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(quinta.getUTCFullYear(), 0, 4));
  const n = 1 + Math.round(((quinta.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${quinta.getUTCFullYear()}-W${String(n).padStart(2, "0")}`;
}

/** A semana completa anterior (seg a dom, em SP) ou o teste de hoje. Mesma régua do Marketing. */
export function semanaPermitida(semana: string, agora = new Date()): boolean {
  const hoje = diaSP(agora);
  if (semana === `teste-${hoje}`) return true;
  const dow = (new Date(`${hoje}T12:00:00Z`).getUTCDay() + 6) % 7;
  const segundaAnterior = new Date(`${hoje}T12:00:00Z`);
  segundaAnterior.setUTCDate(segundaAnterior.getUTCDate() - dow - 7);
  return semana === semanaIso(segundaAnterior.toISOString().slice(0, 10));
}

/** Reserva que falhou, ou que ficou presa em "enviando" (processo morreu no meio), pode ser retomada. */
export function podeRetomar(linha: { status: string; updated_at: string }, agora = Date.now()): boolean {
  if (linha.status === "falhou") return true;
  return linha.status === "enviando" && agora - Date.parse(linha.updated_at) > RETOMAR_ENVIANDO_MS;
}

export type Dependencias = {
  reservar(semana: string, telefone: string): Promise<"nova" | "ja">;
  concluir(semana: string, telefone: string, status: Exclude<StatusDoEnvioDoResumo, "enviando">, erro?: string, messageId?: string): Promise<void>;
  acharOuCriarContato(nome: string, canonico: string, variantes: string[]): Promise<string>;
  sessao(): Promise<string | null>;
  conversa(contactId: string, sessionId: string): Promise<string>;
  subirPdf(conversationId: string, nome: string, bytes: Buffer): Promise<string>;
  espacar(sessionId: string): Promise<void>;
  enviar(conversationId: string, caminho: string, legenda: string, nomeArquivo: string, tamanho: number): Promise<{ id: string; status: string }>;
  /** Mensagem que o handler deixou em `queued`: vira `failed`, senão o reenvio da fila manda só a legenda. */
  descartarFila(messageId: string): Promise<void>;
  /** A atendente virtual não responde a quem recebeu o resumo (o "ok" do gestor não é lead). */
  silenciarBot(conversationId: string): Promise<void>;
  auditar(metadata: Record<string, unknown>): Promise<void>;
};

/**
 * O número do destinatário em três formas: canônico (como `contacts.phone_number` grava), as variantes
 * de busca (com e sem o nono dígito) e só os dígitos (a chave da reserva). Digitado sem o 55 (10 ou 11
 * dígitos), ganha o 55: o `canonicalPhoneBR` não inventa país, e "27 99999-0000" viraria +27.
 */
export function telefoneDoDestinatario(digitado: string): { canonico: string; variantes: string[]; digitos: string } {
  const d = digitado.replace(/\D/g, "");
  const comPais = d.length === 10 || d.length === 11 ? `55${d}` : d;
  const canonico = canonicalPhoneBR(`+${comPais}`);
  return { canonico, variantes: phoneLookupVariants(canonico), digitos: canonico.replace(/\D/g, "") };
}

export function dependenciasReais(admin: SupabaseClient, org: string, requestId: string): Dependencias {
  const agora = () => new Date().toISOString();
  const doEnvio = (semana: string, telefone: string) =>
    admin.from("marketing_resumo_envios").select("status, updated_at").eq("organization_id", org).eq("semana", semana).eq("telefone", telefone);
  return {
    async reservar(semana, telefone) {
      const { error } = await admin.from("marketing_resumo_envios").insert({ organization_id: org, semana, telefone });
      if (!error) return "nova";
      if (error.code !== "23505") throw new Error(error.message);
      const { data: linha, error: erroLeitura } = await doEnvio(semana, telefone).maybeSingle();
      if (erroLeitura || !linha) throw new Error(erroLeitura?.message ?? "reserva_sumiu");
      const atual = linha as { status: string; updated_at: string };
      if (!podeRetomar(atual)) return "ja";
      // CAS no status e no updated_at lidos: dois pedidos simultâneos não retomam os dois.
      const { data, error: erroRetomada } = await admin
        .from("marketing_resumo_envios")
        .update({ status: "enviando", erro: null, updated_at: agora() })
        .eq("organization_id", org).eq("semana", semana).eq("telefone", telefone)
        .eq("status", atual.status).eq("updated_at", atual.updated_at)
        .select("id");
      if (erroRetomada) throw new Error(erroRetomada.message);
      return data?.length ? "nova" : "ja";
    },
    async concluir(semana, telefone, status, erro, messageId) {
      const { error } = await admin
        .from("marketing_resumo_envios")
        .update({ status, erro: erro ?? null, message_id: messageId ?? null, updated_at: agora() })
        .eq("organization_id", org).eq("semana", semana).eq("telefone", telefone);
      if (error) throw new Error(error.message);
    },
    async acharOuCriarContato(nome, canonico, variantes) {
      const { data: achado, error: erroBusca } = await admin
        .from("contacts").select("id")
        .eq("organization_id", org).in("phone_number", variantes).is("is_merged_into", null)
        .order("created_at", { ascending: true }).limit(1).maybeSingle();
      if (erroBusca) throw new Error(erroBusca.message);
      if (achado) return (achado as { id: string }).id;
      // Contato novo nasce com a IA desligada: a atendente virtual não responde a quem recebe o resumo.
      const { data, error } = await admin
        .from("contacts")
        .insert({
          organization_id: org, name: nome, phone_number: canonico, source: "manual", ai_opt_out: true,
          tags: ["equipe"], source_metadata: { origem: "interno", motivo: "resumo_semanal" },
        })
        .select("id").single();
      if (error) throw new Error(error.message);
      return (data as { id: string }).id;
    },
    // Só número CONECTADO: com a sessão fora do ar o handler grava `queued`, e o reenvio da fila
    // mandaria depois só a legenda (sendText), sem o PDF.
    async sessao() {
      const id = await sessaoProntaParaEnvio(admin, org);
      return id && (await sessaoEstaConectada(admin, org, id)) ? id : null;
    },
    conversa: (contactId, sessionId) => ensureConversation(admin, org, contactId, sessionId),
    async subirPdf(conversationId, nome, bytes) {
      const caminho = `${org}/${conversationId}/${nome}`;
      const { error } = await admin.storage
        .from("whatsapp-media")
        .upload(caminho, bytes, { contentType: "application/pdf", upsert: true });
      if (error) throw new Error(error.message);
      return caminho;
    },
    espacar: (sessionId) => espacarEnvio(sessionId),
    async enviar(conversationId, caminho, legenda, nomeArquivo, tamanho) {
      const m = await sendMessageHandler(
        admin as unknown as Parameters<typeof sendMessageHandler>[0],
        { organization_id: org, actor: { type: "webhook_source", id: "marketing-resumo" }, requestId: `marketing-resumo:${requestId}` } as Parameters<typeof sendMessageHandler>[1],
        {
          conversation_id: conversationId, type: "document", body: legenda, media_storage_path: caminho,
          media_filename: nomeArquivo, media_mime: "application/pdf", media_size_bytes: tamanho,
        } as Parameters<typeof sendMessageHandler>[2],
      );
      return { id: m.id, status: m.status };
    },
    async descartarFila(messageId) {
      const { error } = await admin
        .from("messages")
        .update({ status: "failed", error_code: "resumo_sem_conexao", error_message: "Resumo semanal: o número não estava conectado." })
        .eq("organization_id", org).eq("id", messageId).eq("status", "queued");
      if (error) throw new Error(error.message);
    },
    async silenciarBot(conversationId) {
      const ate = new Date(Date.now() + SILENCIO_DO_BOT_MS).toISOString();
      // Só estende: um silêncio maior que alguém já pôs fica como está.
      const { error } = await admin
        .from("conversations")
        .update({ bot_silenced_until: ate })
        .eq("organization_id", org).eq("id", conversationId)
        .or(`bot_silenced_until.is.null,bot_silenced_until.lt.${ate}`);
      if (error) throw new Error(error.message);
    },
    auditar: (metadata) =>
      audit({ action: "marketing.resumo_enviado", organizationId: org, resourceType: "marketing_resumo", metadata, requestId }),
  };
}

export async function enviarResumo(
  admin: SupabaseClient,
  org: string,
  e: EntradaDoResumo,
  requestId: string,
  d: Dependencias = dependenciasReais(admin, org, requestId),
): Promise<Resultado> {
  const r: Resultado = { enviados: 0, ja_enviados: 0, falhas: [] };
  const bytes = Buffer.from(e.pdf_base64, "base64");
  const sessionId = await d.sessao();
  for (const dest of e.destinatarios) {
    const tel = telefoneDoDestinatario(dest.telefone);
    const final = tel.digitos.slice(-4);
    if (!sessionId) { r.falhas.push({ final, codigo: "sem_whatsapp_conectado" }); continue; }
    let reservado = false;
    try {
      if ((await d.reservar(e.semana, tel.digitos)) === "ja") { r.ja_enviados++; continue; }
      reservado = true;
      const contactId = await d.acharOuCriarContato(dest.nome, tel.canonico, tel.variantes);
      const conversationId = await d.conversa(contactId, sessionId);
      const caminho = await d.subirPdf(conversationId, e.nome_arquivo, bytes);
      await d.espacar(sessionId);
      const m = await d.enviar(conversationId, caminho, e.legenda, e.nome_arquivo, bytes.length);
      // O desfecho vem do ESTADO da mensagem (lib/automation/desfecho-do-envio.ts): failed/queued não é envio.
      if (m.status === "failed" || m.status === "queued") {
        if (m.status === "queued") await d.descartarFila(m.id);
        await d.concluir(e.semana, tel.digitos, "falhou", `status_${m.status}`, m.id);
        r.falhas.push({ final, codigo: "nao_enviado" });
        continue;
      }
      r.enviados++;
      // A mensagem saiu: o que falhar daqui em diante é registro, não falha do envio.
      await d.concluir(e.semana, tel.digitos, "enviado", undefined, m.id).catch((err: unknown) =>
        logger.error("[marketing.resumo] não gravei o envio", { requestId, final, error: err instanceof Error ? err.message : String(err) }));
      await d.silenciarBot(conversationId).catch((err: unknown) =>
        logger.error("[marketing.resumo] não silenciei a atendente", { requestId, final, error: err instanceof Error ? err.message : String(err) }));
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 300) : "erro";
      logger.error("[marketing.resumo] envio falhou", { requestId, final, error: msg });
      if (reservado) await d.concluir(e.semana, tel.digitos, "falhou", msg).catch(() => {});
      r.falhas.push({ final, codigo: "erro_no_envio" });
    }
  }
  await d.auditar({ semana: e.semana, enviados: r.enviados, ja_enviados: r.ja_enviados, falhas: r.falhas.length });
  return r;
}
