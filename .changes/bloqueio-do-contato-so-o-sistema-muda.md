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
