---
impacto: nada_mudou
secao: corrigido
titulo: A limpeza dos registros antigos de webhooks e de formulários passa a apagar de verdade
---

O sistema guarda por um tempo o registro técnico do que chega por webhook e o
histórico dos formulários de captação (nome, telefone e mensagem de quem
preencheu). Passado o prazo, uma limpeza automática deveria apagar esses
registros. Dependendo da versão do banco de dados, o banco recusava o pedido de
apagar e o erro não aparecia em lugar nenhum: os dados ficavam guardados além
do prazo e o banco só crescia.

Agora a limpeza apaga em lotes pequenos, em qualquer versão do banco de dados,
para nunca travar a chegada de mensagens. Se um dia ela falhar, a falha fica
registrada no log a cada tentativa e na auditoria uma vez por dia, em vez de
passar em silêncio. A primeira limpeza depois da atualização
pode ter bastante coisa acumulada e vai apagando aos poucos. Você não precisa
fazer nada.

Portado do projeto original (DeskcommCRM PRs 1721 e 1769, de @webtecnica).
