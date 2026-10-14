/**
 * A CALIBRAÇÃO DO OPT-OUT, congelada.
 *
 * Este arquivo existe porque a regra anterior errava dos DOIS lados, e cada lado
 * falha de um jeito diferente:
 *
 *   - falso POSITIVO ("tem como parar a dor?" → bloqueado) some em silêncio: a
 *     pessoa deixa de receber e ninguém descobre, porque o motivo gravado
 *     (`stop_keyword`) parece legítimo;
 *   - falso NEGATIVO ("não quero mais receber" → não bloqueava) é pedido de LGPD
 *     ignorado.
 *
 * As duas listas abaixo são o corpus: frases de atendimento brasileiro real
 * (clínica, comércio, serviços). Acrescentar padrão em `lib/opt-out/deteccao.ts`
 * sem rodar isto é como o defeito volta.
 */
import { describe, expect, it } from "vitest";

import { comecaComPalavraDeSaida, ehOptOutProvavel, ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { FRASES_DE_CLINICA } from "@/scripts/lib/jev-frases-de-clinica";

/** Pedidos de descadastro que PRECISAM ser respeitados (bloqueiam o contato). */
const PEDE_PARA_SAIR = [
  "STOP",
  "stop",
  "PARAR",
  "Parar.",
  "sair",
  "SAIR!",
  "unsubscribe",
  "descadastrar",
  "pode parar de mandar mensagem",
  "para de me mandar isso",
  "pare de me enviar essas mensagens",
  "quero parar de receber",
  "não quero mais receber nada de vocês",
  "nao quero receber mais",
  "não me mande mais mensagens",
  // CONTROLE do lookahead da #435, lado português.
  "nao me mandem mais mensagens",
  "nao me ligue mais",
  "me tira dessa lista",
  "me remove da lista por favor",
  // CONTROLE do lookahead novo: continua bloqueando quando o objeto É a
  // comunicação — o lookahead exclui só a lista fechada de objetos não
  // comunicativos, não apaga o padrão inteiro.
  "pare de mandar essas fotos",
  "quero sair da lista",
  "quero cancelar a inscrição",
  "me descadastra aí",
  // ─── Formas que passavam batido (medido por @deskcommopp4s-cmd, #1607) ─────
  //
  // INFINITIVO — "pode me remover da lista" é como se pede de fato; a lista de
  // verbos tinha `remove|remova` e não `remover`.
  "pode me remover da lista",
  "me retirar da lista",
  "me excluir da lista",
  "me apagar da lista",
  "gostaria de me remover da lista",
  // IMPERATIVO NEGATIVO — o padrão "não me X mais" tinha lista própria, mais
  // estreita que a constante compartilhada. E a locução "entrar em contato"
  // não existia em lista nenhuma: `entre` é de ENTRAR, não de comunicar.
  "não entre mais em contato neste numero",
  "nao entre em contato comigo",
  "nao me contate mais",
  "nao me contacte mais",
  "nao me escreva mais",
  "nao me perturbe mais",
  "nao volte a entrar em contato",
  // Variações das três formas, com a regra estreitada do #1607: `me`
  // obrigatório, imperativo, e lista de ENVIO.
  "Não me contate mais!",
  "por favor nao me contate mais",
  "nao me contatem mais",
  "nao me chame mais",
  "nao entrem mais em contato",
  "parem de entrar em contato comigo",
  "pare de entrar em contato",
  "nao entre mais em contato por aqui",
  "me tira da lista de transmissão",
  "me remove da lista de contatos",
  // MESMA CLASSE, outro verbo: "sair da lista" é o irmão de "me tira da
  // lista" e no #1806 estava sem o freio — só o segundo pedia lista de ENVIO.
  "quero sair da lista de transmissão",
  "sair da lista de contatos",
  "quero sair dessa lista de mensagens",
  // a imperativa de terceira pessoa segue bloqueando quando NÃO há sujeito:
  // é a frase que os controles negativos abaixo precisam proteger.
  "não me liga mais",
  "por favor não me liga mais",
  // ─── A isenção por sujeito alcançava pedido que NÃO é ambíguo (#1825) ─────
  //
  // Medido pelo mantenedor com a função real: com o lookahead lendo a
  // constante de verbos INTEIRA e com `[,;:]*` entre o sintagma e "não me",
  // as frases abaixo davam `ehPedidoDeOptOut = false` E `ehOptOutProvavel =
  // false` — nem bloqueavam nem escalavam para humano. Na main, todas
  // bloqueavam.
  //
  // vírgula depois do sintagma marca VOCATIVO: em português o sujeito não se
  // separa do verbo por vírgula, e quem vem ali é com quem se fala, não a
  // pessoa descrita — "minha filha, não me liga mais" é a filha pedindo.
  "minha filha, não me liga mais",
  "meu filho, não me liga mais",
  "meu querido, não me manda mais nada",
  // tratamento de 2ª pessoa com verbo de 3ª: casa como sujeito de 3ª pessoa
  // e não é — é ordem dada a quem se está escrevendo.
  "o senhor não me mande mais mensagem",
  "a senhora não me manda mais mensagem",
  "o sr não me mande mais mensagem",
  "a sra não me manda mais mensagem",
  // imperativa SEM duplo sentido, com sujeito: `contate` nunca é 3ª pessoa do
  // indicativo, então não há o que separar — a isenção não alcança aqui.
  "meu filho não me contate mais",
  // o sujeito precisa ABRIR a mensagem ou a oração (#1825): sem pontuação, o
  // normal no WhatsApp, o fim da oração anterior ("o numero", "o plano") era
  // lido como sujeito e o pedido nem bloqueava nem escalava. Na main, todas
  // bloqueavam.
  "vou bloquear o numero não me liga mais",
  "já cancelei o plano não me manda mais mensagem",
  "não tenho interesse nesse produto não me manda mais",
  "odeio esse spam não me manda mais",
  "vou denunciar essa empresa não me manda mais nada",
  // `tu` é 2ª pessoa, a mesma classe de "o senhor": não abre sujeito de 3ª.
  "tu não me liga mais",
  // determinante SOZINHO não é sujeito (#1825): o "meu" interjeição, sem
  // vírgula, abria sujeito com zero palavras e isentava o pedido.
  "meu não me liga mais",
  "Meu não me manda mais nada",
];

/** Frases do dia a dia que usam a palavra e NÃO são pedido de descadastro. */
const NAO_PEDE_PARA_SAIR = [
  // e-commerce — o padrão de cessação ancorava só no VERBO ("mandar"), e
  // "mandar" é verbo de comunicação mesmo quando o objeto é outra coisa.
  // Bloquearia um cliente pedindo para mudar a ENTREGA.
  "pare de mandar o pedido nesse endereco",
  "para de mandar a fatura por aqui",
  // MESMA CLASSE, outra construção: "não me mande mais X" ancorava só no
  // verbo, como o padrão de cessação acima ancorava. O lookahead de
  // OBJETOS_NAO_COMUNICATIVOS estava num e faltava no outro — e este é o mais
  // comum dos dois, porque é como se reclama direto (issue #435).
  "nao me mande mais boletos",
  "nao me mande mais faturas por email",
  "nao me mandem mais cobrancas duplicadas",
  "nao me envie mais os produtos errados",
  // clínica — o caso que motivou este arquivo
  "tem como parar a dor?",
  "dá pra parar o sangramento em casa?",
  "quero parar o tratamento por enquanto",
  "posso sair antes das 15h?",
  "preciso sair mais cedo da consulta",
  "vou ter que sair do trabalho pra ir aí",
  "o remédio fez a dor parar",
  // comércio e serviços
  "quero cancelar o pedido",
  "posso cancelar a consulta de amanhã?",
  "vocês vão parar no feriado?",
  "que horas vocês param de atender?",
  // colagem — o defeito da versão com `\b` ASCII, que já tinha sido corrigido
  "amanhã ele sairá do escritório e pararão as obras",
  "a obra pararia se chovesse",
  // ─── Invasores das aberturas do #1607 (@deskcommopp4s-cmd) ────────────────
  //
  // remover/apagar/tirar aparecem, mas o OBJETO não é a comunicação com o
  // cliente. Nenhuma bloqueia.
  "remove o produto do carrinho",
  "tira meu nome do e-mail",
  "remove meu contato do grupo",
  "apaga a luz quando sair",
  "retire o item da sacola",
  "excluir minha conta do banco",
  "me tira uma duvida",
  "posso remover o produto",
  "retirei o pedido ontem",
  "vou remover o app",
  "tira da lista de espera",
  // A locução `entrar em contato` também é afirmativa na vida real: quem MARCA
  // um contato não está pedindo para sair dele.
  "nao vou poder entrar em contato hoje",
  "vou entrar em contato amanha",
  "quando voces vao entrar em contato?",
  "nao consegui entrar em contato ontem",
  // ─── O que o #1607 bloqueava a mais: clínica, oficina, loja ──────────────
  //
  // Medido na triagem do #1607 — todas `false` na main e `true` no PR. Cada
  // grupo é uma abertura que a regra NÃO fez:
  //
  // sem `me`, o sujeito não é quem escreve (3ª pessoa descritiva)
  "o dente nao incomoda mais",
  "o implante nao incomoda mais",
  "o carro nao liga mais",
  "meu celular nao liga mais",
  "o pix nao recebe mais",
  "meu filho nao fala mais comigo",
  "a caneta nao escreve mais",
  // com `me`, mas `incomodar` não é verbo de comunicação — e as formas
  // descritivas da constante (`FORMAS_DESCRITIVAS_DEPOIS_DE_ME`) ficam fora
  "a dor nao me incomoda mais",
  "a dor nao me perturba mais",
  "o convenio nao me recebe mais",
  "a doutora nao me escreve mais a receita",
  // infinitivo novo na constante alargaria o "parar de …"
  "vou parar de procurar outro dentista",
  "pode parar de falar da cirurgia?",
  "para de falar besteira kkk",
  // remoção sem `me`, ou com destino que não é lista de envio
  "ja exclui do celular",
  "apaga do whatsapp aquela foto",
  "remove do sistema a consulta de amanha",
  "tira da base do dente",
  "remove da lista de desejos",
  "tira da lista de presentes",
  "me tira da lista de espera",
  "me tira da lista de presentes",
  "me remove da lista de desejos",
  // #1806 (1): "sair da lista" não tinha o freio que "me tira da lista"
  // ganhou no #1805. "lista de espera" é paciente querendo ser chamado e a
  // frase gravava `is_blocked` — o MESMO defeito, com outro verbo.
  "quero sair da lista de espera",
  "quero sair dessa lista de presentes",
  "sair da lista de desejos",
  "quero sair da lista de espera, pode ser?",
  // #1806 (2): `liga` é imperativo informal E 3ª pessoa do indicativo. Sem
  // sujeito explícito a ordem bloqueia (acima); COM sujeito é relato de quem
  // está falando, não pedido de descadastro. Os casos abaixo são controles
  // negativos do mesmo freio. O controle COM vírgula saiu daqui no #1825: a
  // vírgula marca vocativo, não sujeito, e a frase passou a bloquear — está
  // em `PEDE_PARA_SAIR`.
  "meu filho não me liga mais",
  "ele não me liga mais",
  "ela não me manda mais nada",
  "a doutora não me chama mais",
  "a minha equipe não me liga mais",
  "meu antigo chefe não me liga mais",
  // o sujeito abre a oração depois da saudação: segue sendo relato (#1825).
  "oi, meu filho não me liga mais",
  // "entrar em contato" com outro destinatário ou outro canal, e a reclamação
  "nao entre em contato com meu marido, fale comigo",
  "nao entrem em contato por email, so whatsapp",
  "vou parar de entrar em contato com o fornecedor",
  "o medico nao entra mais em contato",
  // vazios
  "",
  "   ",
];

/**
 * ─── ESPANHOL, e por que ele não é "mais um idioma" ─────────────────────────
 *
 * `baja` é a palavra que a PLANTILLA pede. Medido numa instalação real: 6 das 9
 * definições aprovadas terminam com "Respondé BAJA para no recibir más", todas
 * de categoria MARKETING. Três clientes pediram e nenhum foi atendido, porque a
 * lista só tinha português e inglês.
 *
 * A promessa está escrita na mensagem que a empresa manda, com aprovação da
 * plataforma — e é no canal onde denúncia de spam derruba o quality rating e faz
 * a plataforma recusar definições NOVAS. Perde-se as aprovadas, não só a linha.
 *
 * Os casos negativos são metade do valor: a âncora em verbo de comunicação é o
 * que impede o falso positivo NOVO, e sem ela "no quiero recibir la factura por
 * aqui" bloquearia um cliente que está pedindo para CONTINUAR sendo atendido.
 */
const ESPANHOL_PEDE_PARA_SAIR = [
  "BAJA",
  "Baja",
  "baja.",
  "darme de baja",
  "dar de baja la suscripcion",
  "quiero dar de baja la suscripcion",
  // Pronome PRESO ao infinitivo — a construção mais comum de pedir
  // descadastro em espanhol, e a que não casava padrão nenhum até este PR.
  // Diferente do português, onde o pronome vem solto ANTES do verbo.
  "deja de escribirme",
  "dejen de mandarme mensajes",
  "deja de enviarme promociones",
  "para de escribirme",
  "para de mandarme mensajes",
  "deja de escribirme por favor",
  "deja de escribir",
  // Objeto SUSTANTIVO em vez de verbo — "no quiero más mensajes" não tem
  // verbo de comunicação depois de "no quiero", então o padrão geral (que
  // exige verbo) não pega. Espelho de "não quero mais mensagem/contato".
  "no quiero mas mensajes",
  "no quiero mas publicidad",
  "ya no quiero mas promociones",
  "no quiero mas nada de ustedes",
  // Imperativo com pronome preso — como a pessoa responde de fato à
  // plantilla "Respondé BAJA".
  "dame de baja",
  "denme de baja",
  // `contactar`, que faltava na lista de verbos de comunicação.
  "no me contacten mas",
  // CONTROLE do lookahead da #435: quando o objeto É a comunicação, a regra
  // segue valendo. O lookahead exclui uma lista fechada, não apaga o padrão.
  "no me manden mas mensajes",
  "no me escriban mas",
  "no me llamen mas",
  "no quiero que me contacten",
  "borrame de tus contactos",
  "eliminame de la base de datos",
  // `salir` é o `sair` em espanhol, e `sair` já estava na lista em português.
  // Faltava, e a promessa do CHANGELOG da 1.4.0 ("`baja`, `salir` e
  // `no quiero recibir` descadastram") era falsa exatamente nesta palavra —
  // medido com as funções reais antes do conserto: `baja` true, `salir` false.
  "salir",
  "SALIR",
  "Salir.",
  "no quiero recibir mas mensajes",
  "no quiero recibir más mensajes",
  "por favor no me escriban mas",
  "me desuscribo",
  "sacame de la lista",
  "cancelar la suscripcion",
];

const ESPANHOL_NAO_PEDE = [
  // O caso que motivou os três estados: cliente ATIVO perguntando sobre pausar
  // o anúncio dele. Bloqueá-lo tiraria as mensagens de quem está comprando.
  "Doy de baja la pauta?",
  "che, la baja temporada nos mato las ventas",
  "necesito rebajar el precio",
  "Y el abuelo subiendo y bajando bolsones",
  "puedo cancelar el turno del martes?",
  // Troca de canal, não descadastro — o mesmo raciocínio da regra de "ligação".
  "no quiero recibir la factura por aqui, manda por email",
  // Outra lista. Quem escreve isto QUER continuar sendo atendido.
  "sacame de la lista de espera",
  // CONTROLE de `salir`: a palavra só vale SOZINHA. Sem estes casos, alguém
  // poderia "consertar" o positivo com um `includes("salir")` e a suíte ficaria
  // verde bloqueando quem só avisou que vai sair de casa.
  "voy a salir ahora",
  "puedo salir mas temprano?",
  "el pedido va a salir hoy?",
  // CONTROLE do lookahead novo de OBJETOS_NAO_COMUNICATIVOS: o mesmo achado
  // de "pare de mandar o pedido" (português), em espanhol. Sem o lookahead,
  // "deja de mandar el pedido a esa dirección" bloquearia um cliente que
  // está pedindo para mudar a ENTREGA, não para parar de ser atendido.
  "deja de mandar el pedido a esa direccion",
  "deja de cobrarme el envio",
  // O espelho espanhol da issue #435 — o objeto é a cobrança, não a conversa.
  "no me manden mas cobros duplicados",
  "no me manden mas facturas por correo",
  "no me manden mas paquetes a esa direccion",
  "no me mande mas boletas, ya pague",
  // OBJEÇÃO COMERCIAL — o buraco que faltava neste corpus, e por onde um
  // falso positivo entrou. `ESPANHOL_NAO_PEDE` tinha controle de clínica, de
  // e-commerce e de troca de canal, mas nenhum da recusa de VENDA: a frase
  // mais comum do funil, e a que o agente precisa contornar em vez de fugir
  // dela. Sem estes casos, `no me interesa` nu escalava para humano e a
  // suíte ficava verde.
  "no me interesa",
  "no me interesa, gracias",
  "no me interesa ese plan, pero si el otro",
  "por ahora no me interesa, quizas el mes que viene",
  "no me interesa el seguro, quiero solo el producto",
  "la verdad no me interesa el precio, me interesa la calidad",
  "no me interesa pagar mas, hay algo mas barato?",
];

describe("espanhol — a palavra que a plantilla pede", () => {
  for (const texto of ESPANHOL_PEDE_PARA_SAIR) {
    it(`bloqueia: ${texto}`, () => {
      expect(ehPedidoDeOptOut(texto)).toBe(true);
    });
  }

  for (const texto of ESPANHOL_NAO_PEDE) {
    it(`NÃO bloqueia: ${texto}`, () => {
      expect(ehPedidoDeOptOut(texto)).toBe(false);
    });
  }
});

/**
 * O lado negativo do corpus verificava só o BLOQUEIO, e não a ESCALADA.
 *
 * São dois níveis com custos diferentes: `ehPedidoDeOptOut` grava
 * `is_blocked=true` e o contato para de ser atendido; `ehOptOutProvavel` faz o
 * agente parar de responder e chamar um humano. O segundo é mais barato, mas
 * não é grátis — num sistema de vendas ele desliga a automação exatamente na
 * objeção, que é o momento em que ela deveria trabalhar.
 *
 * Enquanto só o bloqueio era verificado, uma frase podia entrar na lista
 * ambígua e o corpus inteiro seguir verde: `ehPedidoDeOptOut` devolve `false`
 * para ela, que é tudo que se perguntava. Foi por essa porta que
 * `no me interesa` (sem marca de repetição) passou a escalar toda objeção
 * comercial em espanhol sem nenhum caso vermelhar.
 *
 * Medido ao escrever: com a regra corrigida, ZERO frases dos dois corpora
 * negativos escalam. O gate nasce verde e trava a volta.
 */
describe("o lado negativo também não pode ESCALAR, não só não bloquear", () => {
  for (const texto of [...ESPANHOL_NAO_PEDE, ...NAO_PEDE_PARA_SAIR]) {
    it(`não escala para humano: ${texto}`, () => {
      expect(ehOptOutProvavel(texto), texto).toBe(false);
    });
  }
});

/**
 * O espanhol tinha ZERO frases ambíguas — `ehOptOutProvavel` nunca somava
 * nada além do inequívoco nesse idioma, e o comentário de `baja`/`salir` em
 * `deteccao.ts` chegou a afirmar que duas frases "caem no ambíguo" sem que
 * essa camada existisse para pegá-las. Espelha o corpus português de baixo
 * ("me deixa em paz", "já disse que não quero", "para com isso") — mesma
 * forma, outra língua.
 */
describe("espanhol — o ambíguo, que não existia", () => {
  it.each([
    "déjame en paz",
    "déjenme en paz",
    "ya te dije que no me interesa",
    "ya no me interesa",
    // CONTROLE do lado positivo: o marcador de repetição é o que separa o
    // sinal da objeção. "ya" numa, "mas" na outra — sem nenhum dos dois, a
    // frase está em `ESPANHOL_NAO_PEDE`, acima.
    "no me interesa mas",
    "ya no me interesa nada de esto",
    "basta ya",
    "ya basta con esto",
    "no me molesten",
  ])("reconhece o sinal ambíguo: %s", (texto) => {
    expect(ehOptOutProvavel(texto)).toBe(true);
  });

  it("o ambíguo em espanhol também NÃO autoriza bloqueio por si só", () => {
    expect(ehOptOutProvavel("déjame en paz")).toBe(true);
    expect(ehPedidoDeOptOut("déjame en paz")).toBe(false);
  });
});

describe("ehPedidoDeOptOut — pedido INEQUÍVOCO, o que autoriza bloquear", () => {
  it.each(PEDE_PARA_SAIR)("respeita o pedido: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `deveria ter reconhecido "${texto}"`).toBe(true);
  });

  it.each(NAO_PEDE_PARA_SAIR)("não bloqueia quem não pediu: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `bloquearia "${texto}" sem pedido`).toBe(false);
  });

  it("texto ausente não é pedido de nada", () => {
    expect(ehPedidoDeOptOut(null)).toBe(false);
    expect(ehPedidoDeOptOut(undefined)).toBe(false);
  });

  it("a palavra precisa estar SOZINHA para valer por si", () => {
    // É o coração da correção: a mesma palavra, dois significados. Se algum dia
    // este par voltar a dar o mesmo resultado, a regra regrediu para "caçar
    // palavra" — que é o defeito, não a solução.
    expect(ehPedidoDeOptOut("parar")).toBe(true);
    expect(ehPedidoDeOptOut("tem como parar a dor?")).toBe(false);
  });

  it("cancelar sozinho sai; cancelar UMA COISA fica", () => {
    expect(ehPedidoDeOptOut("cancelar")).toBe(true);
    expect(ehPedidoDeOptOut("quero cancelar o pedido")).toBe(false);
  });
});

describe("ehOptOutProvavel — soma o ambíguo, para parar de responder e escalar", () => {
  it("todo pedido inequívoco também é provável", () => {
    for (const texto of PEDE_PARA_SAIR) {
      expect(ehOptOutProvavel(texto), texto).toBe(true);
    }
  });

  it.each(["me deixa em paz", "já disse que não quero", "para com isso"])(
    "reconhece o sinal ambíguo: %s",
    (texto) => {
      expect(ehOptOutProvavel(texto)).toBe(true);
    },
  );

  it("o ambíguo NÃO autoriza bloqueio por si só", () => {
    // A assimetria é a política: silenciar alguém para sempre é decisão de
    // pessoa. O ambíguo para o robô e chama o humano; quem bloqueia é ele.
    expect(ehOptOutProvavel("me deixa em paz")).toBe(true);
    expect(ehPedidoDeOptOut("me deixa em paz")).toBe(false);
  });

  it("não confunde troca de canal com descadastro", () => {
    // "não quero receber ligação, só whatsapp" QUER continuar recebendo aqui.
    expect(ehPedidoDeOptOut("não quero receber ligação, só whatsapp")).toBe(false);
    expect(ehOptOutProvavel("não quero receber ligação, prefiro mensagem")).toBe(false);
  });
});

/**
 * ═══ O CALL SITE, e não só a regra ═══
 *
 * `detectAmbiguousOptOut` (o runtime do agente) e a ingestão respondiam a MESMA
 * pergunta com DUAS regras diferentes — e a divergência é o defeito que este PR
 * conserta: a ingestão bloqueava paciente que perguntou como parar a dor.
 *
 * Medido: revertendo SÓ `lib/agent-engine/agent/human-handoff.ts` para a versão
 * antiga (que reintroduz as constantes inline), a suíte INTEIRA fica verde —
 * 458 arquivos, 5123 casos, exit 0. Ou seja: nada guardava a religação, e a
 * divergência podia voltar sem um único vermelho.
 *
 * Os casos abaixo são de COMPORTAMENTO, não de texto: as duas frases só
 * respondem certo pela regra nova. Um `expect(fonte).toContain("import")` casaria
 * o símbolo e não o comportamento — e símbolo não é comportamento.
 */
describe("o runtime do agente usa a MESMA regra da ingestão", () => {
  it("'parar de receber' é opt-out provável — a regra antiga do runtime não pegava", async () => {
    const { detectAmbiguousOptOut } = await import("@/lib/agent-engine/agent/human-handoff");
    expect(detectAmbiguousOptOut("parar de receber")).toBe(true);
    expect(detectAmbiguousOptOut("pare de me mandar mensagem")).toBe(true);
  });

  it("'tem como parar a dor?' NÃO é opt-out — é o falso positivo que motivou o conserto", async () => {
    const { detectAmbiguousOptOut } = await import("@/lib/agent-engine/agent/human-handoff");
    expect(detectAmbiguousOptOut("tem como parar a dor?")).toBe(false);
    expect(detectAmbiguousOptOut("posso sair antes das 15h?")).toBe(false);
  });
});

/**
 * ═══ CLÍNICA (CRM EvaLink) — as frases do pedido de porte, ao pé da letra ═══
 *
 * As listas de cima vieram do projeto original e ficam iguais às dele, para o
 * próximo porte aplicar sem conflito. Este bloco é do fork: as seis frases que o
 * dono do produto nomeou, na grafia SEM acento em que o paciente digita no
 * celular, medidas nos dois níveis (bloquear e escalar).
 *
 * "parar de tomar o remédio faz mal?" já não bloqueava antes do porte — `tomar`
 * nunca foi verbo de comunicação. Está aqui como CONTROLE, não como prova do
 * conserto: é a frase de clínica que qualquer alargamento futuro de
 * `VERBOS_DE_COMUNICACAO` bloquearia primeiro.
 */
describe("clínica — as frases que o porte prometeu, sem acento como no celular", () => {
  it.each(["nao me contate mais", "nao entrem mais em contato", "pode me remover da lista"])(
    "bloqueia: %s",
    (texto) => {
      expect(ehPedidoDeOptOut(texto)).toBe(true);
      expect(ehOptOutProvavel(texto)).toBe(true);
    },
  );

  it.each([
    "quero sair da lista de espera",
    "meu filho nao me liga mais",
    "parar de tomar o remedio faz mal?",
    "parar de tomar o remédio faz mal?",
  ])("NÃO bloqueia nem escala: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto)).toBe(false);
    expect(ehOptOutProvavel(texto)).toBe(false);
  });
});

/**
 * ═══ REVISÃO DO PORTE (CRM EvaLink, PR 125) — o que as frases novas pegavam a mais ═══
 *
 * No CRM EvaLink o bloqueio custa mais do que no projeto original: além de
 * `is_blocked`, o pedido de parar fecha todo negócio aberto do paciente como
 * perdido (`lib/channels/pos-entrada.ts`). E o nível de baixo também não é de
 * graça: a suspeita de opt-out avisa o paciente de que os envios pararam,
 * silencia o agente e cancela os follow-ups. Por isso são TRÊS listas, e cada
 * frase foi medida nos dois níveis com a função da `main` e a do PR lado a lado.
 *
 * (1) RESTRIÇÃO, RELATO e DUPLA NEGAÇÃO — o paciente quer continuar sendo
 *     atendido. Todas davam `false` na main e `true` no PR antes desta revisão.
 */
const QUER_CONTINUAR_SENDO_ATENDIDO = [
  // dupla negação: "não deixe de" é pedir o contato
  "Se abrir vaga antes, não deixe de entrar em contato",
  "nao deixem de entrar em contato se tiver desistencia",
  // `entre` é também o subjuntivo de quem escreve ("caso eu não entre")
  "Caso eu nao entre em contato ate sexta pode liberar meu horario",
  "talvez eu não entre em contato essa semana, estou viajando",
  // relato em primeira pessoa, com o infinitivo
  "desculpa deixar de entrar em contato, tive um imprevisto",
  // restrição de HORÁRIO
  "por favor não entre em contato antes das 9h",
  "não entre em contato antes das 8",
  "peço que não entrem em contato hoje, estou internada",
  "não entrem em contato hoje, estou em cirurgia",
  "não entrem em contato de madrugada",
  "nao me liguem mais de manha, so a tarde",
  "nao me contatem mais nesse horario",
  "não me liguem mais nesse horário",
  // troca de NÚMERO: a frase diz que existe outro
  "não entre em contato nesse numero, mudei de telefone",
  "não me escreva mais nesse número, uso o outro agora",
  // troca de CANAL — o mesmo precedente de "não quero receber ligação, só whatsapp"
  "não me contate mais por ligação, só mensagem",
  "não me contate mais por telefone, só whatsapp",
  "não me liguem mais, prefiro whatsapp",
  // "chamar DE" é tratamento, não contato
  "não me chamem mais de dona, pode ser só Maria",
  // `molesta` é 3ª pessoa descritiva: quem não molesta mais é a dor
  "o refluxo nao me molesta mais",
  "a dor não me molesta mais",
  // INFINITIVO depois de "não me" é relato de terceiro, não ordem
  "meu ex prometeu não me ligar mais",
  "pedi pro laboratório não me enviar mais o resultado por email",
  "decidi não me perturbar mais com isso",
  // terceiro de quem o paciente RECLAMA: não é a clínica, e não é vocativo
  "o plano não me manda mais a carteirinha",
  "o laboratório não me envia mais o resultado",
];

/**
 * (2) Pedidos CLAROS que o freio comia. As de lista bloqueavam na main e no PR
 *     não bloqueavam nem escalavam; as de "em contato" são a frase que o porte
 *     anunciou, com o complemento mais comum do WhatsApp (sem vírgula).
 */
const PEDIDO_CLARO_QUE_O_FREIO_COMIA = [
  "me tira da lista de marketing",
  "me tira da lista de propaganda",
  "me tire da lista de mensagem",
  "me tira da lista de msg",
  "me remove da lista de e-mails",
  "quero sair da lista de clientes",
  "me tira da lista de pacientes",
  "não entrem mais em contato por favor",
  "não entre mais em contato por gentileza",
  "não entrem mais em contato com esse número",
  "não entrem mais em contato pelo amor de deus",
  "parem de entrar em contato por favor",
  // CONTROLES do freio de restrição: ele não pode engolir o pedido inteiro.
  "não me mande mais mensagem por favor",
  "não me liga mais de jeito nenhum",
  "não me chamem mais de jeito nenhum",
  "nao me chamem mais nesse numero",
  "se eu quiser eu ligo, não entrem mais em contato",
  "podem parar de entrar em contato",
  // o infinitivo saiu de "não me X mais" (é relato de terceiro), MENOS depois
  // de quem pede: esta é a forma educada do pedido, e o PR já a bloqueava.
  "favor não me enviar mais mensagens",
  "peço para não me ligar mais",
];

/**
 * (3) O que a regra NÃO sabe decidir sozinha: não bloqueia, mas para o agente e
 *     chama uma pessoa. Antes desta revisão as três famílias caíam no vazio —
 *     nem bloqueavam nem escalavam.
 */
const UMA_PESSOA_DECIDE = [
  // condição: pode ser "se eu faltar" ou pode ser "se eu quiser eu procuro"
  "se eu não confirmar, não entre em contato",
  "caso eu falte, não entrem em contato",
  // sujeito que pode ser vocativo ("meu amigo") ou a própria clínica
  "meu amigo não me manda mais mensagem",
  "meu anjo não me liga mais",
  "essa clínica não me manda mais nada",
  "esse número não me liga mais",
  // lista que não é de envio conhecida nem de clínica conhecida
  "me tira da lista de aniversariantes",
  "quero sair da lista de vip",
];

describe("revisão do porte — restrição, relato e dupla negação não são pedido de parar", () => {
  it.each(QUER_CONTINUAR_SENDO_ATENDIDO)("NÃO bloqueia nem escala: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `bloquearia "${texto}"`).toBe(false);
    expect(ehOptOutProvavel(texto), `escalaria "${texto}"`).toBe(false);
  });
});

describe("revisão do porte — o freio não engole pedido claro", () => {
  it.each(PEDIDO_CLARO_QUE_O_FREIO_COMIA)("bloqueia: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `deveria ter reconhecido "${texto}"`).toBe(true);
  });
});

describe("revisão do porte — na dúvida, quem decide é uma pessoa", () => {
  it.each(UMA_PESSOA_DECIDE)("não bloqueia, mas escala: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `bloquearia "${texto}"`).toBe(false);
    expect(ehOptOutProvavel(texto), `deixaria passar "${texto}"`).toBe(true);
  });
});

/**
 * ═══ RECUSAR UMA COISA NÃO É PEDIR PARA SAIR (CRM EvaLink, 12/10/2026) ═══
 *
 * Achado lendo e rodando a regra fora do ar: `ehPedidoDeOptOut` devolvia `true`
 * para "não quero receber o resultado por e-mail, prefiro buscar aí" e para
 * "não quero receber anestesia geral". Nas duas a paciente recusa UMA coisa (o
 * canal de entrega de um exame; um procedimento) e a ingestão gravaria
 * `is_blocked`, fecharia o negócio como perdido e calaria lembrete e resposta.
 *
 * A causa é a mesma de "pare de mandar o pedido" e de "não me mande mais
 * boletos", pela terceira vez: a regra ancorava no VERBO ("receber") e tratava
 * o objeto por lista de EXCEÇÃO (só "ligação" escapava). O mundo do que uma
 * paciente pode não querer receber é aberto; o do que é a mensagem da clínica é
 * fechado. A regra agora exige o objeto de comunicação, e são três listas:
 *
 * (1) o objeto é outra coisa, outro canal ou outro horário: segue com o agente.
 */
const RECUSA_OUTRA_COISA = [
  // as duas frases do achado
  "não quero receber o resultado por e-mail, prefiro buscar aí",
  "não quero receber anestesia geral",
  // a mesma família: procedimento, visita, documento, alta
  "não quero receber visita",
  "não quero receber visitas no hospital",
  "não quero receber o boleto por correio",
  "não quero receber alta ainda",
  "não quero receber o exame pelo correio",
  "não gostaria de receber sedação",
  "não desejo receber transfusão de sangue",
  // "mais" não muda o objeto: segue sendo a visita e a anestesia
  "não quero mais receber visita",
  "não quero receber mais anestesia",
  "não quero receber nada de anestesia",
  "quero parar de receber visita",
  // outro verbo: nunca bloquearam, ficam como controle
  "não quero mais tomar o remédio",
  "não quero mais fazer o procedimento",
  // outro CANAL: o contato bloqueado é o do WhatsApp, e quem recusa e-mail,
  // SMS ou ligação não pediu para sair dele
  "não quero receber ligação, pode mandar mensagem",
  "prefiro não receber por e-mail, manda no WhatsApp",
  "não quero receber e-mail",
  "não quero receber e-mail, manda por aqui",
  "não quero mais receber e-mail de vocês",
  "não quero receber sms",
  "não quero receber mensagens por e-mail, só por aqui",
  "não quero receber nada por e-mail",
  // outro HORÁRIO
  "não quero receber mensagem de madrugada",
  // o irmão com verbo de cessação: o que se manda parar é o documento por e-mail
  "para de me mandar o resultado por e-mail",
  "pare de mandar o exame por e-mail, eu busco aí",
  "pode parar de me mandar o resultado, já peguei",
  "não me mande mais o resultado por e-mail",
  // ── espanhol ──
  "no quiero recibir anestesia general",
  "no quiero recibir el resultado por correo, prefiero buscarlo",
  "no quiero recibir visitas",
  "no quiero recibir el alta todavia",
  "no quiero recibir mas anestesia",
  "ya no quiero recibir visitas",
  "no quiero recibir llamadas, escribime por aca",
  "no quiero recibir mensajes por correo",
  "deja de mandarme el resultado por correo",
  // "no quiero" + o que a PRÓPRIA pessoa faria: o padrão espanhol aceitava
  // qualquer verbo de comunicação depois de "no quiero", e a frase de cortesia
  // mais comum do idioma bloqueava
  "no quiero molestar, pero tengo una duda",
  "no quiero llamar tan tarde",
  "no quiero escribir mal su nombre",
  "no quiero mandar la foto por aqui",
];

/**
 * (2) O objeto É a mensagem da clínica, ou não há objeto e a cessação está
 *     escrita ("mais"): continua bloqueando. É a metade que não pode se perder,
 *     porque pedido de parar ignorado é descumprimento da LGPD.
 *
 *     Propaganda e promoção BLOQUEIAM: o produto só tem `is_blocked` para o
 *     contato inteiro, e a doutrina já tratava "me tira da lista de marketing"
 *     e "no quiero mas publicidad" como pedido de sair.
 */
const RECUSA_A_MENSAGEM_DA_CLINICA = [
  "não quero receber mensagens",
  "não quero receber mensagem",
  "não quero mais receber nada de vocês",
  "não quero receber nada",
  "não quero mais receber",
  "nao quero receber mais",
  "não quero receber mais não",
  "não quero mais receber, obrigado",
  "não quero receber propaganda",
  "não quero receber promoção",
  "não quero mais receber essas promoções",
  "não quero receber mais nenhuma mensagem de vocês",
  "não desejo mais receber mensagens",
  "não gostaria de receber mais mensagens",
  "não quero receber mensagens no whatsapp",
  "não quero receber mensagens por aqui",
  "não quero receber nada desse número",
  // "só ligação" não é restrição aqui: a mensagem deste canal foi recusada
  "não quero mais receber mensagens, só ligação",
  "quero parar de receber mensagens",
  "para de me mandar mensagem",
  "pare de mandar essas fotos",
  // ── espanhol ──
  "no quiero recibir mensajes",
  "no quiero recibir mas mensajes",
  "no quiero recibir mas",
  "ya no quiero recibir mas",
  "no quiero recibir nada",
  "no quiero recibir publicidad",
  "no quiero recibir mas promociones",
  "no deseo recibir mas mensajes",
  "ya no quiero recibir mensajes de ustedes",
];

/**
 * (3) Nem uma coisa nem outra: sem objeto e sem "mais" (pode ser a resposta a
 *     "quer receber o resultado por e-mail?"), "isso", ou UM tipo de mensagem
 *     (lembrete, aviso, áudio). Não bloqueia; para o agente e chama uma pessoa.
 */
const RECUSA_QUE_UMA_PESSOA_DECIDE = [
  "não quero receber",
  "não quero receber, obrigada",
  "não quero receber isso",
  "não quero receber lembrete",
  "não quero mais receber lembretes",
  "não quero receber esses avisos",
  "não quero receber áudio",
  // ── espanhol ──
  "no quiero recibir",
  "no quiero recibir eso",
  "no quiero recibir recordatorios",
];

describe("recusar uma coisa não é pedir para sair", () => {
  it.each(RECUSA_OUTRA_COISA)("NÃO bloqueia nem escala: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `bloquearia "${texto}"`).toBe(false);
    expect(ehOptOutProvavel(texto), `escalaria "${texto}"`).toBe(false);
  });

  it.each(RECUSA_A_MENSAGEM_DA_CLINICA)("bloqueia: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `deveria ter reconhecido "${texto}"`).toBe(true);
  });

  it.each(RECUSA_QUE_UMA_PESSOA_DECIDE)("não bloqueia, mas escala: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `bloquearia "${texto}"`).toBe(false);
    expect(ehOptOutProvavel(texto), `deixaria passar "${texto}"`).toBe(true);
  });

  it("o runtime do agente responde igual à ingestão nas duas frases do achado", async () => {
    const { detectAmbiguousOptOut } = await import("@/lib/agent-engine/agent/human-handoff");
    expect(detectAmbiguousOptOut("não quero receber o resultado por e-mail, prefiro buscar aí")).toBe(false);
    expect(detectAmbiguousOptOut("não quero receber anestesia geral")).toBe(false);
    expect(detectAmbiguousOptOut("não quero receber mensagens")).toBe(true);
  });
});

/**
 * ═══ AS QUATRO FRASES DE CLÍNICA QUE PASSAVAM EM BRANCO (CRM EvaLink, 14/10/2026) ═══
 *
 * O corpus do Jev (`scripts/lib/jev-frases-de-clinica.ts`) tem 12 pedidos de
 * sair escritos como uma paciente escreve. A regra pegava 8; estas 4 davam
 * "nada": nem bloqueavam, nem chamavam uma pessoa. Cada uma ganhou um padrão
 * estreito, e cada padrão tem ao lado os controles do que ele NÃO pode pegar.
 */
const CLINICA_PEDE_PARA_SAIR_E_PASSAVA = [
  // "chega de/dessas" + a mensagem da clínica, no começo da oração
  "chega dessas mensagens toda semana",
  "chega de mensagem",
  "nossa, chega dessas promoções",
  // "tirar meu número/contato" + daí, de vocês, do cadastro
  "pode tirar meu número daí?",
  "remove meu contato do cadastro de vocês",
  "tira meu telefone daqui por favor",
  // "não precisa mais me mandar" + a mensagem
  "já fiz o procedimento em outro lugar, não precisa mais me mandar mensagem",
  "não precisa me enviar mais mensagens",
  // "não quero mais ser avisada/contatada", sem dizer de quê
  "remove meu contato do cadastro de vocês, não quero mais ser avisada de nada",
  "não quero mais ser contatada",
  "não quero mais ser incomodada por vocês",
];

/** Dividem palavra com os padrões acima e NÃO são pedido de sair. */
const CLINICA_DIVIDE_PALAVRA_E_NAO_PEDE = [
  // chega
  "chega de dor, quero marcar logo a cirurgia",
  "chega de exame, doutora, quando eu opero?",
  "o resultado chega de manhã ou à tarde?",
  "quando chega a mensagem com o endereço?",
  "a mensagem chega de qual número?",
  "chega de mensagem de madrugada, pode mandar de dia",
  // tirar meu número
  "pode tirar meu número antigo do cadastro? agora uso esse",
  "remove meu telefone do cadastro e coloca o novo, por favor",
  "não tira meu número da lista de espera",
  "pode tirar meu número da lista de espera?",
  "pode remover meu contato do cadastro da minha filha?",
  "tem como tirar meu número do grupo da família?",
  "o dentista vai tirar meu dente daí?",
  // não precisa me mandar
  "não precisa me mandar mensagem, já recebi o endereço",
  "não precisa mais me mandar o resultado, já peguei aí",
  "não precisa mais me mandar mensagem por e-mail, prefiro aqui",
  "a doutora disse que não precisa mais tomar o remédio",
  // ser avisada
  "não quero mais ser avisada por e-mail, só pelo whatsapp",
  "não quero mais ser atendida pela doutora Ana",
  "não quero ser avisada em cima da hora",
  "não quero mais ser avisada da consulta de sábado, eu desmarquei",
  "não quero mais ser chamada de dona",
];

/** Um TIPO de mensagem: não bloqueia, mas uma pessoa decide (como "não quero receber lembrete"). */
const CLINICA_RECUSA_UM_TIPO = ["chega desses lembretes", "chega de áudio"];

describe("clínica — os pedidos de sair que o corpus do Jev achou em branco", () => {
  it.each(CLINICA_PEDE_PARA_SAIR_E_PASSAVA)("bloqueia: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `deveria ter reconhecido "${texto}"`).toBe(true);
  });

  it.each(CLINICA_DIVIDE_PALAVRA_E_NAO_PEDE)("NÃO bloqueia nem escala: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `bloquearia "${texto}"`).toBe(false);
    expect(ehOptOutProvavel(texto), `escalaria "${texto}"`).toBe(false);
  });

  it.each(CLINICA_RECUSA_UM_TIPO)("não bloqueia, mas escala: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto), `bloquearia "${texto}"`).toBe(false);
    expect(ehOptOutProvavel(texto), `deixaria passar "${texto}"`).toBe(true);
  });

  it("o corpus inteiro do Jev: todo 'sim' bloqueia, todo 'não' fica quieto", () => {
    const erros = FRASES_DE_CLINICA.flatMap((f) => {
      if (f.opt_out === "sim" && !ehPedidoDeOptOut(f.texto)) return [`não bloqueia: ${f.texto}`];
      if (f.opt_out === "nao" && ehOptOutProvavel(f.texto)) return [`escala: ${f.texto}`];
      return [];
    });
    expect(erros).toEqual([]);
  });

  it("o runtime do agente lê a mesma regra", async () => {
    const { detectAmbiguousOptOut } = await import("@/lib/agent-engine/agent/human-handoff");
    expect(detectAmbiguousOptOut("pode tirar meu número daí?")).toBe(true);
    expect(detectAmbiguousOptOut("o resultado chega de manhã ou à tarde?")).toBe(false);
  });
});

// Portado de melgarafael/DeskcommCRM ffeca5ba1 (autor: Paulo Lima Jr).
describe("comecaComPalavraDeSaida — qual frase o cliente lê quando a IA sai de campo", () => {
  it("'Parar não é daqui' começa com a palavra de saída — o caso medido em produção", () => {
    expect(comecaComPalavraDeSaida("Parar não é daqui")).toBe(true);
    // ...e NÃO autoriza bloqueio: é por isso que ele ficou sem bloqueio.
    expect(ehPedidoDeOptOut("Parar não é daqui")).toBe(false);
  });

  it("as palavras que o rodapé das abordagens oferece, em qualquer caixa e com pontuação", () => {
    for (const t of ["PARAR", "parar.", "¿Parar?", "Pare de me mandar", "STOP!", "Baja", "  stop  "]) {
      expect(comecaComPalavraDeSaida(t), t).toBe(true);
    }
  });

  it("só o INÍCIO conta: pergunta de paciente e conversa comum não casam", () => {
    for (const t of [
      "tem como parar a dor?",
      "quero saber se dá para parar o tratamento",
      "oi, tudo bem?",
      "não paro de pensar nisso",
      "",
      "   ",
      "123 !!!",
    ]) {
      expect(comecaComPalavraDeSaida(t), t).toBe(false);
    }
  });

  it("nenhuma frase de controle do corpus casa — o mesmo lado negativo que protege o bloqueio", () => {
    // Sem isto, "pare de mandar o pedido nesse endereco" (cliente irritado com a
    // entrega, candidato natural a `low_sentiment`) lia "Encerro os envios
    // automáticos deste canal agora mesmo".
    const casam = [...NAO_PEDE_PARA_SAIR, ...ESPANHOL_NAO_PEDE].filter((t) => comecaComPalavraDeSaida(t));
    expect(casam).toEqual([]);
    for (const t of [
      "Parar de tomar o remédio faz mal?",
      "Parar o tratamento agora é ruim?",
      "Pare de doer o dente, quando?",
    ]) {
      expect(comecaComPalavraDeSaida(t), t).toBe(false);
    }
  });

  it("texto ausente é falso, sem lançar", () => {
    expect(comecaComPalavraDeSaida(null)).toBe(false);
    expect(comecaComPalavraDeSaida(undefined)).toBe(false);
  });
});
