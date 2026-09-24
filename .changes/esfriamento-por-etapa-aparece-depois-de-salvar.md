---
impacto: nada_mudou
secao: corrigido
titulo: O valor de "esfria em (horas)" continua na tela depois de recarregar
---

O campo por etapa gravava e a tela voltava mostrando "padrão" — indistinguível
de "não salvou". O valor ia para o banco e ficava lá, invisível: o Radar já o
respeitava, mas ninguém tinha como conferir o que estava configurado.

Quem grava é o PATCH da etapa; quem repõe a tela depois do recarregamento é
outra leitura, com a lista de colunas escrita à mão — e o campo entrou só no
primeiro.

Agora a leitura devolve o valor, e um teste vigia as duas pontas do laço.
