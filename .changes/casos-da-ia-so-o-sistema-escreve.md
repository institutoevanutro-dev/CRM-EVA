---
impacto: nada_mudou
secao: corrigido
titulo: Casos da IA — só o sistema escreve, e cada atendente vê só os casos das conversas que pode ver
---

Quando a IA pede ajuda da equipe, ela abre um Caso com um resumo do atendimento.
Dois problemas foram fechados:

- Um usuário com algum conhecimento técnico conseguia, falando direto com o
  banco, reescrever o que a IA anotou num caso, incluir um registro falso na
  linha do tempo e até fazer o histórico dizer que alguém assumiu uma conversa
  que ninguém assumiu. Agora só o próprio sistema grava essas informações.
  Responder a um caso pela tela continua igual.
- Na tela IA › Casos, o atendente via título, resumo, nome e telefone de casos
  de conversas que ele não pode abrir. Agora a lista, o detalhe e a resposta ao
  caso seguem a mesma regra das conversas, escolhida em Configurações ›
  Atendimento: quem não vê a conversa não vê nem responde o caso dela. Gestor e
  administrador continuam vendo todos.

O que cada atendente passa a ver em IA › Casos depende dessa escolha:

- "Todos veem tudo": nada muda.
- "Os seus, mais os que ainda não têm dono" (o padrão): ele vê os casos das
  conversas dele e das que estão sem dono, como as que a IA atende sozinha.
  Deixa de ver os casos de conversas que já são de um colega.
- "Só os seus": ele vê apenas os casos das conversas dele. Os casos das
  conversas que a IA atende sozinha aparecem só para gestor e administrador.

Junto com isso:

- Assumir, transferir ou soltar uma conversa só é aceito de quem enxerga essa
  conversa. Antes, por fora das telas, um atendente conseguia assumir a conversa
  de um colega e, com isso, passar a ler o caso e as notas dela.
- O aviso "um atendimento espera decisão", que aparece na Central para toda a
  equipe, deixa de trazer o título do caso. Quem pode abrir o caso lê o título
  nele; quem não pode vê só o aviso.
- A aba Concluídos de IA › Casos abre com os 200 casos mais recentes e tem o
  botão "Carregar mais" para ver os anteriores. Assim ela abre rápido mesmo em
  clínicas com muito histórico, e nenhum caso antigo fica de fora.

Portado do projeto original (DeskcommCRM).
