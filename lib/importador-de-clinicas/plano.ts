/**
 * O PLANO de uma clínica: planilha × estado do banco → ações, avisos, recusa.
 * Puro. Rodar a mesma planilha sobre o estado que ela mesma produziu devolve
 * plano VAZIO — é a idempotência, provada antes de qualquer banco.
 *
 * Só reescreve o que o importador escreveu da última vez (hash em
 * `settings.importador`): trabalho feito na tela não é pisado, é avisado.
 */
import { memoriaDaClinica, NOME_DO_AGENTE, promptDaClinica, sha256 } from "./modelo-odontologico";
import type { AtendenteDaPlanilha, ClinicaDaPlanilha, Papel, PerguntaDaPlanilha } from "./planilha";

export interface MarcaDoImportador {
  codigo: string;
  memoria_sha256?: string;
  prompt_sha256?: string;
  /** Por título: o que o importador gravou da última vez (resposta + formas). */
  perguntas_sha256?: Record<string, string>;
}

export const hashDaPergunta = (resposta: string, formas: string[]) =>
  sha256(JSON.stringify([resposta, [...formas].sort()]));

export interface EstadoDaClinica {
  org: {
    id: string;
    nome: string;
    razaoSocial: string;
    cnpj: string | null;
    fuso: string;
    marca: MarcaDoImportador | null;
  } | null;
  perguntas: Array<{
    id: string;
    titulo: string;
    resposta: string;
    perguntas: Array<{ id: string; texto: string }>;
  }>;
  agente: {
    id: string;
    publicado: boolean;
    arquivado: boolean;
    rascunho: { id: string; prompt: string } | null;
  } | null;
  memoria: string | null;
  membros: Array<{ userId: string; email: string; papel: string; revogado: boolean }>;
}

export const ESTADO_VAZIO: EstadoDaClinica = {
  org: null,
  perguntas: [],
  agente: null,
  memoria: null,
  membros: [],
};

export interface DadosDaClinica {
  clinica: ClinicaDaPlanilha;
  perguntas: PerguntaDaPlanilha[];
  atendentes: AtendenteDaPlanilha[];
}

export type Acao =
  | { tipo: "criar_org" }
  | { tipo: "montar_funil" }
  | { tipo: "atualizar_org"; campos: string[] }
  | { tipo: "criar_pergunta"; titulo: string; resposta: string; perguntas: string[] }
  | {
      tipo: "atualizar_pergunta";
      id: string;
      titulo: string;
      resposta: string | null;
      novas: string[];
      sair: string[];
    }
  | { tipo: "criar_agente"; prompt: string }
  | { tipo: "atualizar_rascunho"; versaoId: string; prompt: string }
  | { tipo: "publicar_memoria"; conteudo: string }
  | { tipo: "vincular"; email: string; nome: string; papel: Papel }
  | { tipo: "mudar_papel"; userId: string; email: string; de: string; para: Papel };

export interface PlanoDaClinica {
  recusa: string | null;
  acoes: Acao[];
  avisos: string[];
  /** O que `settings.importador` passa a valer depois de aplicar. */
  marca: MarcaDoImportador;
  /** `marca` difere do que já está gravado; sem ações e sem isto, a rodada não precisa de transação. */
  marcaMudou: boolean;
}

const PAPEIS_QUE_O_IMPORTADOR_MUDA = new Set(["viewer", "agent", "manager"]);
const ROTULO: Record<string, string> = { agent: "atendente", manager: "supervisor" };
const rotulo = (papel: string) => ROTULO[papel] ?? papel;

export function planejarClinica(d: DadosDaClinica, e: EstadoDaClinica): PlanoDaClinica {
  const { clinica } = d;
  const marcaAtual = e.org?.marca ?? null;
  if (e.org && marcaAtual?.codigo !== clinica.codigo) {
    return {
      recusa: `já existe uma empresa com o endereço "${clinica.slug}" que não foi criada por este importador; nada foi alterado nela`,
      acoes: [],
      avisos: [],
      marca: { codigo: clinica.codigo },
      marcaMudou: false,
    };
  }
  const acoes: Acao[] = [];
  const avisos: string[] = [];
  const marca: MarcaDoImportador = {
    ...(marcaAtual ?? {}),
    codigo: clinica.codigo,
    perguntas_sha256: { ...(marcaAtual?.perguntas_sha256 ?? {}) },
  };
  const hashes = marca.perguntas_sha256!;

  // 1 · empresa (o funil só na criação: depois disso ele é da clínica)
  if (!e.org) acoes.push({ tipo: "criar_org" }, { tipo: "montar_funil" });
  else {
    const campos: string[] = [];
    if (e.org.nome !== clinica.nome) campos.push("nome");
    if (e.org.razaoSocial !== clinica.razaoSocial) campos.push("razao_social");
    if (e.org.cnpj !== clinica.cnpj) campos.push("cnpj");
    if (e.org.fuso !== clinica.fuso) campos.push("fuso");
    if (campos.length > 0) acoes.push({ tipo: "atualizar_org", campos });
  }

  // 2 · perguntas frequentes, chave (organização, título)
  const porTitulo = new Map<string, EstadoDaClinica["perguntas"]>();
  for (const p of e.perguntas) porTitulo.set(p.titulo, [...(porTitulo.get(p.titulo) ?? []), p]);
  for (const p of d.perguntas) {
    const iguais = porTitulo.get(p.titulo) ?? [];
    if (iguais.length === 0) {
      acoes.push({
        tipo: "criar_pergunta",
        titulo: p.titulo,
        resposta: p.resposta,
        perguntas: p.perguntas,
      });
      hashes[p.titulo] = hashDaPergunta(p.resposta, p.perguntas);
      continue;
    }
    if (iguais.length > 1) {
      avisos.push(
        `pergunta "${p.titulo}" aparece ${iguais.length} vezes na empresa; não foi alterada`,
      );
      continue;
    }
    const atual = iguais[0]!;
    const desejado = hashDaPergunta(p.resposta, p.perguntas);
    const doBanco = hashDaPergunta(
      atual.resposta,
      atual.perguntas.map((x) => x.texto),
    );
    if (doBanco === desejado) {
      hashes[p.titulo] = desejado;
      continue;
    }
    if (hashes[p.titulo] !== doBanco) {
      avisos.push(
        `pergunta "${p.titulo}" foi editada na tela; não foi sobrescrita (resposta e formas de perguntar mantidas)`,
      );
      continue;
    }
    const textos = new Set(atual.perguntas.map((x) => x.texto));
    acoes.push({
      tipo: "atualizar_pergunta",
      id: atual.id,
      titulo: p.titulo,
      resposta: atual.resposta === p.resposta ? null : p.resposta,
      novas: p.perguntas.filter((t) => !textos.has(t)),
      sair: atual.perguntas.filter((x) => !p.perguntas.includes(x.texto)).map((x) => x.id),
    });
    hashes[p.titulo] = desejado;
  }
  const titulosDaPlanilha = new Set(d.perguntas.map((p) => p.titulo));
  for (const t of porTitulo.keys())
    if (!titulosDaPlanilha.has(t))
      avisos.push(`pergunta "${t}" está na empresa e não está na planilha; não foi apagada`);

  // 3 · agente, sempre rascunho
  const prompt = promptDaClinica(clinica);
  const a = e.agente;
  if (!a) {
    acoes.push({ tipo: "criar_agente", prompt });
    marca.prompt_sha256 = sha256(prompt);
  } else if (a.arquivado) {
    avisos.push(`o agente "${NOME_DO_AGENTE}" está arquivado; não foi recriado`);
  } else if (a.publicado) {
    if (marca.prompt_sha256 !== sha256(prompt))
      avisos.push(
        `o agente "${NOME_DO_AGENTE}" já foi publicado; a mudança no modelo não foi aplicada — ajuste pela tela`,
      );
  } else if (!a.rascunho) {
    avisos.push(`o agente "${NOME_DO_AGENTE}" não tem rascunho; não foi alterado`);
  } else if (a.rascunho.prompt === prompt) {
    marca.prompt_sha256 = sha256(prompt);
  } else if (
    marca.prompt_sha256 !== undefined &&
    sha256(a.rascunho.prompt) === marca.prompt_sha256
  ) {
    acoes.push({ tipo: "atualizar_rascunho", versaoId: a.rascunho.id, prompt });
    marca.prompt_sha256 = sha256(prompt);
  } else {
    avisos.push(
      `o rascunho do agente "${NOME_DO_AGENTE}" foi editado na tela; não foi sobrescrito`,
    );
  }

  // 4 · regras da casa na memória da organização
  const memoria = memoriaDaClinica(clinica);
  if (e.memoria === memoria) marca.memoria_sha256 = sha256(memoria);
  else if (
    e.memoria === null ||
    (marca.memoria_sha256 !== undefined && sha256(e.memoria) === marca.memoria_sha256)
  ) {
    acoes.push({ tipo: "publicar_memoria", conteudo: memoria });
    marca.memoria_sha256 = sha256(memoria);
  } else
    avisos.push(
      "a memória da empresa foi editada na tela; as regras da casa não foram sobrescritas",
    );

  // 5 · atendentes — nunca remove acesso
  const membros = new Map(e.membros.map((m) => [m.email, m]));
  for (const at of d.atendentes) {
    const m = membros.get(at.email);
    if (!m) {
      acoes.push({ tipo: "vincular", email: at.email, nome: at.nome, papel: at.papel });
      continue;
    }
    if (m.revogado) {
      avisos.push(`${at.email} teve o acesso revogado na tela; não foi reativado`);
      continue;
    }
    if (m.papel === at.papel) continue;
    if (PAPEIS_QUE_O_IMPORTADOR_MUDA.has(m.papel))
      acoes.push({
        tipo: "mudar_papel",
        userId: m.userId,
        email: at.email,
        de: m.papel,
        para: at.papel,
      });
    else
      avisos.push(
        `${at.email} é ${m.papel} nesta empresa; o papel não foi trocado para ${rotulo(at.papel)}`,
      );
  }
  const naPlanilha = new Set(d.atendentes.map((x) => x.email));
  for (const m of e.membros)
    if (!m.revogado && (m.papel === "agent" || m.papel === "manager") && !naPlanilha.has(m.email))
      avisos.push(`${m.email} não está mais na planilha desta clínica; o acesso foi mantido`);

  return {
    recusa: null,
    acoes,
    avisos,
    marca,
    marcaMudou:
      marca.codigo !== marcaAtual?.codigo ||
      marca.memoria_sha256 !== marcaAtual?.memoria_sha256 ||
      marca.prompt_sha256 !== marcaAtual?.prompt_sha256 ||
      Object.keys(hashes).length !== Object.keys(marcaAtual?.perguntas_sha256 ?? {}).length ||
      Object.entries(hashes).some(([t, h]) => marcaAtual?.perguntas_sha256?.[t] !== h),
  };
}

export function descreverAcao(a: Acao): string {
  switch (a.tipo) {
    case "criar_org":
      return "cria a empresa (já fora do assistente de onboarding)";
    case "montar_funil":
      return "monta o funil de clínica";
    case "atualizar_org":
      return `atualiza a empresa (${a.campos.join(", ")})`;
    case "criar_pergunta":
      return `cria a pergunta frequente "${a.titulo}" (${a.perguntas.length} forma(s) de perguntar)`;
    case "atualizar_pergunta":
      return `atualiza a pergunta frequente "${a.titulo}"${a.resposta !== null ? " (resposta)" : ""}${a.novas.length || a.sair.length ? ` (+${a.novas.length}/-${a.sair.length} formas)` : ""}`;
    case "criar_agente":
      return `cria o agente "${NOME_DO_AGENTE}" em rascunho`;
    case "atualizar_rascunho":
      return `atualiza o rascunho do agente "${NOME_DO_AGENTE}"`;
    case "publicar_memoria":
      return "publica as regras da casa na memória da empresa";
    case "vincular":
      return `dá acesso a ${a.email} como ${rotulo(a.papel)}`;
    case "mudar_papel":
      return `muda ${a.email} de ${rotulo(a.de)} para ${rotulo(a.para)}`;
  }
}
