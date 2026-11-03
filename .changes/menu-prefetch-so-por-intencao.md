---
impacto: nada_mudou
secao: alterado
titulo: O menu pede a tela só quando alguém vai para ela
---

Cada item visível do menu lateral fazia o servidor montar aquela tela de antemão (conferir a sessão, carregar quem está logado e rodar as consultas da casca do sistema) a cada carga de página e depois de cada atualização, e esses pedidos disputavam o servidor com a tela que a pessoa de fato clicou. Agora o menu pede a tela só quando o ponteiro chega ao item, num toque ou no foco pelo teclado, uma vez por destino. Nada muda no que a tela mostra; muda quanto ela pede antes de alguém pedir.

Portado do projeto original (DeskcommCRM, PR #3613 de @webtecnica).
