/**
 * O ARMAZÉM da marca da Conta (Plano 6): lê e grava as colunas `conta_*` de
 * `platform_branding` (migration 0409) e a logo no bucket. Só servidor.
 *
 * O leitor (`conta.ts`) fala com a rede e devolve uma rodada; este módulo decide
 * o que a rodada faz com a última marca boa guardada. O render NUNCA espera a
 * Conta: `marcaDaInstalacao()` dispara a rodada sem `await` e segue com o que já
 * está no banco. NUNCA LANÇA — falha vira log, no máximo uma vez a cada 10 min
 * por motivo.
 *
 * Decisões declaradas:
 *  - Uma coluna de logo só (`conta_logo_path`), e é a CLARA (para fundo claro):
 *    é a que o ícone da aba e o e-mail (tema claro sempre) pedem, e o CRM tem um
 *    logo por camada. A clara ausente já chega como a escura (regra 2.6, no
 *    leitor). O sha da escura fica em `conta_logos.escuro` só para não baixá-la
 *    de novo a cada mudança.
 *  - `igual` (304) não grava nada: `conta_lida_em` marca a última rodada ACEITA.
 *  - Rodada que daria o mesmo estado não grava (logo recusada é relida a cada
 *    60 s, porque o leitor tira o ETag; sem esta guarda seria uma escrita por
 *    minuto).
 *  - Sem linha `id=1`, insere com `seeded_from_env = true`: assim a semeadura do
 *    `.env` ainda completa a linha depois (`precisaSemear`).
 */

import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { contaUrlDaMarca, lerMarcaDaConta, type LogoBaixada, type RodadaDaConta } from "./conta";
import { BUCKET_DE_LOGOS } from "./logo";
import { contaEmVigor } from "./resolve";

export type ContaGuardada = {
  readonly conta_nome: string | null;
  readonly conta_accent_hex: string | null;
  readonly conta_logo_path: string | null;
  readonly conta_logos: unknown;
  readonly conta_etag: string | null;
  readonly conta_atualizado_em: string | null;
};

type Logos = { escuro: string | null; claro: string | null };

const COLUNAS_DA_CONTA =
  "conta_nome, conta_accent_hex, conta_logo_path, conta_logos, conta_etag, conta_atualizado_em";
const INTERVALO_MS = 60_000;
/** Teto da rodada inteira (banco + Conta + bucket): só a Conta tem prazo próprio. */
export const PRAZO_DA_RODADA_MS = 20_000;
const SILENCIO_DO_LOG_MS = 10 * 60_000;
const PREFIXO = "platform/";

declare global {
  // Mesmo motivo do memo de `instalacao.ts`: o módulo é instanciado duas vezes no
  // mesmo processo (runtime das rotas e das páginas), e só `globalThis` é comum.
  // `geracao`: a vez de cada rodada. Só a mais nova grava (ver `rodarMarcaDaConta`).
  var __rodadaDaConta: { ultima: number; emVoo: boolean; geracao: number } | undefined;
  var __avisosDaConta: Map<string, number> | undefined;
}

/** Log no máximo uma vez a cada 10 min por chave (spec 2.4). */
function avisar(chave: string, mensagem: string, contexto: Record<string, unknown>): void {
  const mapa = (globalThis.__avisosDaConta ??= new Map());
  const ultimo = mapa.get(chave);
  if (ultimo !== undefined && Date.now() - ultimo < SILENCIO_DO_LOG_MS) return;
  mapa.set(chave, Date.now());
  logger.warn(mensagem, contexto);
}

/** A URL da Conta, ou `null` (marca da Conta desligada). */
export function contaUrlLigada(): string | null {
  return contaUrlDaMarca({ CONTA_URL: env.CONTA_URL });
}

/**
 * A `CONTA_URL` quando a marca da Conta está EM VIGOR (ligada E guardada —
 * `contaEmVigor`), senão `null`. É o que as escritas de marca consultam antes de
 * recusar com `marca_na_conta`. Lê do banco, não do memo: escrita é rara, e
 * decidir pelo memo de 30 s deixaria passar a primeira escrita depois da Conta.
 */
export async function contaUrlEmVigor(): Promise<string | null> {
  const url = contaUrlLigada();
  if (!url) return null;
  const g = await lerContaGuardada();
  return g !== "erro" && contaEmVigor(g) ? url : null;
}

/**
 * As colunas `conta_*`, numa consulta SEPARADA do `COLUNAS` de `instalacao.ts`
 * (que é tudo-ou-nada): um clone que ainda não aplicou a 0409 responde `42703`
 * aqui, e só a camada da Conta fica vazia — a marca local continua.
 *
 * `null` = sem linha. `"erro"` = não deu para ler (inclusive `42703`).
 */
export async function lerContaGuardada(): Promise<ContaGuardada | null | "erro"> {
  try {
    const { data, error } = await createAdminClient()
      .from("platform_branding")
      .select(COLUNAS_DA_CONTA)
      .eq("id", 1)
      // Fura a deduplicação de `fetch` do Next — mesmo motivo de `lerLinha`.
      .abortSignal(new AbortController().signal)
      .maybeSingle();
    if (error) {
      avisar(`leitura|${error.code ?? "?"}`, "marca da Conta: colunas conta_* ilegíveis; vale a marca local", {
        codigo: error.code,
        detalhe: error.message,
      });
      return "erro";
    }
    return (data as ContaGuardada | null) ?? null;
  } catch (e) {
    avisar("leitura|excecao", "marca da Conta: leitura das colunas falhou; vale a marca local", {
      detalhe: e instanceof Error ? e.message : String(e),
    });
    return "erro";
  }
}

function logosGuardados(g: ContaGuardada | null): Logos {
  const l = g?.conta_logos;
  if (typeof l !== "object" || l === null) return { escuro: null, claro: null };
  const o = l as Record<string, unknown>;
  const sha = (v: unknown) => (typeof v === "string" ? v : null);
  return { escuro: sha(o.escuro), claro: sha(o.claro) };
}

function caminhoDaLogo(logo: LogoBaixada): string {
  // O CHECK da 0409 aceita `.png|.jpg`; o leitor diz "jpeg".
  return `${PREFIXO}conta-${logo.sha}.${logo.tipo === "png" ? "png" : "jpg"}`;
}

async function enviarLogo(logo: LogoBaixada): Promise<string | null> {
  const caminho = caminhoDaLogo(logo);
  try {
    const { error } = await createAdminClient()
      .storage.from(BUCKET_DE_LOGOS)
      // Endereçado pelo sha: reenviar é escrever os mesmos bytes, por isso `upsert`.
      .upload(caminho, logo.bytes, {
        contentType: logo.tipo === "png" ? "image/png" : "image/jpeg",
        upsert: true,
      });
    if (error) {
      // Ex.: maior que o `file_size_limit` do bucket (512 KB) — a Conta aceita 1 MiB.
      avisar("logo|envio", "marca da Conta: logo não coube no bucket; a anterior fica", { detalhe: error.message });
      return null;
    }
    return caminho;
  } catch (e) {
    avisar("logo|envio", "marca da Conta: envio da logo falhou; a anterior fica", {
      detalhe: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Apaga logos da Conta que ninguém mais aponta. Fica a atual E a anterior: um
 * render com o memo de 30 s (ou uma aba aberta) ainda pode pedir a anterior, então
 * ela sai na troca SEGUINTE, nunca na mesma rodada. Só o prefixo `platform/conta-`.
 */
async function limparLogosVelhas(manter: readonly (string | null)[]): Promise<void> {
  try {
    const bucket = createAdminClient().storage.from(BUCKET_DE_LOGOS);
    const { data, error } = await bucket.list("platform", { search: "conta-", limit: 100 });
    if (error || !data) return;
    // Relê o caminho guardado AGORA: outro processo pode ter gravado uma logo
    // nova entre a nossa gravação e esta limpeza, e ela nunca pode sair.
    const atual = await lerContaGuardada();
    if (atual === "erro") return;
    const fica = [...manter, atual?.conta_logo_path ?? null];
    const velhas = data
      .map((o) => `${PREFIXO}${o.name}`)
      .filter((c) => /^platform\/conta-[0-9a-f]{64}\.(png|jpg)$/.test(c) && !fica.includes(c));
    if (velhas.length > 0) await bucket.remove(velhas);
  } catch {
    // Arquivo órfão não é falha de marca; a próxima troca tenta de novo.
  }
}

type Estado = {
  conta_nome: string | null;
  conta_accent_hex: string | null;
  conta_logo_path: string | null;
  conta_logos: Logos | null;
  conta_etag: string | null;
  conta_atualizado_em: string | null;
};

const VAZIO: Estado = {
  conta_nome: null,
  conta_accent_hex: null,
  conta_logo_path: null,
  conta_logos: null,
  conta_etag: null,
  conta_atualizado_em: null,
};

function mesmoEstado(a: Estado, g: ContaGuardada | null): boolean {
  const b = logosGuardados(g);
  const la = a.conta_logos ?? { escuro: null, claro: null };
  return (
    a.conta_nome === (g?.conta_nome ?? null) &&
    a.conta_accent_hex === (g?.conta_accent_hex ?? null) &&
    a.conta_logo_path === (g?.conta_logo_path ?? null) &&
    la.escuro === b.escuro &&
    la.claro === b.claro &&
    a.conta_etag === (g?.conta_etag ?? null) &&
    a.conta_atualizado_em === (g?.conta_atualizado_em ?? null)
  );
}

async function gravar(estado: Estado, lida: boolean): Promise<boolean> {
  const valores = { ...estado, conta_lida_em: lida ? new Date().toISOString() : null };
  try {
    const cliente = createAdminClient();
    const { data, error } = await cliente.from("platform_branding").update(valores).eq("id", 1).select("id");
    if (error) {
      avisar(`gravacao|${error.code ?? "?"}`, "marca da Conta: não deu para gravar; vale a marca guardada", {
        codigo: error.code,
        detalhe: error.message,
      });
      return false;
    }
    if (Array.isArray(data) && data.length > 0) return true;
    const ins = await cliente.from("platform_branding").insert({ id: 1, seeded_from_env: true, ...valores });
    // 23505: outro processo criou a linha no meio; a próxima rodada grava.
    if (ins.error && ins.error.code !== "23505") {
      avisar(`gravacao|${ins.error.code ?? "?"}`, "marca da Conta: não deu para criar a linha", {
        codigo: ins.error.code,
        detalhe: ins.error.message,
      });
    }
    return !ins.error;
  } catch (e) {
    avisar("gravacao|excecao", "marca da Conta: gravação falhou", {
      detalhe: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/** O que uma rodada `nova` deixa guardado. Recusa de logo mantém a anterior. */
async function estadoDaNova(
  r: Extract<RodadaDaConta, { tipo: "nova" }>,
  g: ContaGuardada | null,
): Promise<Estado> {
  const logos = logosGuardados(g);
  let caminho = g?.conta_logo_path ?? null;
  let etag = r.etag;
  if (!r.marca.logos.escuro && !r.marca.logos.claro) {
    // A clínica não tem logo na Conta.
    caminho = null;
    logos.escuro = null;
    logos.claro = null;
  } else {
    const escuro = r.logos.escuro;
    if (escuro && escuro !== "mesma") logos.escuro = escuro.sha;
    const claro = r.logos.claro;
    if (claro && claro !== "mesma") {
      const enviado = await enviarLogo(claro);
      if (enviado) {
        caminho = enviado;
        logos.claro = claro.sha;
      } else {
        etag = null; // a próxima rodada tenta a logo de novo
      }
    }
    // `null` com sha anunciado = recusada (motivo nos avisos): caminho e sha ficam.
  }
  return {
    conta_nome: r.marca.nomeClinica,
    conta_accent_hex: r.marca.corPrincipal,
    conta_logo_path: caminho,
    conta_logos: logos,
    conta_etag: etag,
    conta_atualizado_em: r.marca.atualizadoEm,
  };
}

export type ResultadoDaRodada = "sem-leitura" | "falha" | "igual" | "nada" | "gravou";

/** Uma rodada inteira: lê o guardado, pergunta à Conta, grava a última marca boa. */
export async function rodarMarcaDaConta(
  contaUrl: string,
  aoGravar: () => void,
  dep: { fetch?: typeof fetch; prazoMs?: number; vigente?: () => boolean } = {},
): Promise<ResultadoDaRodada> {
  // Uma rodada travada além do teto pode voltar DEPOIS de outra mais nova ter
  // gravado; sem esta guarda o `gravar` (update incondicional) devolveria a marca
  // velha. Conferida logo antes de gravar e de limpar o bucket.
  const vigente = dep.vigente ?? (() => true);
  try {
    const g = await lerContaGuardada();
    if (g === "erro") return "sem-leitura";
    const anterior = g ? { etag: g.conta_etag, logos: logosGuardados(g) } : null;
    const r = await lerMarcaDaConta(contaUrl, anterior, dep);

    if (r.tipo === "falha") {
      avisar("falha", "marca da Conta: leitura falhou; vale a última marca boa", { motivo: r.motivo });
      return "falha";
    }
    if (r.tipo === "igual") return "igual";

    let estado: Estado;
    if (r.tipo === "padrao") {
      // Regra 2.6: o padrão da Conta só troca uma marca que veio dela.
      if (!g?.conta_atualizado_em) return "nada";
      estado = VAZIO;
    } else {
      for (const aviso of r.avisos) avisar(`aviso|${aviso}`, "marca da Conta: logo recusada; a anterior fica", { aviso });
      estado = await estadoDaNova(r, g);
    }
    if (mesmoEstado(estado, g) || !vigente()) return "nada";
    if (!(await gravar(estado, r.tipo === "nova"))) return "falha";
    aoGravar();
    if (vigente() && estado.conta_logo_path !== (g?.conta_logo_path ?? null)) {
      void limparLogosVelhas([estado.conta_logo_path, g?.conta_logo_path ?? null]);
    }
    return "gravou";
  } catch (e) {
    avisar("rodada|excecao", "marca da Conta: rodada falhou", { detalhe: e instanceof Error ? e.message : String(e) });
    return "falha";
  }
}

/**
 * Dispara uma rodada sem esperar. No máximo uma a cada 60 s por processo e nunca
 * duas em voo. Sem `CONTA_URL` válida não faz nada (nenhum `fetch`).
 */
export function dispararMarcaDaConta(aoGravar: () => void): void {
  try {
    const url = contaUrlLigada();
    if (!url) return;
    const estado = (globalThis.__rodadaDaConta ??= { ultima: 0, emVoo: false, geracao: 0 });
    if (estado.emVoo || Date.now() - estado.ultima < INTERVALO_MS) return;
    estado.emVoo = true;
    estado.ultima = Date.now();
    const minha = (estado.geracao = (estado.geracao ?? 0) + 1);
    // Um banco travado não pode prender `emVoo` para sempre: passado o teto, a
    // vez é liberada; a travada, se voltar depois de outra começar, não grava.
    let relogio: ReturnType<typeof setTimeout> | undefined;
    const teto = new Promise<void>((resolve) => {
      relogio = setTimeout(resolve, PRAZO_DA_RODADA_MS);
    });
    void Promise.race([rodarMarcaDaConta(url, aoGravar, { vigente: () => estado.geracao === minha }), teto]).finally(() => {
      clearTimeout(relogio);
      estado.emVoo = false;
    });
  } catch {
    // Nunca lança no render.
  }
}
