import type { CSSProperties } from "react";
import { z } from "zod";

/**
 * APARÊNCIA DA CONVERSA — fundo e cor dos balões, escolhidos POR PESSOA.
 *
 * Mora em `user_metadata.aparencia_conversa` (Supabase Auth), o mesmo lugar do
 * idioma (`locale`) e do fuso (`timezone`): é preferência de quem lê, vale em
 * qualquer computador em que a pessoa entrar, e não muda o que os colegas veem.
 * `localStorage` não serviria — quem atende troca de máquina ao longo do dia.
 *
 * ⚠️ `user_metadata` é GRAVÁVEL pelo próprio usuário (`updateUser({data})` direto
 * do browser), então o que vem de lá é dado não confiável: `lerAparencia` aceita
 * só os identificadores desta lista e cai no padrão campo a campo. Nenhum valor
 * cru do metadado chega ao CSS — o estilo sai sempre das tabelas abaixo.
 *
 * O padrão (`liso` + `marca` + `branco`) é exatamente o desenho de antes: quem
 * nunca abrir o controle não vê nada mudar.
 */

/** Um par de cores por tema. `var(--token)` acompanha a marca e o tema sozinho. */
type Par = { fundo: string; texto: string };
type CoresPorTema = { claro: Par; escuro: Par };

export const FUNDOS = {
  liso: {
    rotulo: "Liso",
    cor: "var(--color-bg)",
    imagem: "none",
  },
  pontilhado: {
    rotulo: "Pontilhado",
    cor: "var(--color-bg)",
    imagem:
      "radial-gradient(color-mix(in srgb, var(--color-text) 14%, transparent) 1px, transparent 1.6px)",
  },
  tom: {
    rotulo: "Tom suave",
    cor: "color-mix(in srgb, var(--color-accent) 9%, var(--color-bg))",
    imagem: "none",
  },
} as const;

/** Balões de quem ATENDE (equipe). O do automático não muda: é outra voz. */
export const ENVIADAS = {
  marca: {
    rotulo: "Cor da marca",
    claro: { fundo: "var(--primary)", texto: "var(--primary-foreground)" },
    escuro: { fundo: "var(--primary)", texto: "var(--primary-foreground)" },
  },
  verde: {
    rotulo: "Verde claro",
    claro: { fundo: "#d9fdd3", texto: "#111b21" },
    escuro: { fundo: "#144d37", texto: "#e9edef" },
  },
  azul: {
    rotulo: "Azul",
    claro: { fundo: "#dbeafe", texto: "#172554" },
    escuro: { fundo: "#1e3a5f", texto: "#e6eef8" },
  },
  grafite: {
    rotulo: "Grafite",
    claro: { fundo: "#2f3437", texto: "#f5f5f4" },
    escuro: { fundo: "#3a4043", texto: "#f4f4f2" },
  },
} as const satisfies Record<string, { rotulo: string } & CoresPorTema>;

/** Balões do CLIENTE. */
export const RECEBIDAS = {
  branco: {
    rotulo: "Branco",
    claro: { fundo: "var(--color-surface)", texto: "var(--color-text)" },
    escuro: { fundo: "var(--color-surface)", texto: "var(--color-text)" },
  },
  cinza: {
    rotulo: "Cinza",
    claro: { fundo: "#ecebe7", texto: "#1c1917" },
    escuro: { fundo: "#26302c", texto: "#f1ede0" },
  },
  creme: {
    rotulo: "Creme",
    claro: { fundo: "#fbf3dc", texto: "#2b2414" },
    escuro: { fundo: "#3a3324", texto: "#f6eedb" },
  },
} as const satisfies Record<string, { rotulo: string } & CoresPorTema>;

export type Fundo = keyof typeof FUNDOS;
export type Enviada = keyof typeof ENVIADAS;
export type Recebida = keyof typeof RECEBIDAS;

export type AparenciaDaConversa = { fundo: Fundo; enviada: Enviada; recebida: Recebida };

export const APARENCIA_PADRAO: AparenciaDaConversa = {
  fundo: "liso",
  enviada: "marca",
  recebida: "branco",
};

const chaves = <T extends object>(o: T) => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

/** O contrato da gravação: os três campos, só com identificadores conhecidos. */
export const aparenciaSchema = z
  .object({
    fundo: z.enum(chaves(FUNDOS)),
    enviada: z.enum(chaves(ENVIADAS)),
    recebida: z.enum(chaves(RECEBIDAS)),
  })
  .strict();

/** Lê o que veio do metadado — campo a campo, para um valor ruim não apagar os bons. */
export function lerAparencia(bruto: unknown): AparenciaDaConversa {
  const o = bruto && typeof bruto === "object" ? (bruto as Record<string, unknown>) : {};
  const um = <T extends string>(valor: unknown, validos: object, padrao: T): T =>
    typeof valor === "string" && Object.hasOwn(validos, valor) ? (valor as T) : padrao;
  return {
    fundo: um(o.fundo, FUNDOS, APARENCIA_PADRAO.fundo),
    enviada: um(o.enviada, ENVIADAS, APARENCIA_PADRAO.enviada),
    recebida: um(o.recebida, RECEBIDAS, APARENCIA_PADRAO.recebida),
  };
}

/**
 * As variáveis CSS que o fio da conversa e os balões leem.
 *
 * Cada cor vem em DUAS versões (`-claro`/`-escuro`); quem escolhe a do tema é o
 * `globals.css` (bloco `[data-aparencia-conversa]`). Decidir aqui, em JS, pelo
 * tema resolvido pintaria a primeira tela no tema errado até a hidratação.
 */
export function estiloDaAparencia(a: AparenciaDaConversa): CSSProperties {
  const fundo = FUNDOS[a.fundo];
  const env = ENVIADAS[a.enviada];
  const rec = RECEBIDAS[a.recebida];
  return {
    "--conversa-fundo-cor": fundo.cor,
    "--conversa-fundo-imagem": fundo.imagem,
    "--bolha-enviada-fundo-claro": env.claro.fundo,
    "--bolha-enviada-texto-claro": env.claro.texto,
    "--bolha-enviada-fundo-escuro": env.escuro.fundo,
    "--bolha-enviada-texto-escuro": env.escuro.texto,
    "--bolha-recebida-fundo-claro": rec.claro.fundo,
    "--bolha-recebida-texto-claro": rec.claro.texto,
    "--bolha-recebida-fundo-escuro": rec.escuro.fundo,
    "--bolha-recebida-texto-escuro": rec.escuro.texto,
  } as CSSProperties;
}
