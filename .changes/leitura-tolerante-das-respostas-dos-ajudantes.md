---
impacto: nada_mudou
secao: corrigido
titulo: A IA entende as respostas repetidas ou em lista dos seus ajudantes em todos os pontos
---

Alguns modelos de IA devolvem a resposta pedida duas vezes seguidas, ou dentro
de uma lista. Em parte do sistema isso já era tratado; nos pontos que faltavam
a resposta era lida como erro.

Faltavam o resumo que a IA grava no fim de cada atendimento, a escolha do
caminho do follow-up, o detector de tentativa de manipular a IA, o detector de
promessa fora da tabela e a sugestão de funil do primeiro acesso. Neles, uma
resposta perfeita, só que repetida, fazia o resumo ser refeito, o follow-up
perder a classificação ou o detector deixar passar um aviso.

Agora todos leem a primeira resposta válida. Quando não há resposta legível,
o comportamento é o mesmo de antes.

Portado do projeto original (DeskcommCRM, trabalho de webtecnica e melgarafael).
