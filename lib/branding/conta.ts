import { createHash } from "node:crypto";

import { z } from "zod";

import { razaoDeContraste } from "@/lib/branding/contraste";
import { farejarTipo } from "@/lib/branding/logo-arquivo";
import { ehUrl } from "@/lib/evalink/config";

/**
 * Leitor da marca da Conta Eva Link (Plano 6). Só servidor.
 *
 * Contrato: `GET {CONTA_URL}/api/marca` (com ETag/304) e `GET {CONTA_URL}/marca/logo/{escuro|claro}`.
 * Uma rodada tem um prazo ÚNICO (3 s) que cobre cabeçalhos, corpo e logos. NUNCA LANÇA:
 * todo erro vira `{ tipo: "falha" }`. Não escreve log — devolve motivos; quem guarda e
 * avisa (uma vez a cada 10 min) é o chamador, que também mantém a última marca boa.
 */

export type MarcaDaConta = {
  nomeClinica: string | null; // trim, até 80, vazio → null
  corPrincipal: string; // hex minúsculo #rrggbb
  logos: { escuro: string | null; claro: string | null }; // sha256 anunciado
  atualizadoEm: string | null;
};

export type LogoBaixada = { sha: string; tipo: "png" | "jpeg"; bytes: Uint8Array };

/**
 * Por tipo de logo:
 *  - `LogoBaixada`: bytes novos, sha conferido — grave e guarde ESTE sha.
 *  - `"mesma"`: o sha anunciado é o que `anterior.logos` já tem — não baixou; mantenha o caminho guardado.
 *  - `null`: sem logo na Conta, OU logo recusada (motivo em `avisos`) — mantenha a anterior e
 *    NÃO troque o sha guardado, para a próxima rodada tentar de novo.
 */
export type LogoDaRodada = LogoBaixada | "mesma" | null;

export type RodadaDaConta =
  | {
      tipo: "nova";
      marca: MarcaDaConta;
      etag: string | null;
      logos: { escuro: LogoDaRodada; claro: LogoDaRodada };
      avisos: string[];
    }
  | { tipo: "igual"; etag: string | null } // 304
  | { tipo: "padrao" } // atualizado_em null (regras 2.6: quem decide é o chamador)
  | { tipo: "falha"; motivo: string };

export type AnteriorDaConta = {
  etag: string | null;
  logos: { escuro: string | null; claro: string | null };
} | null;

const PRAZO_MS = 3000;
export const TAMANHO_MAXIMO_DA_LOGO_DA_CONTA = 1024 * 1024;
const CREME = "#f5efd9";
const BRANCO = "#ffffff";
const PISO = 4.5;

const HEX = z.string().regex(/^#[0-9a-f]{6}$/i);
const SHA = z
  .string()
  .regex(/^[0-9a-f]{64}$/i)
  .transform((s) => s.toLowerCase())
  .nullable();

const CorpoDaMarca = z.object({
  versao: z.literal(1),
  nome_clinica: z.string().nullable(),
  paleta: z.union([z.object({ id: z.string() }), z.object({ principal: HEX, destaque: HEX.optional() })]),
  cores: z.object({ principal: HEX, funda: HEX, destaque: HEX }),
  logos: z.object({ escuro: SHA, claro: SHA }),
  atualizado_em: z.string().nullable(),
});

/** `CONTA_URL` válida (http/https), sem barra final; senão `null` (marca da Conta desligada). */
export function contaUrlDaMarca(env: Record<string, string | undefined> = process.env): string | null {
  const url = env.CONTA_URL?.trim();
  if (!url || !ehUrl(url)) return null;
  return url.replace(/\/+$/, "");
}

/** Os 3 pares do guia (4,5:1). Vazio = passa. */
export function paresDoGuiaQueFalham(c: { principal: string; funda: string; destaque: string }): string[] {
  const pares: [string, string, string][] = [
    ["branco sobre principal", BRANCO, c.principal],
    ["creme sobre funda", CREME, c.funda],
    ["destaque sobre funda", c.destaque, c.funda],
  ];
  return pares.filter(([, a, b]) => razaoDeContraste(a, b) < PISO).map(([nome]) => nome);
}

class Recusa extends Error {}

/** Lê o corpo até `limite` bytes; passou disso, recusa sem ler o resto. */
async function lerAte(res: Response, limite: number): Promise<Uint8Array> {
  if (Number(res.headers.get("content-length") ?? 0) > limite) throw new Recusa("maior que 1 MiB");
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const leitor = res.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > limite) {
      await leitor.cancel();
      throw new Recusa("maior que 1 MiB");
    }
    partes.push(value);
  }
  const tudo = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) {
    tudo.set(p, pos);
    pos += p.byteLength;
  }
  return tudo;
}

async function baixarLogo(
  f: typeof fetch,
  url: string,
  shaAnunciado: string,
  signal: AbortSignal,
): Promise<LogoBaixada> {
  const res = await f(url, { signal, cache: "no-store" });
  // 404 de uma logo anunciada também é recusa: a anterior fica.
  if (!res.ok) throw new Recusa(`HTTP ${res.status}`);
  const bytes = await lerAte(res, TAMANHO_MAXIMO_DA_LOGO_DA_CONTA);
  const tipo = farejarTipo(bytes); // só PNG e JPEG, como o bucket; WebP e SVG caem aqui
  if (!tipo) throw new Recusa("não é PNG nem JPEG");
  if (createHash("sha256").update(bytes).digest("hex") !== shaAnunciado) throw new Recusa("sha256 não confere");
  return { sha: shaAnunciado, tipo: tipo === "image/png" ? "png" : "jpeg", bytes };
}

async function rodada(
  contaUrl: string,
  anterior: AnteriorDaConta,
  f: typeof fetch,
  signal: AbortSignal,
): Promise<RodadaDaConta> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (anterior?.etag) headers["if-none-match"] = anterior.etag;
  const res = await f(`${contaUrl}/api/marca`, { headers, signal, cache: "no-store" });
  const etag = res.headers.get("etag") ?? null;
  if (res.status === 304) return { tipo: "igual", etag: etag ?? anterior?.etag ?? null };
  if (!res.ok) return { tipo: "falha", motivo: `api/marca respondeu HTTP ${res.status}` };

  let bruto: unknown;
  try {
    bruto = await res.json();
  } catch {
    return { tipo: "falha", motivo: "api/marca devolveu JSON inválido" };
  }
  const lido = CorpoDaMarca.safeParse(bruto);
  if (!lido.success) return { tipo: "falha", motivo: "api/marca fora do contrato (versao 1)" };
  const c = lido.data;
  if (c.atualizado_em === null) return { tipo: "padrao" };

  const reprovados = paresDoGuiaQueFalham(c.cores);
  if (reprovados.length > 0) return { tipo: "falha", motivo: `contraste reprovado: ${reprovados.join(", ")}` };

  const nome = c.nome_clinica?.trim().slice(0, 80) || null;
  const marca: MarcaDaConta = {
    nomeClinica: nome,
    corPrincipal: c.cores.principal.toLowerCase(),
    logos: c.logos,
    atualizadoEm: c.atualizado_em,
  };

  // Logo null usa a do outro tipo; o mesmo sha é baixado uma vez só.
  const avisos: string[] = [];
  const downloads = new Map<string, Promise<LogoBaixada | null>>();
  const resolver = async (lado: "escuro" | "claro"): Promise<LogoDaRodada> => {
    const outro = lado === "escuro" ? "claro" : "escuro";
    const origem = c.logos[lado] ? lado : outro;
    const s = c.logos[origem];
    if (!s) return null;
    if (anterior?.logos[lado] === s) return "mesma";
    let p = downloads.get(s);
    if (!p) {
      p = baixarLogo(f, `${contaUrl}/marca/logo/${origem}`, s, signal).catch((e: unknown) => {
        if (!(e instanceof Recusa)) throw e; // rede/prazo derruba a rodada inteira
        avisos.push(`logo ${origem} recusada: ${e.message}`);
        return null;
      });
      downloads.set(s, p);
    }
    return p;
  };
  const [escuro, claro] = await Promise.all([resolver("escuro"), resolver("claro")]);
  return { tipo: "nova", marca, etag, logos: { escuro, claro }, avisos };
}

export async function lerMarcaDaConta(
  contaUrl: string,
  anterior: AnteriorDaConta,
  dep: { fetch?: typeof fetch; prazoMs?: number } = {},
): Promise<RodadaDaConta> {
  const prazoMs = dep.prazoMs ?? PRAZO_MS;
  const ctrl = new AbortController();
  let relogio: ReturnType<typeof setTimeout> | undefined;
  // O race existe porque um fetch (ou corpo) pode ignorar o sinal: o prazo vence mesmo assim.
  const prazo = new Promise<RodadaDaConta>((resolve) => {
    relogio = setTimeout(() => {
      ctrl.abort();
      resolve({ tipo: "falha", motivo: `Conta não respondeu em ${prazoMs} ms` });
    }, prazoMs);
  });
  const trabalho = rodada(contaUrl, anterior, dep.fetch ?? fetch, ctrl.signal).catch(
    (e: unknown): RodadaDaConta => ({
      tipo: "falha",
      motivo: `Conta inalcançável: ${e instanceof Error ? e.message : String(e)}`,
    }),
  );
  try {
    return await Promise.race([trabalho, prazo]);
  } finally {
    clearTimeout(relogio);
  }
}
