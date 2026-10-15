---
impacto: capacidade_nova
secao: adicionado
titulo: A etiqueta de cidade passa a seguir o endereço do contato
---

Quando a cidade do endereço estruturado de um contato muda (pelo prontuário ou por
qualquer outra gravação), o contato passa a ter a etiqueta "cidade: X" que corresponde
a ela, tirada do vocabulário de etiquetas da organização e gravada em caixa baixa, a
mesma grafia que a IA usa. Etiqueta de cidade diferente da do endereço é trocada, e a
troca aparece na linha do tempo dos negócios do contato. Cidade fora do vocabulário
não cria etiqueta nova; contato sem cidade no endereço não é tocado. Só age em
organizações que têm alguma etiqueta "cidade: ..." no vocabulário. Na atualização, os
contatos que já têm cidade no endereço recebem a etiqueta uma vez, sem disparar
automação. Migration 0362.
