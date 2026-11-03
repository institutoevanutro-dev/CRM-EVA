---
impacto: nada_mudou
secao: corrigido
titulo: O limite de tentativas do código de verificação em duas etapas vale também na troca de senha
---

Errar o código de seis dígitos da verificação em duas etapas três vezes seguidas pausa novas tentativas por um minuto, e quinze erros no mesmo dia pausam até as 21h (horário de Brasília), quando a contagem do dia zera. Antes, a tela de entrada contava os erros só num cookie do navegador, que dava para contornar, e a troca de senha não tinha limite nenhum. Agora as duas telas contam juntas, no servidor, por usuário e autenticador, e todo erro fica na trilha de auditoria, inclusive o da troca de senha, dizendo qual pausa fechou. Quem cai na pausa do dia vê nas duas telas que ela vai até as 21h, e não uma contagem de um minuto que se repete. Para entrar antes disso, a pessoa usa um código de recuperação em "Perdi acesso ao autenticador", ou quem administra o servidor remove o autenticador dela com `bash hostgator-setup-kit/reset-mfa.sh email-da-pessoa`; o autenticador cadastrado de novo começa a contagem do zero. Nenhuma configuração muda.

Portado do projeto original (DeskcommCRM, PR #3853 de @thinhnx128).
