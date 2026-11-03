---
impacto: nada_mudou
secao: corrigido
titulo: O limite de tentativas do código de verificação em duas etapas vale também na troca de senha
---

Errar o código de seis dígitos da verificação em duas etapas três vezes seguidas pausa novas tentativas por um minuto, e quinze erros no mesmo dia pausam até as 21h (horário de Brasília), quando a contagem do dia zera. Antes, a tela de entrada contava os erros só num cookie do navegador, que dava para contornar, e a troca de senha não tinha limite nenhum. Agora as duas telas contam juntas, no servidor, por usuário, e quem está bloqueado na troca de senha vê o aviso de muitas tentativas. Quem ficar bloqueado pelo resto do dia entra com um código de recuperação, em "Perdi acesso ao autenticador", e depois cadastra o autenticador de novo. Nenhuma configuração muda.

Portado do projeto original (DeskcommCRM, PR #3853 de @thinhnx128).
