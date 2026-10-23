---
impacto: capacidade_nova
secao: corrigido
titulo: Códigos de recuperação passam a funcionar no login, e gerar novos leva ao código do aplicativo
---

Os códigos de recuperação da verificação em duas etapas nunca funcionaram: "Perdi acesso ao autenticador" recusava qualquer código. Agora cada código entra uma vez, aceita minúsculas, espaço e hífen, vale só na conta que o gerou e é protegido pelo segredo da instalação (`INTERNAL_SECRET`; trocá-lo invalida os códigos emitidos). Depois de 5 tentativas erradas na mesma conta em 15 minutos, a tela recusa até a janela passar. Quem guardou códigos antigos precisa gerar novos em Configurações › Segurança.

Gerar códigos, e cadastrar outro autenticador numa conta que já tem um, pedem o código de 6 dígitos nesta sessão: sem ele, a tela leva ao código e volta para Segurança. Se os códigos não puderem ser gravados, a tela avisa em vez de mostrar códigos que não valem.

Portado do projeto original (DeskcommCRM, PR #3339 de @melgarafael). No CRM da clínica o código fica preso à conta que o gerou, porque a mudança de banco do original ainda não entrou.
