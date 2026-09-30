---
impacto: nada_mudou
secao: alterado
titulo: Telemetria desligada por padrão; auditoria registra leituras
---

Com `SENTRY_DSN` vazio, a telemetria agora fica desligada. Para receber
relatórios de erro, coloque o DSN do seu próprio Sentry no `.env`. A auditoria
passa a registrar quem abre fichas, conversas e prévias LGPD, e deixa de guardar
dado de paciente das ferramentas MCP. Em produção, um erro 500 não mostra mais o
texto do banco.
