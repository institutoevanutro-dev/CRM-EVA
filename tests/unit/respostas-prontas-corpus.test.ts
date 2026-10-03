import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MODELO_DE_EMBEDDING } from "@/lib/ai/embeddings/chave";
import { LIMITE_PADRAO, decidirRespostaPronta, motivoParaPular } from "@/lib/respostas-prontas/casamento";

import {
  CADASTRO,
  DEVEM_CASAR,
  FORA_DA_AMOSTRA,
  NAO_DEVEM_CASAR,
  hashDoCadastro,
} from "../fixtures/respostas-prontas/corpus";

/**
 * O CORPUS CONTRA O MODELO REAL — sem rede. As similaridades vêm de
 * `tests/fixtures/respostas-prontas/similaridades.json`, gravado pelo script
 * `scripts/respostas-prontas-gravar-similaridades.ts` com o
 * `text-embedding-3-small` de verdade. Falso positivo (frase de NAO_DEVEM_CASAR
 * caindo em qualquer item) reprova — é o critério de sucesso da spec.
 */
interface Gravado {
  modelo: string;
  cadastro_hash: string;
  similaridades: Record<string, Record<string, number>>;
}

const ARQUIVO = join(process.cwd(), "tests/fixtures/respostas-prontas/similaridades.json");

function lerGravado(): Gravado {
  if (!existsSync(ARQUIVO)) {
    throw new Error(
      "similaridades.json ausente — rode `OPENAI_API_KEY=... pnpm exec tsx scripts/respostas-prontas-gravar-similaridades.ts`",
    );
  }
  return JSON.parse(readFileSync(ARQUIVO, "utf8")) as Gravado;
}

const gravado = lerGravado();

/**
 * O que o motor faria com esta mensagem, no limite padrão: as mesmas guardas de
 * `tentarRespostaPronta` (`motivoParaPular`), e só então as travas 1 e 2 sobre
 * as similaridades gravadas.
 */
function decidir(mensagem: string) {
  const pular = motivoParaPular([mensagem]);
  if (pular !== null) return { casou: false as const, motivo: pular };
  const porItem = gravado.similaridades[mensagem];
  if (porItem === undefined) throw new Error(`"${mensagem}" não está gravada — regrave o arquivo`);
  return decidirRespostaPronta(new Map(Object.entries(porItem)), LIMITE_PADRAO);
}

const sims = (mensagem: string) => JSON.stringify(gravado.similaridades[mensagem] ?? {});

describe("corpus odontológico — modelo real, sem rede", () => {
  it("o arquivo gravado é do modelo e do cadastro atuais", () => {
    expect(gravado.modelo).toBe(MODELO_DE_EMBEDDING);
    expect(gravado.cadastro_hash, "o CADASTRO mudou — regrave o arquivo").toBe(hashDoCadastro());
  });

  it("toda frase gravada tem similaridade com todos os itens do cadastro", () => {
    const itens = CADASTRO.map((i) => i.id).sort();
    const todas = [...NAO_DEVEM_CASAR, ...DEVEM_CASAR.map((d) => d.mensagem), ...FORA_DA_AMOSTRA.map((d) => d.mensagem)];
    for (const frase of todas) {
      expect(Object.keys(gravado.similaridades[frase] ?? {}).sort(), frase).toEqual(itens);
    }
  });

  for (const frase of NAO_DEVEM_CASAR) {
    it(`NÃO responde pronto: "${frase.slice(0, 60)}"`, () => {
      expect(decidir(frase).casou, sims(frase)).toBe(false);
    });
  }

  for (const { mensagem, item } of DEVEM_CASAR) {
    it(`responde com "${item}": "${mensagem}"`, () => {
      expect(decidir(mensagem), sims(mensagem)).toMatchObject({
        casou: true,
        respostaProntaId: item,
      });
    });
  }
});

/**
 * Fora da amostra: paráfrases que não ajudaram a escolher o CADASTRO. Precisão
 * é inegociável (nunca o item errado); o recall é medido e impresso.
 */
describe("corpus odontológico — fora da amostra", () => {
  for (const { mensagem, item } of FORA_DA_AMOSTRA) {
    it(`nunca responde com item errado: "${mensagem}"`, () => {
      const d = decidir(mensagem);
      if (d.casou) expect(d.respostaProntaId, sims(mensagem)).toBe(item);
    });
  }

  it("recall medido (e o menor afastamento do item certo para o segundo)", () => {
    const acertos = FORA_DA_AMOSTRA.filter(({ mensagem, item }) => {
      const d = decidir(mensagem);
      return d.casou && d.respostaProntaId === item;
    }).length;
    const afastamentos = FORA_DA_AMOSTRA.map(({ mensagem, item }) => {
      const porItem = gravado.similaridades[mensagem] ?? {};
      const outros = Object.entries(porItem).filter(([k]) => k !== item).map(([, v]) => v);
      return (porItem[item] ?? 0) - Math.max(...outros);
    });
    const recall = acertos / FORA_DA_AMOSTRA.length;
    process.stdout.write(
      `[corpus fora da amostra] recall ${acertos}/${FORA_DA_AMOSTRA.length} = ${(recall * 100).toFixed(0)}% · ` +
        `menor afastamento certo→segundo ${Math.min(...afastamentos).toFixed(3)}\n`,
    );
    // Catraca no medido (5/11, decisão de 03/10), não meta de qualidade: quem
    // não casa vai para a IA, e o recall cresce com formas de perguntar por
    // clínica, medido no piloto. Perder um acerto fora da amostra reprova.
    expect(acertos, "recall fora da amostra caiu").toBeGreaterThanOrEqual(5);
  });
});
