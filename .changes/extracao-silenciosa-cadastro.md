---
impacto: capacidade_nova
secao: adicionado
titulo: Leitura do cadastro nas conversas atendidas pela equipe
---

Quando a equipe atende pelo celular e o cliente manda CPF, e-mail, data de nascimento ou endereço, o CRM pode ler esses dados sozinho e preencher a ficha do contato. Só preenche campo vazio: se a ficha já tem um valor diferente, nada é trocado, o dado vira uma sugestão na ficha (confirmar ou recusar) e aparece um aviso na Central. Nenhuma mensagem é enviada ao cliente e a IA continua parada na conversa. Grupos, contatos bloqueados e anonimizados ficam de fora. O que entra sozinho aparece na linha do tempo do contato (quando ele tem um negócio aberto) e na auditoria, sem o valor do dado. O CPF continua guardado só cifrado, inclusive na sugestão, que mostra apenas os dois últimos dígitos. O endereço usa uma chamada curta de IA, só quando a mensagem tem cara de endereço, e o custo aparece em IA › Uso como "Ler o endereço que o cliente mandou".

Vem desligado. Para ligar: Configurações › Atendimento › "Ler o cadastro que o cliente manda nas conversas atendidas pela equipe" (só administrador). A atualização acrescenta ao banco a sugestão de CPF e endereço e um tipo de aviso (migration 0407), aplicados pelo `update.sh` como de costume.
