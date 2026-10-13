// lib/conversas/exporta-pdf.tsx
//
// O PDF DA CONVERSA: o histórico de UMA conversa virando documento legível,
// datado e em ordem, para quem atende guardar (anexar ao prontuário, responder
// a um pedido do paciente).
//
// Porte de melgarafael/DeskcommCRM #2229 (contribuição de @webtecnica, refs
// #1982). O que este fork faz diferente, e por quê:
//
//   - a marca vem de `marcaDaSaida()` (a regra da casa para saída sem DOM);
//     o upstream usa um helper de propostas que não existe aqui. Logo não é
//     desenhado: buscar imagem remota dentro do render é rede no meio do PDF;
//   - a autoria segue o que ESTE banco grava: `external_device` é a equipe
//     respondendo pelo celular (nunca a IA), e `ai` sem marca de modelo na
//     metadata é envio automático (lembrete, campanha, resposta pronta);
//   - mídia entra como rótulo (tipo e nome do arquivo), nunca embutida: o
//     arquivo mora em Storage privado e um exame dentro de um PDF solto é
//     vazamento esperando acontecer;
//   - envio que FALHOU é dito na linha: num documento que serve de prova, uma
//     mensagem que o paciente nunca recebeu não pode parecer entregue;
//   - o aviso de dados pessoais e o período entram no cabeçalho.
//
// O QUE NUNCA ENTRA: nota interna (`conversation_notes` é outra tabela, e este
// módulo não a lê), rascunho da IA, `metadata` da mensagem (citações, traços,
// chamadas de ferramenta), CPF ou qualquer campo cifrado do contato.
//
// LGPD: o corpo da mensagem não vai para log. Só ids e contagem.
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";
import React from "react";

import { marcaDaSaida, NEUTROS_DE_SAIDA } from "@/lib/branding/saida";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoContato, type ContatoNomeavel } from "@/lib/contacts/rotulo-do-contato";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";
import { logger } from "@/lib/logger";
import { resolveSharedContact } from "@/lib/messaging/contact-card";
import { MARCADOR_NAO_LIDA } from "@/lib/messaging/media/derivable";
import { nomeDeArquivoLimpo } from "@/lib/messaging/media/nome-de-arquivo";

/**
 * Quantas mensagens cabem NUM ARQUIVO. O número sai da memória do render, que
 * roda no mesmo processo que serve o CRM (`mem_limit` do `app` no compose de
 * produção). Medição do upstream (Node 22, mensagens de 8 a 37 palavras),
 * acréscimo de RSS: 250 → 21 MB · 500 → 131 MB · 1000 → 411 MB · 2000 → 859 MB.
 * Não é linear, e o tempo também não (500 → 1,9 s; 5000 → 177 s).
 *
 * Passou do teto, o PDF leva as mais recentes e AVISA no cabeçalho: corte
 * declarado ainda orienta; corte achado depois não.
 */
export const LIMITE_DE_MENSAGENS = 500;

/**
 * Teto de caracteres por mensagem. Sem ele, o limite de mensagens não limita
 * nada: 500 textos colados de 60 mil caracteres são 30 MB dentro do render.
 * O corte é dito na própria linha.
 */
export const LIMITE_DE_CARACTERES_POR_MENSAGEM = 5000;

const FUSO_PADRAO = "America/Sao_Paulo";

/** O que a rota lê de `messages`. `metadata` vem, mas só três chaves dela são lidas aqui. */
export const COLUNAS_DA_MENSAGEM =
  "id, direction, type, status, body, sent_via, sent_by_user_id, media_mime, media_storage_path, media_derived_text, media_derived_status, sent_at, created_at, edited_at, revoked_at, metadata";

export interface ConversaParaPdf {
  id: string;
  channel: string | null;
  contato: ContatoNomeavel | null;
}

export interface MensagemParaPdf {
  id: string;
  direction: "inbound" | "outbound";
  type: string;
  status?: string | null;
  body: string | null;
  sent_via: string;
  sent_by_user_id: string | null;
  media_mime?: string | null;
  media_storage_path?: string | null;
  media_derived_text?: string | null;
  media_derived_status?: string | null;
  sent_at: string | null;
  created_at: string;
  edited_at?: string | null;
  revoked_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

type Traduz = (texto: string) => string;

export interface OpcoesDoPdfDaConversa {
  t: Traduz;
  exportadoPor?: string | null;
  /** Nome de quem enviou, por user id. A rota resolve. */
  nomesDosUsuarios?: Map<string, string | null>;
  fuso?: string;
  /** Injetável para o teste ser determinístico. */
  geradoEm?: string;
  /** Conversa maior que o limite: o cabeçalho declara o corte. */
  truncada?: boolean;
  idioma?: Idioma;
}

/** Quem falou, como CATEGORIA. O nome vai em `autor`. */
export type PapelDoAutor = "contato" | "equipe" | "ia" | "automatico" | "sistema";

export interface LinhaDoHistorico {
  id: string;
  direcao: "inbound" | "outbound";
  papel: PapelDoAutor;
  autor: string;
  /** `dd/mm/aaaa hh:mm` no fuso do documento. */
  horario: string;
  instante: number;
  texto: string;
  /** Envio que não chegou (falhou) ou ainda não saiu. `null` = sem ressalva. */
  ressalva: string | null;
}

export type PdfDaConversa =
  | { ok: true; buffer: Buffer; nomeDoArquivo: string; linhas: number }
  | { ok: false; motivo: string };

function partes(instante: number, fuso: string, idioma: Idioma) {
  const formatar = (zona: string) =>
    new Intl.DateTimeFormat(tagDeIdioma(idioma), {
      timeZone: zona,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instante));
  let lista: Intl.DateTimeFormatPart[];
  try {
    lista = formatar(fuso);
  } catch {
    // `timezone` é coluna de tela: valor torto não derruba a exportação.
    lista = formatar(FUSO_PADRAO);
  }
  const campo = (tipo: string) => lista.find((p) => p.type === tipo)?.value ?? "";
  return { ano: campo("year"), mes: campo("month"), dia: campo("day"), hora: campo("hour"), minuto: campo("minute") };
}

function dataHora(instante: number | null, fuso: string, idioma: Idioma): string {
  if (instante === null || !Number.isFinite(instante)) return "-";
  const d = partes(instante, fuso, idioma);
  return `${d.dia}/${d.mes}/${d.ano} ${d.hora}:${d.minuto}`;
}

function instanteDe(m: MensagemParaPdf): number {
  const instante = Date.parse(m.sent_at ?? m.created_at ?? "");
  return Number.isFinite(instante) ? instante : 0;
}

/**
 * QUEM FALOU. A mesma leitura de `components/inbox/MessageBubble.tsx`, com uma
 * diferença: a tela diz "Você"/"Atendente" para quem está olhando; o documento
 * sai da tela, então diz o NOME de quem enviou.
 *
 * `external_device` é alguém da equipe respondendo pelo WhatsApp do celular. O
 * dado não diz quem, e por isso o rótulo não inventa nome. E não é a IA.
 */
function autorDaMensagem(
  m: MensagemParaPdf,
  conversa: ConversaParaPdf,
  opcoes: { t: Traduz; nomesDosUsuarios?: Map<string, string | null> },
): { papel: PapelDoAutor; autor: string } {
  const { t } = opcoes;
  if (m.type === "system" || m.sent_via === "system") return { papel: "sistema", autor: t("Sistema") };
  if (m.direction !== "outbound") return { papel: "contato", autor: rotuloDoContato(conversa.contato, t) };
  if (m.sent_via === "ai") {
    // `sent_via='ai'` NÃO basta neste fork: `_handler.ts` grava assim todo ator
    // que não é pessoa (campanha, lembrete da Agenda, automação, resposta
    // pronta). Quem marca texto ESCRITO por modelo é a metadata, a mesma regra
    // de `ehFalaDaIa` em `lib/ai/handoff/aviso-ao-lead.ts`. Só as três chaves
    // são lidas; nada da metadata é impresso.
    const meta = m.metadata ?? {};
    const escritaPorModelo =
      meta.aviso_de_escalacao !== true &&
      (typeof meta.ai_actor_id === "string" || meta.ai_generated === true || meta.texto_escrito_pela_ia === true);
    return escritaPorModelo
      ? { papel: "ia", autor: t("Assistente virtual (IA)") }
      : { papel: "automatico", autor: t("Mensagem automática") };
  }
  if (m.sent_via === "automation") return { papel: "automatico", autor: t("Mensagem automática") };
  if (m.sent_via === "external_device") return { papel: "equipe", autor: t("Equipe (pelo celular)") };
  const nome = m.sent_by_user_id ? opcoes.nomesDosUsuarios?.get(m.sent_by_user_id)?.trim() : null;
  return { papel: "equipe", autor: nome ? `${nome} (${t("equipe")})` : t("Equipe") };
}

const ROTULO_DO_TIPO: Record<string, string> = {
  image: "Imagem",
  video: "Vídeo",
  audio: "Áudio",
  document: "Documento",
  sticker: "Figurinha",
  location: "Localização",
  contact: "Contato compartilhado",
  reaction: "Reação",
};

/**
 * O Helvetica embutido do PDF só desenha Latin-1. Emoji e outros símbolos
 * sairiam como caractere trocado no meio da frase do paciente; registrar fonte
 * de emoji no react-pdf busca imagem numa CDN a cada render, e isso não entra.
 * O que a fonte não desenha sai do texto, e o cabeçalho avisa.
 */
function soOQueAFonteDesenha(texto: string): string {
  return texto
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\n\t -~ -ÿ€•]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * O QUE ESTA LINHA DIZ. Mídia vira rótulo: tipo e, no documento, o nome do
 * arquivo. Apagada pelo autor fica como linha sem o texto, igual à tela.
 */
function textoDaMensagem(m: MensagemParaPdf, t: Traduz): string {
  if (m.revoked_at) return t("Mensagem apagada pelo autor.");

  const blocos: string[] = [];
  const tipo = ROTULO_DO_TIPO[m.type];
  let corpo = (m.body ?? "").trim();

  if (m.type === "contact") {
    const cartao = resolveSharedContact({ type: m.type, body: m.body, metadata: m.metadata ?? {} });
    const dados = cartao ? [cartao.name, cartao.phone_number].filter(Boolean).join(", ") : "";
    blocos.push(dados ? `[${t("Contato compartilhado")}: ${dados}]` : `[${t("Contato compartilhado")}]`);
    corpo = ""; // o corpo é o vCard cru
  } else if (m.type === "document") {
    const nome = nomeDeArquivoLimpo(m.metadata?.media_filename);
    blocos.push(nome ? `[${t("Documento")}: ${nome}]` : `[${t("Documento")}]`);
    if (nome && corpo === nome) corpo = "";
  } else if (tipo) {
    blocos.push(`[${t(tipo)}]`);
  }

  if (corpo.length > LIMITE_DE_CARACTERES_POR_MENSAGEM) {
    corpo = `${corpo.slice(0, LIMITE_DE_CARACTERES_POR_MENSAGEM)} ${t("[texto cortado: a mensagem passa do limite por mensagem deste documento]")}`;
  }
  if (corpo) blocos.push(m.edited_at ? `${corpo} ${t("(editada)")}` : corpo);

  // A transcrição que a tela já mostra embaixo do áudio. É texto de máquina, e
  // o documento diz isso: ninguém pode ler como fala literal do paciente.
  const transcricao = (m.media_derived_text ?? "").trim();
  if (m.type === "audio" && m.media_derived_status === "ready" && transcricao && transcricao !== MARCADOR_NAO_LIDA) {
    blocos.push(
      `${t("Transcrição automática (pode conter erros)")}: ${transcricao.slice(0, LIMITE_DE_CARACTERES_POR_MENSAGEM)}`,
    );
  }

  const texto = soOQueAFonteDesenha(blocos.join("\n"));
  return texto || `[${t("Mensagem sem texto")}]`;
}

function ressalvaDeEnvio(m: MensagemParaPdf, t: Traduz): string | null {
  if (m.direction !== "outbound" || m.revoked_at) return null;
  if (m.status === "failed") return t("não enviada: o envio falhou");
  if (m.status === "queued" || m.status === "sending") return t("envio não confirmado");
  return null;
}

/**
 * O HISTÓRICO EM ORDEM CRONOLÓGICA. A garantia mora AQUI, não na ordem em que o
 * banco devolveu: a rota lê das mais recentes para as mais antigas (é assim que
 * o limite corta a ponta certa). Em empate, o id desempata.
 */
export function linhasDoHistorico(
  conversa: ConversaParaPdf,
  mensagens: MensagemParaPdf[],
  opcoes: { t: Traduz; nomesDosUsuarios?: Map<string, string | null>; fuso?: string; idioma?: Idioma },
): LinhaDoHistorico[] {
  const fuso = opcoes.fuso ?? FUSO_PADRAO;
  const idioma = opcoes.idioma ?? IDIOMA_PADRAO;
  return [...mensagens]
    .sort((a, b) => instanteDe(a) - instanteDe(b) || a.id.localeCompare(b.id))
    .map((m) => {
      const instante = instanteDe(m);
      return {
        id: m.id,
        direcao: m.direction,
        ...autorDaMensagem(m, conversa, opcoes),
        horario: dataHora(instante, fuso, idioma),
        instante,
        texto: textoDaMensagem(m, opcoes.t),
        ressalva: ressalvaDeEnvio(m, opcoes.t),
      };
    });
}

/** ASCII puro: `Content-Disposition` com acento depende de como o navegador decodifica. */
function nomeDeArquivo(conversa: ConversaParaPdf, geradoEm: number, fuso: string, idioma: Idioma): string {
  const slug = rotuloDoContato(conversa.contato, (texto) => texto)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const d = partes(geradoEm, fuso, idioma);
  return `historico-conversa-${slug || conversa.id.slice(0, 8)}-${d.ano}-${d.mes}-${d.dia}.pdf`;
}

const ROTULO_DO_CANAL: Record<string, string> = { whatsapp: "WhatsApp", instagram: "Instagram" };

const styles = StyleSheet.create({
  page: { padding: 32, paddingBottom: 48, fontSize: 10, fontFamily: "Helvetica", color: NEUTROS_DE_SAIDA.texto },
  marca: { fontSize: 11, fontFamily: "Helvetica-Bold" },
  titulo: { fontSize: 16, fontFamily: "Helvetica-Bold", marginTop: 2 },
  subtitulo: { fontSize: 10, color: NEUTROS_DE_SAIDA.suave, marginTop: 2, marginBottom: 6 },
  meta: { fontSize: 9, color: NEUTROS_DE_SAIDA.suave, marginTop: 1 },
  aviso: { fontSize: 9, border: `1pt solid ${NEUTROS_DE_SAIDA.linha}`, padding: 5, marginTop: 8 },
  alerta: {
    fontSize: 9,
    color: "#92400e",
    border: "1pt solid #f59e0b",
    backgroundColor: "#fffbeb",
    padding: 5,
    marginTop: 6,
  },
  secao: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 12, marginBottom: 6 },
  linha: { marginBottom: 8, paddingBottom: 4, borderBottomWidth: 0.5, borderBottomColor: NEUTROS_DE_SAIDA.linha },
  linhaCabecalho: { fontSize: 9, fontFamily: "Helvetica-Bold" },
  linhaCorpo: { fontSize: 10, lineHeight: 1.4, marginTop: 2 },
  vazio: { fontSize: 10, color: NEUTROS_DE_SAIDA.suave },
  footer: { position: "absolute", bottom: 24, left: 32, right: 32, fontSize: 8, color: NEUTROS_DE_SAIDA.suave },
});

interface DadosDoPdf {
  marca: string;
  accent: string;
  titulo: string;
  subtitulo: string;
  metadados: string[];
  aviso: string;
  alertaDeCorte: string | null;
  tituloDasMensagens: string;
  vazio: string;
  linhas: Array<{ id: string; cabecalho: string; texto: string }>;
  rotuloDePagina: string;
  rodape: string;
}

function Documento({ d }: { d: DadosDoPdf }) {
  return (
    <Document title={d.titulo} author={d.marca}>
      <Page size="A4" style={styles.page}>
        <Text style={[styles.marca, { color: d.accent }]}>{d.marca}</Text>
        <Text style={styles.titulo}>{d.titulo}</Text>
        <Text style={styles.subtitulo}>{d.subtitulo}</Text>
        {d.metadados.map((m) => (
          <Text key={m} style={styles.meta}>
            {m}
          </Text>
        ))}
        <Text style={styles.aviso}>{d.aviso}</Text>
        {d.alertaDeCorte ? <Text style={styles.alerta}>{d.alertaDeCorte}</Text> : null}
        <Text style={styles.secao}>{d.tituloDasMensagens}</Text>
        {d.linhas.length === 0 ? (
          <Text style={styles.vazio}>{d.vazio}</Text>
        ) : (
          d.linhas.map((l) => (
            <View key={l.id} style={styles.linha}>
              <Text style={styles.linhaCabecalho}>{l.cabecalho}</Text>
              <Text style={styles.linhaCorpo}>{l.texto}</Text>
            </View>
          ))
        )}
        <Text
          style={styles.footer}
          fixed
          render={({ pageNumber, totalPages }) =>
            `${d.rodape} · ${d.rotuloDePagina
              .replace("{atual}", String(pageNumber))
              .replace("{total}", String(totalPages))}`
          }
        />
      </Page>
    </Document>
  );
}

/**
 * Monta o PDF da conversa. `ok: false` traz o motivo JÁ traduzido.
 *
 * `db` é o client de quem pediu (sessão): a leitura da organização passa pela
 * RLS como todo o resto. A marca vem de `marcaDaSaida`, que nunca lança.
 */
export async function montarPdfDaConversa(
  db: SupabaseClient,
  orgId: string,
  conversa: ConversaParaPdf,
  mensagens: MensagemParaPdf[],
  opcoes: OpcoesDoPdfDaConversa,
): Promise<PdfDaConversa> {
  const t = opcoes.t;
  const [marca, { data: orgLida }] = await Promise.all([
    marcaDaSaida(orgId),
    db.from("organizations").select("legal_name, display_name, timezone").eq("id", orgId).maybeSingle(),
  ]);
  const org = (orgLida ?? {}) as { legal_name?: string | null; display_name?: string | null; timezone?: string | null };
  const fuso = opcoes.fuso ?? org.timezone ?? FUSO_PADRAO;
  const idioma = opcoes.idioma ?? IDIOMA_PADRAO;
  const linhas = linhasDoHistorico(conversa, mensagens, { t, nomesDosUsuarios: opcoes.nomesDosUsuarios, fuso, idioma });
  const geradoEm = Date.parse(opcoes.geradoEm ?? "") || Date.now();
  const clinica = org.display_name?.trim() || marca.nome;
  const telefone = phoneForDisplay(conversa.contato?.phone_number);
  const primeira = linhas[0];
  const ultima = linhas[linhas.length - 1];

  const dados: DadosDoPdf = {
    marca: soOQueAFonteDesenha(clinica),
    accent: marca.accent,
    titulo: t("Histórico da conversa"),
    subtitulo: soOQueAFonteDesenha(
      [
        rotuloDoContato(conversa.contato, t),
        telefone,
        ROTULO_DO_CANAL[conversa.channel ?? ""] ?? conversa.channel ?? "",
      ]
        .filter(Boolean)
        .join(" · "),
    ),
    metadados: [
      `${t("Período")}: ${
        primeira && ultima
          ? t("{inicio} a {fim}").replace("{inicio}", primeira.horario).replace("{fim}", ultima.horario)
          : "-"
      }`,
      `${t("Mensagens")}: ${linhas.length}`,
      `${t("Exportado por")}: ${t("{quem} em {quando}")
        .replace("{quem}", soOQueAFonteDesenha(opcoes.exportadoPor?.trim() || t("Equipe")))
        .replace("{quando}", dataHora(geradoEm, fuso, idioma))}`,
      `${t("Horários no fuso")}: ${fuso}`,
      `${t("Conversa")}: ${conversa.id}`,
    ],
    aviso: t(
      "Este documento contém dados pessoais e pode conter dados de saúde. Guarde e compartilhe só com quem precisa, conforme a LGPD. Emojis e símbolos fora do alfabeto não aparecem; imagens, áudios e arquivos são citados pelo tipo e pelo nome, sem o conteúdo.",
    ),
    alertaDeCorte: opcoes.truncada
      ? t("Atenção: esta conversa passa do limite de {n} mensagens por arquivo. Só as mais recentes estão neste documento.").replace(
          "{n}",
          String(LIMITE_DE_MENSAGENS),
        )
      : null,
    tituloDasMensagens: t("Mensagens"),
    vazio: t("Nenhuma mensagem nesta conversa."),
    linhas: linhas.map((l) => ({
      id: l.id,
      cabecalho: soOQueAFonteDesenha(
        [l.autor, l.horario, l.direcao === "inbound" ? t("recebida") : t("enviada"), l.ressalva]
          .filter(Boolean)
          .join(" · "),
      ),
      texto: l.texto,
    })),
    rotuloDePagina: t("página {atual} de {total}"),
    rodape: soOQueAFonteDesenha(org.legal_name?.trim() || clinica),
  };

  let buffer: Buffer;
  try {
    buffer = (await renderToBuffer(<Documento d={dados} />)) as Buffer;
  } catch (erro) {
    // Ids e a causa, nunca o corpo da mensagem.
    logger.warn("[exporta-pdf] falha ao renderizar", {
      organizationId: orgId,
      conversationId: conversa.id,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
    return { ok: false, motivo: t("Não foi possível gerar o PDF desta conversa.") };
  }

  return { ok: true, buffer, nomeDoArquivo: nomeDeArquivo(conversa, geradoEm, fuso, idioma), linhas: linhas.length };
}
