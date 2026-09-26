export interface RegraDeComentario {
  id: string;
  mediaId: string;
  palavra: string;
  textoDoDirect: string;
  frasePublica: string;
  criadaEm: string;
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function regraQueCasa(
  texto: string | null,
  regras: RegraDeComentario[]
): RegraDeComentario | null {
  // Texto vazio, nulo ou só emoji não casa nada
  if (!texto || texto.trim() === "" || !/[^\p{Emoji_Presentation}\s]/u.test(texto)) {
    return null;
  }

  const textoNormalizado = normalize(texto);
  const casando: RegraDeComentario[] = [];

  for (const regra of regras) {
    const palavraNormalizada = normalize(regra.palavra);
    const palavraEscapada = escapeRegex(palavraNormalizada);

    // Palavra inteira: precedida por início de string ou non-word character,
    // seguida por fim de string ou non-word character
    const regex = new RegExp(`(^|\\W)${palavraEscapada}($|\\W)`, "u");

    if (regex.test(textoNormalizado)) {
      casando.push(regra);
    }
  }

  if (casando.length === 0) {
    return null;
  }

  // Ordenar por comprimento da palavra (desc) e depois por criadaEm (asc)
  casando.sort((a, b) => {
    const diffComprimento = b.palavra.length - a.palavra.length;
    if (diffComprimento !== 0) {
      return diffComprimento;
    }
    return new Date(a.criadaEm).getTime() - new Date(b.criadaEm).getTime();
  });

  return casando[0];
}
