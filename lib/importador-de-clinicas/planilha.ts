/**
 * A planilha da agência: três abas, cabeçalhos fixos, conferências com aba e linha.
 * Pura — recebe as abas já lidas (`lerXlsx`) e devolve dados prontos ou erros.
 * Spec: evalink-conta/docs/superpowers/specs/2026-10-04-importador-de-clinicas-design.md §4.
 */
import { z } from "zod";

import { normalizaTelefone } from "@/lib/contacts/csv";
import { criarRespostaProntaSchema } from "@/lib/respostas-prontas/esquemas";

import type { AbaParaEscrever, Abas } from "./xlsx";

export type Papel = "agent" | "manager";

export const ABA_CLINICAS = "Clínicas";
export const ABA_PERGUNTAS = "Perguntas frequentes";
export const ABA_ATENDENTES = "Atendentes";

interface Coluna {
  chave: string;
  titulo: string;
  obrigatoria: boolean;
  exemplo: string;
}

export const COLUNAS: Record<string, readonly Coluna[]> = {
  [ABA_CLINICAS]: [
    { chave: "codigo", titulo: "Código", obrigatoria: true, exemplo: "EXEMPLO-001" },
    { chave: "nome", titulo: "Nome da clínica", obrigatoria: true, exemplo: "Clínica Sorriso Centro" },
    { chave: "razao_social", titulo: "Razão social", obrigatoria: false, exemplo: "Sorriso Centro Odontologia Ltda" },
    { chave: "cnpj", titulo: "CNPJ", obrigatoria: false, exemplo: "12.345.678/0001-90" },
    { chave: "telefone", titulo: "Telefone", obrigatoria: true, exemplo: "(27) 99999-8888" },
    { chave: "email", titulo: "E-mail", obrigatoria: false, exemplo: "recepcao@example.com" },
    { chave: "endereco", titulo: "Endereço", obrigatoria: true, exemplo: "Rua das Flores, 100, Centro, Vitória - ES" },
    { chave: "horarios", titulo: "Horários", obrigatoria: true, exemplo: "seg-sex 08:00-18:00; sab 08:00-12:00" },
    { chave: "convenios", titulo: "Convênios", obrigatoria: false, exemplo: "Uniodonto; Amil Dental" },
    { chave: "especialidades", titulo: "Especialidades", obrigatoria: false, exemplo: "clínica geral, ortodontia e implantes" },
    { chave: "assistente", titulo: "Nome da assistente", obrigatoria: false, exemplo: "Ana" },
    { chave: "fuso", titulo: "Fuso horário", obrigatoria: false, exemplo: "America/Sao_Paulo" },
  ],
  [ABA_PERGUNTAS]: [
    { chave: "codigo", titulo: "Código da clínica", obrigatoria: true, exemplo: "EXEMPLO-001" },
    { chave: "titulo", titulo: "Título", obrigatoria: true, exemplo: "Convênios aceitos" },
    {
      chave: "resposta", titulo: "Resposta", obrigatoria: true,
      exemplo: "Atendemos Uniodonto e Amil Dental. Para outros planos, a recepção confirma.",
    },
    {
      chave: "formas", titulo: "Formas de perguntar", obrigatoria: true,
      exemplo: "aceita convênio?; vocês atendem Uniodonto?; quais planos vocês aceitam?",
    },
  ],
  [ABA_ATENDENTES]: [
    { chave: "codigo", titulo: "Código da clínica", obrigatoria: true, exemplo: "EXEMPLO-001" },
    { chave: "nome", titulo: "Nome", obrigatoria: true, exemplo: "Maria Souza" },
    { chave: "email", titulo: "E-mail", obrigatoria: true, exemplo: "maria@example.com" },
    { chave: "papel", titulo: "Papel", obrigatoria: true, exemplo: "atendente" },
  ],
};

export interface ErroDaPlanilha {
  aba: string;
  linha: number;
  mensagem: string;
  /** A clínica que este erro tira da importação; null = erro geral, não bloqueia ninguém. */
  codigo: string | null;
}

export interface ClinicaDaPlanilha {
  linha: number;
  codigo: string;
  slug: string;
  nome: string;
  razaoSocial: string;
  cnpj: string | null;
  /** E.164, sempre `+55…`. */
  telefone: string;
  email: string | null;
  endereco: string;
  /** Já normalizado por `lerHorarios`. */
  horarios: string;
  convenios: string[];
  especialidades: string | null;
  assistente: string | null;
  fuso: string;
}

export interface PerguntaDaPlanilha {
  linha: number;
  codigo: string;
  titulo: string;
  resposta: string;
  perguntas: string[];
}

export interface AtendenteDaPlanilha {
  linha: number;
  codigo: string;
  nome: string;
  /** Minúsculas. */
  email: string;
  papel: Papel;
}

export interface PlanilhaLida {
  fatal: string | null;
  clinicas: ClinicaDaPlanilha[];
  perguntas: PerguntaDaPlanilha[];
  atendentes: AtendenteDaPlanilha[];
  erros: ErroDaPlanilha[];
  avisos: string[];
}

const CODIGO = /^[A-Z0-9][A-Z0-9-]{1,39}$/;
const EXEMPLO = /^EXEMPLO\b/;
const FUSO_PADRAO = "America/Sao_Paulo";
const PAPEIS: Record<string, Papel> = { atendente: "agent", supervisor: "manager" };
const MENSAGEM_DO_CAMPO: Record<string, string> = {
  titulo: "Título vazio ou com mais de 80 caracteres",
  resposta: "Resposta vazia ou com mais de 1000 caracteres",
  perguntas: "Formas de perguntar: de 1 a 20, cada uma com 3 a 200 caracteres",
};

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function chave(s: string): string {
  return semAcento(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

const emailValido = (s: string) => z.string().email().safeParse(s).success;

export function fusoValido(fuso: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: fuso });
    return true;
  } catch {
    return false;
  }
}

// ─── Horários ────────────────────────────────────────────────────────────────

const DIAS = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"];
const NOME_DO_DIA = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];

function dia(t: string): number {
  return DIAS.indexOf(t.slice(0, 3));
}

function lerDias(t: string): string | null {
  const saida: string[] = [];
  for (const parte of t.replace(/-feira/g, "").split(/\s*,\s*/)) {
    const faixa = /^([a-z]{3,})\s*(?:ate|a|-)\s*([a-z]{3,})$/.exec(parte);
    if (faixa) {
      const de = dia(faixa[1]!);
      const ate = dia(faixa[2]!);
      if (de < 0 || ate <= de) return null;
      saida.push(`${NOME_DO_DIA[de]} a ${NOME_DO_DIA[ate]}`);
      continue;
    }
    if (!/^[a-z]{3,}$/.test(parte) || dia(parte) < 0) return null;
    saida.push(NOME_DO_DIA[dia(parte)]!);
  }
  return saida.join(", ");
}

function minutos(h: string, m: string | undefined): number | null {
  const hh = Number(h);
  const mm = m === undefined ? 0 : Number(m);
  return hh <= 23 && mm <= 59 ? hh * 60 + mm : null;
}

const hora = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

function lerFaixas(t: string): string | null {
  const saida: string[] = [];
  for (const parte of t.split(/\s*(?:,|\be\b)\s*/)) {
    const m = /^(\d{1,2})(?:[:h](\d{2})?)?\s*(?:-|–|ate|as|a)\s*(\d{1,2})(?:[:h](\d{2})?)?h?$/.exec(parte);
    if (!m) return null;
    const de = minutos(m[1]!, m[2]);
    const ate = minutos(m[3]!, m[4]);
    if (de === null || ate === null || ate <= de) return null;
    saida.push(`${hora(de)} às ${hora(ate)}`);
  }
  return saida.join(" e ");
}

function lerSegmento(seg: string): string | null {
  const m = /^(.*?[a-z])\s*:?\s+(fechado|\d.*)$/.exec(seg);
  if (!m) return null;
  const dias = lerDias(m[1]!);
  const faixas = m[2] === "fechado" ? "fechado" : lerFaixas(m[2]!);
  return dias && faixas ? `${dias}: ${faixas}` : null;
}

/** "seg-sex 08:00-18:00; sab 08:00-12:00" → "Segunda a Sexta: 08:00 às 18:00; Sábado: 08:00 às 12:00". */
export function lerHorarios(bruto: string): string | null {
  const segmentos = semAcento(bruto)
    .toLowerCase()
    .split(/\s*[;\n]\s*/)
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (segmentos.length === 0) return null;
  const lidos = segmentos.map(lerSegmento);
  return lidos.every((s): s is string => s !== null) ? lidos.join("; ") : null;
}

// ─── Abas ────────────────────────────────────────────────────────────────────

interface Linha {
  numero: number;
  valores: Record<string, string>;
}

function lerAba(abas: Abas, aba: string): { linhas: Linha[] } | { fatal: string } {
  const achada = [...abas.entries()].find(([nome]) => chave(nome) === chave(aba));
  if (!achada) return { fatal: `falta a aba "${aba}"` };
  const [cabecalho = [], ...resto] = achada[1];
  const colunas = COLUNAS[aba]!;
  const posicao = new Map<string, number>();
  cabecalho.forEach((titulo, i) => {
    const k = chave(titulo);
    const col = colunas.find((c) => chave(c.titulo) === k || c.chave === k);
    if (col && !posicao.has(col.chave)) posicao.set(col.chave, i);
  });
  const faltam = colunas.filter((c) => c.obrigatoria && !posicao.has(c.chave)).map((c) => c.titulo);
  if (faltam.length > 0) return { fatal: `a aba "${aba}" não tem a(s) coluna(s): ${faltam.join(", ")}` };
  const linhas: Linha[] = [];
  resto.forEach((celulas, i) => {
    const valores: Record<string, string> = {};
    for (const c of colunas) valores[c.chave] = (celulas[posicao.get(c.chave) ?? -1] ?? "").trim();
    if (Object.values(valores).some((v) => v !== "")) linhas.push({ numero: i + 2, valores });
  });
  return { linhas };
}

export function lerPlanilha(abas: Abas): PlanilhaLida {
  const vazia = { clinicas: [], perguntas: [], atendentes: [], erros: [], avisos: [] };
  const lidas = [ABA_CLINICAS, ABA_PERGUNTAS, ABA_ATENDENTES].map((aba) => lerAba(abas, aba));
  for (const l of lidas) if ("fatal" in l) return { fatal: l.fatal, ...vazia };
  const [abaC, abaP, abaA] = lidas as Array<{ linhas: Linha[] }>;

  const erros: ErroDaPlanilha[] = [];
  const avisos: string[] = [];
  const erro = (aba: string, linha: number, codigo: string | null, mensagem: string) =>
    erros.push({ aba, linha, codigo, mensagem });
  const ehExemplo = (aba: string, l: Linha) => {
    if (!EXEMPLO.test(l.valores.codigo!.toUpperCase())) return false;
    avisos.push(`${aba}, linha ${l.numero}: linha de exemplo ignorada`);
    return true;
  };
  const faltando = (aba: string, l: Linha) =>
    COLUNAS[aba]!.filter((c) => c.obrigatoria && l.valores[c.chave] === "").map((c) => `falta ${c.titulo}`);

  // Clínicas
  const clinicas: ClinicaDaPlanilha[] = [];
  const primeiraLinha = new Map<string, number>();
  for (const l of abaC!.linhas) {
    if (ehExemplo(ABA_CLINICAS, l)) continue;
    const v = l.valores;
    const codigo = v.codigo!.toUpperCase();
    const falhas = faltando(ABA_CLINICAS, l);
    if (codigo && !CODIGO.test(codigo))
      falhas.push(`código "${v.codigo}" inválido: use letras, números e hífen (2 a 40 caracteres)`);
    if (primeiraLinha.has(codigo)) falhas.push(`código ${codigo} repetido (já aparece na linha ${primeiraLinha.get(codigo)})`);
    else if (codigo) primeiraLinha.set(codigo, l.numero);
    const telefone = v.telefone ? normalizaTelefone(v.telefone) : null;
    if (v.telefone && !telefone?.startsWith("+55"))
      falhas.push(`telefone "${v.telefone}" não é um número brasileiro com DDD`);
    if (v.email && !emailValido(v.email)) falhas.push(`e-mail "${v.email}" inválido`);
    const cnpj = v.cnpj ? v.cnpj.replace(/\D/g, "") : null;
    if (cnpj !== null && cnpj.length !== 14) falhas.push(`CNPJ "${v.cnpj}" não tem 14 dígitos`);
    const horarios = v.horarios ? lerHorarios(v.horarios) : null;
    if (v.horarios && horarios === null)
      falhas.push(`horário "${v.horarios}" ilegível; escreva como "seg-sex 08:00-18:00; sab 08:00-12:00"`);
    const fuso = v.fuso || FUSO_PADRAO;
    if (!fusoValido(fuso)) falhas.push(`fuso horário "${v.fuso}" desconhecido; use por exemplo America/Sao_Paulo`);

    for (const f of falhas) erro(ABA_CLINICAS, l.numero, codigo || null, f);
    if (falhas.length > 0) continue;
    clinicas.push({
      linha: l.numero,
      codigo,
      slug: codigo.toLowerCase(),
      nome: v.nome!,
      razaoSocial: v.razao_social || v.nome!,
      cnpj,
      telefone: telefone!,
      email: v.email ? v.email.toLowerCase() : null,
      endereco: v.endereco!,
      horarios: horarios!,
      convenios: v.convenios!.split(/;|\n/).map((s) => s.trim()).filter(Boolean),
      especialidades: v.especialidades || null,
      assistente: v.assistente || null,
      fuso,
    });
  }
  const conhecido = (codigo: string) => primeiraLinha.has(codigo);

  // Perguntas frequentes
  const perguntas: PerguntaDaPlanilha[] = [];
  const titulos = new Map<string, number>();
  for (const l of abaP!.linhas) {
    if (ehExemplo(ABA_PERGUNTAS, l)) continue;
    const v = l.valores;
    const codigo = v.codigo!.toUpperCase();
    if (!conhecido(codigo)) {
      erro(ABA_PERGUNTAS, l.numero, null, `código da clínica "${v.codigo}" não existe na aba ${ABA_CLINICAS}`);
      continue;
    }
    const formas = v.formas!.split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);
    const r = criarRespostaProntaSchema.safeParse({ titulo: v.titulo, resposta: v.resposta, perguntas: formas });
    if (!r.success) {
      for (const campo of new Set(r.error.issues.map((i) => String(i.path[0]))))
        erro(ABA_PERGUNTAS, l.numero, codigo, MENSAGEM_DO_CAMPO[campo] ?? `campo ${campo} inválido`);
      continue;
    }
    const k = `${codigo}\u0000${r.data.titulo}`;
    if (titulos.has(k)) {
      erro(ABA_PERGUNTAS, l.numero, codigo, `título "${r.data.titulo}" repetido nesta clínica (linha ${titulos.get(k)})`);
      continue;
    }
    titulos.set(k, l.numero);
    perguntas.push({ linha: l.numero, codigo, ...r.data });
  }

  // Atendentes
  const atendentes: AtendenteDaPlanilha[] = [];
  const emails = new Map<string, number>();
  for (const l of abaA!.linhas) {
    if (ehExemplo(ABA_ATENDENTES, l)) continue;
    const v = l.valores;
    const codigo = v.codigo!.toUpperCase();
    if (!conhecido(codigo)) {
      erro(ABA_ATENDENTES, l.numero, null, `código da clínica "${v.codigo}" não existe na aba ${ABA_CLINICAS}`);
      continue;
    }
    const falhas = faltando(ABA_ATENDENTES, l);
    const email = v.email!.toLowerCase();
    if (email && !emailValido(email)) falhas.push(`e-mail "${v.email}" inválido`);
    const papel = PAPEIS[semAcento(v.papel!).toLowerCase()];
    if (v.papel && !papel) falhas.push(`papel "${v.papel}" inválido: use atendente ou supervisor`);
    const k = `${codigo}\u0000${email}`;
    if (falhas.length === 0 && emails.has(k)) falhas.push(`${email} repetido nesta clínica (linha ${emails.get(k)})`);
    for (const f of falhas) erro(ABA_ATENDENTES, l.numero, codigo, f);
    if (falhas.length > 0) continue;
    emails.set(k, l.numero);
    atendentes.push({ linha: l.numero, codigo, nome: v.nome!, email, papel: papel! });
  }

  return { fatal: null, clinicas, perguntas, atendentes, erros, avisos };
}

/** O modelo para a agência: as três abas, os cabeçalhos e uma linha de exemplo. */
export function abasDoModelo(): AbaParaEscrever[] {
  return [ABA_CLINICAS, ABA_PERGUNTAS, ABA_ATENDENTES].map((nome) => ({
    nome,
    linhas: [COLUNAS[nome]!.map((c) => c.titulo), COLUNAS[nome]!.map((c) => c.exemplo)],
  }));
}
