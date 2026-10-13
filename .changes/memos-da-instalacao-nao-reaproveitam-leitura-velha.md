---
impacto: nada_mudou
secao: corrigido
titulo: Credencial do Google Agenda, app da Meta e modo de cadastro não voltam ao valor antigo logo depois de gravados
---
Ao gravar a credencial do Google Agenda, o app da Meta ou o modo de cadastro no painel da instalação, a tela dizia "salvo" e, às vezes, o sistema seguia usando o valor antigo por até 30 segundos. Uma tela que estava sendo montada no mesmo instante da gravação reaproveitava a leitura feita antes dela e a guardava como se fosse a nova. A marca já tinha esse conserto neste fork; agora as três leituras irmãs vão sempre ao banco quando a memória está vazia. Nada a fazer na VPS. Porte do upstream melgarafael/DeskcommCRM#2795.
