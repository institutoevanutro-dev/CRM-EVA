---
impacto: nada_mudou
secao: corrigido
titulo: Atualizar o sistema deixa de causar erro 500 para quem está usando
---

Toda atualização reaplica o arquivo de estrutura do banco com o sistema no ar, um comando por vez. Num ponto desse arquivo a permissão de uma função usada em quase todas as tabelas era retirada de quem está logado, e só era devolvida milhares de linhas adiante. Nesse intervalo, que no banco real dura dezenas de segundos, qualquer tela ou ação de quem estava logado respondia erro 500: salvar um agendamento, abrir uma conversa, mover um card. Foi medido em 10/10/2026, num agendamento recusado no minuto exato de uma atualização.

Agora a retirada e a devolução acontecem no mesmo comando, e ninguém de fora vê o meio. O mesmo conserto foi aplicado aos outros pontos do arquivo com esse formato: 7 funções, 15 tabelas, 1 view e as permissões por coluna de contatos, credenciais de IA, fila interna e eventos de agenda.

A mesma medição achou o defeito no sentido contrário: permissões que não deveriam existir voltavam por um intervalo a cada atualização, como a leitura da tabela inteira de contatos (com o CPF protegido), da tabela de credenciais de IA (com a chave cifrada) e a escrita no registro de auditoria por quem está logado. Elas também deixam de voltar. E 18 regras de acesso antigas, do tipo "qualquer pessoa da organização vê e altera tudo" (em mensagens, conversas, contatos, funil e base de conhecimento, entre outras), deixam de ser recriadas e apagadas a cada atualização: enquanto existiam, o limite por papel e por responsável não valia dentro da própria organização.

As permissões ao fim da atualização são as mesmas de antes. A proteção vale já na primeira atualização que trouxer esta versão. Você não precisa fazer nada.

Continua existindo, e fica registrado para um próximo conserto: durante a atualização, 55 funções e 21 regras de acesso voltam por um intervalo à versão antiga antes de receber a atual, e a view que o sincronismo com o Google Agenda lê fica fora do ar por um instante. Enquanto isso não for resolvido, prefira atualizar fora do horário de atendimento.
