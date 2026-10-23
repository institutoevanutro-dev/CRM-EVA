---
impacto: capacidade_nova
secao: corrigido
titulo: Códigos de recuperação passam a funcionar no login, e gerar novos leva ao código do aplicativo
---

Os códigos de recuperação da verificação em duas etapas nunca funcionaram: a tela "Perdi acesso ao autenticador" recusava qualquer código, mesmo um recém-gerado, porque o código era gravado num formato e procurado em outro. Agora cada código entra uma vez e depois deixa de valer, e pode ser digitado em minúsculas, com espaço ou com hífen. Os códigos são protegidos com o segredo da instalação (`INTERNAL_SECRET`) e ficam presos à conta que os gerou: o código de uma pessoa não vale na conta de outra, e trocar o segredo invalida os códigos já emitidos. Depois de 5 tentativas erradas na mesma conta em 15 minutos, a tela recusa até a janela passar.

Quem guardou códigos gerados antes desta versão precisa gerar novos em Configurações › Segurança e descartar os antigos: eles nunca funcionaram e continuam sem valer.

Em Configurações › Segurança, gerar novos códigos continua exigindo que a sessão tenha confirmado o código de 6 dígitos do aplicativo autenticador. Quando a sessão ainda não confirmou, a tela leva a pessoa para digitar o código e depois volta para Segurança, em vez de mostrar um erro. A mesma regra passa a valer para cadastrar um novo aplicativo autenticador numa conta que já tem um. O primeiro cadastro não muda.

Cadastrar um aplicativo autenticador troca o conjunto anterior de códigos, como já fazia a geração em Segurança. Se os códigos não puderem ser gravados, a tela avisa e pede para tentar de novo, em vez de mostrar códigos que não valem.

Portado do projeto original (DeskcommCRM, PR #3339 de @melgarafael). No CRM da clínica o código fica preso à conta que o gerou, porque a mudança de banco que impede a gravação direta dos códigos ainda não entrou.
