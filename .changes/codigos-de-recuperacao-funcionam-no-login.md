---
impacto: exige_acao
secao: corrigido
titulo: Códigos de recuperação passam a funcionar no login, e gerar novos leva ao código do aplicativo
---

Os códigos de recuperação da verificação em duas etapas nunca funcionaram: a tela "Perdi acesso ao autenticador" recusava qualquer código, mesmo um recém-gerado, porque o código era gravado num formato e procurado em outro. Agora cada código entra uma vez e depois deixa de valer, e pode ser digitado em minúsculas, com espaço ou com hífen. Os códigos são protegidos com o segredo da instalação (`INTERNAL_SECRET`): trocar esse segredo invalida os códigos já emitidos.

Em Configurações › Segurança, gerar novos códigos continua exigindo que a sessão tenha confirmado o código de 6 dígitos do aplicativo autenticador. Quando a sessão ainda não confirmou, a tela leva a pessoa para digitar o código e depois volta para Segurança, em vez de mostrar um erro. A mesma regra passa a valer para cadastrar um novo aplicativo autenticador numa conta que já tem um. O primeiro cadastro não muda.

Cadastrar um aplicativo autenticador troca o conjunto anterior de códigos, como já fazia a geração em Segurança. Se os códigos não puderem ser gravados, a tela avisa e pede para tentar de novo, em vez de mostrar códigos que não valem.

## Requer atenção

Os códigos gerados antes desta versão continuam sem valer. Depois de atualizar, quem usa a verificação em duas etapas precisa gerar códigos novos em Configurações › Segurança, guardar os novos e descartar os antigos. Sem isso, quem perder o celular continua sem saída pela tela de recuperação.

Portado do projeto original (DeskcommCRM, PR #3339 de @melgarafael).
