/**
 * Painéis do Início (specs docs/superpowers/specs/2026-10-07-inicio-paineis-design.md
 * e 2026-11-11-inicio-claro.md): as janelas no fuso da organização, a conta "de
 * cada 10" e os rótulos das origens. Funções puras — a rota
 * `/api/v1/inicio/paineis` as usa para chamar as funções do banco.
 */
import { inicioDoDiaNoFuso } from "@/lib/plataformas-de-anuncio/meta/resultado-crm";

function somarDias(data: string, dias: number): string {
  const [a, m, d] = data.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

function diaNoFuso(agora: Date, fuso: string): string {
  return agora.toLocaleDateString("en-CA", { timeZone: fuso });
}

export interface JanelasDosPaineis {
  conversas: { inicio: string; fim: string };
  semana: { inicio: string; fim: string; de: string; ate: string };
  /** `de` é o primeiro dia do mês (`YYYY-MM-DD`): a tela tira dele o nome do mês. */
  mes: { inicio: string; fim: string; de: string };
  /** Os MESMOS DIAS do mês anterior: do dia 1 até o instante equivalente a agora. */
  mesAnterior: { inicio: string; fim: string; de: string };
}

/**
 * Conversas: 30 dias terminando hoje. Semana: segunda a domingo. Mês corrente
 * inteiro. Mês anterior: só até o mesmo dia e hora de agora — comparar o mês
 * pela metade com o anterior inteiro dava "794 a menos" todo começo de mês. Se
 * o mês anterior é mais curto (31 de março × fevereiro), a janela para no fim dele.
 */
export function janelasDosPaineis(agora: Date, fuso: string): JanelasDosPaineis {
  const hoje = diaNoFuso(agora, fuso);
  const primeiro = somarDias(hoje, -29);

  // getUTCDay da data local: 0 = domingo. Segunda é o primeiro dia da semana.
  const diaDaSemana = new Date(`${hoje}T00:00:00Z`).getUTCDay();
  const segunda = somarDias(hoje, -((diaDaSemana + 6) % 7));
  const domingo = somarDias(segunda, 6);

  const [ano, mes, dia] = hoje.split("-").map(Number) as [number, number, number];
  const primeiroDoMes = `${hoje.slice(0, 7)}-01`;
  const proximoMes = new Date(Date.UTC(ano, mes, 1)).toISOString().slice(0, 10);
  const mesAnterior = new Date(Date.UTC(ano, mes - 2, 1)).toISOString().slice(0, 10);

  const inicioDoMes = inicioDoDiaNoFuso(primeiroDoMes, fuso);
  // O mesmo dia do mês anterior, na mesma hora do relógio de agora.
  const mesmoDia = somarDias(mesAnterior, dia - 1);
  const decorridoHoje = agora.getTime() - Date.parse(inicioDoDiaNoFuso(hoje, fuso));
  const mesmoInstante = new Date(Date.parse(inicioDoDiaNoFuso(mesmoDia, fuso)) + decorridoHoje).toISOString();

  return {
    conversas: {
      inicio: inicioDoDiaNoFuso(primeiro, fuso),
      fim: inicioDoDiaNoFuso(somarDias(hoje, 1), fuso),
    },
    semana: {
      inicio: inicioDoDiaNoFuso(segunda, fuso),
      fim: inicioDoDiaNoFuso(somarDias(domingo, 1), fuso),
      de: segunda,
      ate: domingo,
    },
    mes: { inicio: inicioDoMes, fim: inicioDoDiaNoFuso(proximoMes, fuso), de: primeiroDoMes },
    mesAnterior: {
      inicio: inicioDoDiaNoFuso(mesAnterior, fuso),
      fim: mesmoInstante < inicioDoMes ? mesmoInstante : inicioDoMes,
      de: mesAnterior,
    },
  };
}

export interface FaixasDeAtendimento {
  equipe: number;
  ia: number;
  semResposta: number;
}

/**
 * "De cada 10 conversas novas…": reparte 10 entre as três faixas pelo MAIOR
 * RESTO, para a frase somar sempre 10 (arredondar cada uma sozinha dá 9 ou 11).
 * Empate de resto segue a ordem equipe → IA → sem resposta. Sem conversa, `null`.
 */
export function deCadaDez(n: FaixasDeAtendimento): FaixasDeAtendimento | null {
  const chaves = ["equipe", "ia", "semResposta"] as const;
  const total = chaves.reduce((s, k) => s + n[k], 0);
  if (total <= 0) return null;
  // Aritmética inteira: n·10 = inteiro·total + resto.
  const partes = chaves.map((k, i) => ({ k, i, inteiro: Math.floor((n[k] * 10) / total), resto: (n[k] * 10) % total }));
  let sobra = 10 - partes.reduce((s, p) => s + p.inteiro, 0);
  for (const p of [...partes].sort((a, b) => b.resto - a.resto || a.i - b.i)) {
    if (sobra-- <= 0) break;
    p.inteiro++;
  }
  return Object.fromEntries(partes.map((p) => [p.k, p.inteiro])) as unknown as FaixasDeAtendimento;
}

export type Origem =
  | "anuncio_meta"
  | "anuncio_google"
  | "whatsapp"
  | "formulario"
  | "prontuario"
  | "manual"
  | "outros";

/** `contacts.source` → origem para o painel. Indicação não é registrada hoje. */
export function origemDoContato(fonte: string): Origem {
  switch (fonte) {
    case "meta_ads":
      return "anuncio_meta";
    case "google_ads":
      return "anuncio_google";
    case "whatsapp":
      return "whatsapp";
    case "webhook":
      return "formulario";
    case "prontuario_eva":
      return "prontuario";
    case "":
    case "manual":
      return "manual";
    default:
      return "outros";
  }
}

export const ROTULO_DA_ORIGEM: Record<Origem, string> = {
  anuncio_meta: "Anúncio do Meta",
  anuncio_google: "Anúncio do Google",
  whatsapp: "WhatsApp",
  formulario: "Formulário ou site",
  prontuario: "Prontuário",
  manual: "Cadastro manual",
  outros: "Outros",
};
