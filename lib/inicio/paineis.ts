/**
 * Painéis do Início (spec docs/superpowers/specs/2026-10-07-inicio-paineis-design.md):
 * as janelas no fuso da organização e os rótulos das origens. Funções puras — a
 * rota `/api/v1/inicio/paineis` as usa para chamar as funções 0330 do banco.
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
  conversas: { inicio: string; fim: string; dias: string[] };
  semana: { inicio: string; fim: string; de: string; ate: string };
  mes: { inicio: string; fim: string };
  mesAnterior: { inicio: string };
}

/** Conversas: 30 dias terminando hoje. Semana: segunda a domingo. Mês e mês anterior. */
export function janelasDosPaineis(agora: Date, fuso: string): JanelasDosPaineis {
  const hoje = diaNoFuso(agora, fuso);
  const primeiro = somarDias(hoje, -29);
  const dias = Array.from({ length: 30 }, (_, i) => somarDias(primeiro, i));

  // getUTCDay da data local: 0 = domingo. Segunda é o primeiro dia da semana.
  const diaDaSemana = new Date(`${hoje}T00:00:00Z`).getUTCDay();
  const segunda = somarDias(hoje, -((diaDaSemana + 6) % 7));
  const domingo = somarDias(segunda, 6);

  const [ano, mes] = hoje.split("-").map(Number) as [number, number];
  const primeiroDoMes = `${hoje.slice(0, 7)}-01`;
  const proximoMes = new Date(Date.UTC(ano, mes, 1)).toISOString().slice(0, 10);
  const mesAnterior = new Date(Date.UTC(ano, mes - 2, 1)).toISOString().slice(0, 10);

  return {
    conversas: {
      inicio: inicioDoDiaNoFuso(primeiro, fuso),
      fim: inicioDoDiaNoFuso(somarDias(hoje, 1), fuso),
      dias,
    },
    semana: {
      inicio: inicioDoDiaNoFuso(segunda, fuso),
      fim: inicioDoDiaNoFuso(somarDias(domingo, 1), fuso),
      de: segunda,
      ate: domingo,
    },
    mes: { inicio: inicioDoDiaNoFuso(primeiroDoMes, fuso), fim: inicioDoDiaNoFuso(proximoMes, fuso) },
    mesAnterior: { inicio: inicioDoDiaNoFuso(mesAnterior, fuso) },
  };
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

export interface DiaDeConversas {
  dia: string;
  ia_sozinha: number;
  com_equipe: number;
  sem_resposta: number;
}

/** Um ponto por dia da janela, com zeros onde o banco não devolveu linha. */
export function preencherDias(
  dias: string[],
  linhas: Array<Partial<DiaDeConversas> & { dia: string }>,
): DiaDeConversas[] {
  const porDia = new Map(linhas.map((l) => [l.dia, l]));
  return dias.map((dia) => {
    const l = porDia.get(dia);
    return { dia, ia_sozinha: l?.ia_sozinha ?? 0, com_equipe: l?.com_equipe ?? 0, sem_resposta: l?.sem_resposta ?? 0 };
  });
}

