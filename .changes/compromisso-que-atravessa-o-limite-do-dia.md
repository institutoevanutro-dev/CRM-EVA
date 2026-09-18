---
impacto: nada_mudou
secao: corrigido
titulo: O compromisso do Google que atravessa a borda do período volta a aparecer na grade
---
O compromisso do Google Agenda que começa antes do período que a tela desenha e termina dentro dele — das 23:30 às 00:30, por exemplo — passa a aparecer quando atravessa a borda desse período: a virada da semana na visão Semana, a virada do mês na visão Mês e toda meia-noite na visão Dia. Ele entra fatiado no pedaço que cai dentro do período. Antes, a grade perguntava pelo começo do compromisso e só desenhava os que começavam dentro do período: o horário que a tela mostrava livre era recusado na hora de marcar. A tela e a rota que a alimenta passam a usar a mesma conta do motor de disponibilidade (interseção de intervalos), lida de um só lugar. Para quem lê a lista pela API, o bloco do Google passa a vir recortado no período pedido — o instante de começo nunca é anterior ao período, e o de fim nunca é posterior. Fora isso, nada mudou: a grade continua recebendo apenas identificador, dono e os dois instantes, nunca o conteúdo do evento.
