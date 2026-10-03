import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { detectUrgencySignal } from "@/lib/agent-engine/guardrails/sinal-de-urgencia";
import { MODELO_DE_EMBEDDING } from "@/lib/ai/embeddings/chave";
import {
  LIMITE_PADRAO,
  decidirRespostaPronta,
  sinalClinico,
  textoParaComparar,
  umAssuntoSo,
} from "@/lib/respostas-prontas/casamento";

import { CADASTRO, DEVEM_CASAR, NAO_DEVEM_CASAR, hashDoCadastro } from "../fixtures/respostas-prontas/corpus";

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

function gravado(): Gravado {
  if (!existsSync(ARQUIVO)) {
    throw new Error(
      "similaridades.json ausente — rode `OPENAI_API_KEY=... pnpm exec tsx scripts/respostas-prontas-gravar-similaridades.ts`",
    );
  }
  return JSON.parse(readFileSync(ARQUIVO, "utf8")) as Gravado;
}

/**
 * O que o motor faria com esta mensagem, no limite padrão — a mesma sequência de
 * `tentarRespostaPronta` (lib/agent-engine/agent/resposta-pronta.ts): urgência,
 * sinal clínico, trava 3, e só então as travas 1 e 2 sobre as similaridades.
 */
function decidir(mensagem: string, g: Gravado) {
  if (detectUrgencySignal(mensagem)) return { casou: false as const, motivo: "sinal_de_urgencia" };
  if (sinalClinico(mensagem)) return { casou: false as const, motivo: "sinal_clinico" };
  const forma = umAssuntoSo(textoParaComparar([mensagem]));
  if (!forma.ok) return { casou: false as const, motivo: forma.motivo };
  const porItem = g.similaridades[mensagem];
  if (porItem === undefined) throw new Error(`"${mensagem}" não está gravada — regrave o arquivo`);
  return decidirRespostaPronta(new Map(Object.entries(porItem)), LIMITE_PADRAO);
}

describe("corpus odontológico — modelo real, sem rede", () => {
  it("o arquivo gravado é do modelo e do cadastro atuais", () => {
    const g = gravado();
    expect(g.modelo).toBe(MODELO_DE_EMBEDDING);
    expect(g.cadastro_hash, "o CADASTRO mudou — regrave o arquivo").toBe(hashDoCadastro());
  });

  it("toda frase gravada tem similaridade com todos os itens do cadastro", () => {
    const g = gravado();
    const itens = CADASTRO.map((i) => i.id).sort();
    for (const frase of [...NAO_DEVEM_CASAR, ...DEVEM_CASAR.map((d) => d.mensagem)]) {
      expect(Object.keys(g.similaridades[frase] ?? {}).sort(), frase).toEqual(itens);
    }
  });

  for (const frase of NAO_DEVEM_CASAR) {
    it(`NÃO responde pronto: "${frase.slice(0, 60)}"`, () => {
      const d = decidir(frase, gravado());
      expect(d.casou, JSON.stringify(gravado().similaridades[frase] ?? {})).toBe(false);
    });
  }

  for (const { mensagem, item } of DEVEM_CASAR) {
    it(`responde com "${item}": "${mensagem}"`, () => {
      const d = decidir(mensagem, gravado());
      expect(d, JSON.stringify(gravado().similaridades[mensagem] ?? {})).toMatchObject({
        casou: true,
        respostaProntaId: item,
      });
    });
  }
});
