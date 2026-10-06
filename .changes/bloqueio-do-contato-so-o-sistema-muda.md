---
impacto: nada_mudou
secao: corrigido
titulo: O bloqueio de um contato só muda pelo pedido do paciente ou pelo botão do administrador
---

Quando um paciente pede para não receber mais mensagens, o contato fica
bloqueado. Só o administrador pode desbloquear, pelo botão na ficha do contato,
e isso fica registrado na auditoria.

Essa regra valia na tela, mas não no banco: um atendente com algum conhecimento
técnico conseguia desbloquear (ou bloquear) um contato por fora do sistema, sem
ser administrador e sem deixar registro.

Agora o próprio banco recusa. O bloqueio só é gravado quando o paciente pede
para parar, e só é desfeito pelo botão Desbloquear. Editar os outros dados da
ficha continua igual para todos. Nenhuma ação é necessária.

Dois atalhos que desfaziam o bloqueio sem desbloquear também foram fechados:

- O telefone de um contato bloqueado não pode mais ser trocado nem apagado pela
  ficha. Trocar o número fazia a próxima mensagem do paciente abrir um contato
  novo, sem bloqueio. Quem tentar vê o aviso "Este contato pediu para não
  receber mensagens" e precisa pedir ao administrador para desbloquear antes.
  Nome, e-mail e os outros campos continuam editáveis.
- Ao juntar dois contatos da mesma pessoa, se um deles estava bloqueado, o
  contato que sobra fica bloqueado também. Antes, juntar um contato bloqueado a
  uma duplicata livre fazia o bloqueio sumir.
