---
impacto: nada_mudou
secao: corrigido
titulo: Com o EvaLink ligado, Sair encerra também a sessão da Conta neste navegador
---
Antes, o "Sair" do CRM apagava só a sessão do CRM. Num computador compartilhado, a próxima pessoa
que clicasse em "Entrar com EvaLink" entrava como a anterior, sem senha. Agora o CRM manda o
navegador ao `/sair` da Conta, que encerra a sessão dela só neste navegador e devolve para o login
do CRM. Sem o EvaLink configurado, nada muda. Requer a Conta com a rota `/sair` (evalink-conta 2996743).
