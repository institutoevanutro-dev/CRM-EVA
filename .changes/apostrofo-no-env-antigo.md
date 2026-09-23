---
impacto: nada_mudou
secao: corrigido
titulo: Nome de empresa com apóstrofo volta a ser lido corretamente no Mac
---
Quem desenvolve no macOS via a suíte do kit de instalação falhar ao ler um `.env` antigo cujo valor tinha apóstrofo (`Sant'Ana Odontologia` voltava como `Sant"'"Ana Odontologia`). Era diferença do bash 3.2 que a Apple ainda distribui; numa VPS, com bash 5, a leitura sempre esteve correta. Nada muda para quem já tem o CRM instalado.
