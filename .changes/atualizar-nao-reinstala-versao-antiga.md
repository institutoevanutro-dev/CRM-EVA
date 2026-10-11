---
impacto: nada_mudou
secao: corrigido
titulo: Atualizar deixa de reinstalar, por alguns instantes, versões antigas de funções e regras de acesso
---
A cada atualização o banco voltava, por alguns instantes, a versões antigas de 56 funções e de 21 regras de acesso, e só depois recebia as atuais. Nesse intervalo valiam regras mais frouxas: por exemplo, a função que registra eventos não conferia a organização de quem chamava, a busca na base de conhecimento não conferia que quem lia era da organização, e a anonimização de um contato apagava menos dados do que apaga hoje. Agora cada função e cada regra entra uma vez só, já na versão atual. A atualização também para de derrubar e recriar cerca de 700 regras de acesso que já estavam certas, de refazer a coluna da agenda que marca o que falta enviar ao Google (o que reescrevia a tabela de agendamentos toda vez) e de deixar tabelas um instante sem gatilho ou sem validação. O resultado final no banco é o mesmo de antes e nada precisa ser feito ao atualizar.
