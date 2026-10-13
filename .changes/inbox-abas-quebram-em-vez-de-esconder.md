---
impacto: nada_mudou
secao: corrigido
titulo: As abas de Conversas não ficam mais cortadas quando a coluna da lista está estreita
---
Na tela de Conversas, com a coluna da lista estreita (do mínimo de 240 px até o padrão de 272 px de uma janela de 1280 px), a faixa "Fila, Minhas, Todas, Mais" não cabia quando as contagens cresciam ou quando uma aba do "Mais" estava aberta ("Automático 267"). A faixa rolava para o lado sem nada avisar, e o "Mais" ficava cortado na borda. Agora, quando não cabe numa linha, o último item desce para uma segunda linha e tudo fica à vista. Onde cabia, nada muda. Nada a fazer na VPS. Porte do upstream melgarafael/DeskcommCRM#2766 (contribuição de @webtecnica), adaptado às abas deste fork.
