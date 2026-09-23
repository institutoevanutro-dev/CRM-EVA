---
impacto: capacidade_nova
secao: corrigido
titulo: O teste do agente não é mais cortado pelo proxy, e o e-mail de acesso aponta para o app
---
Três coisas que já estavam consertadas na instalação de um cliente, mas não no produto: o botão Testar de um agente era cortado pelo proxy depois de a resposta já ter sido gerada (e paga); o script que configura os e-mails de acesso mandava tudo num pedido só, e num projeto Supabase de plano gratuito o pedido inteiro era recusado — derrubando junto o endereço do app, que é o que faz o link de "esqueci minha senha" funcionar; e o teto de memória do worker agora é uma variável do .env (WORKER_MEM_LIMIT), em vez de exigir editar um arquivo que a próxima atualização desfaz.
