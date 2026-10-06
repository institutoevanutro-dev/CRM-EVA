/**
 * Um destino é local quando o HOSTNAME é loopback, comparado por inteiro: serve
 * para os DOIS canais, a URL HTTP do Supabase e o DSN do Postgres (`new URL`
 * entende `postgresql://`).
 *
 * Destino VAZIO conta como local: sem DSN o `pg` cai no default do libpq
 * (`127.0.0.1:5432`) e falha alto com `ECONNREFUSED`, que é ruído — não é escrita
 * em produção, e é o que este alarme existe para achar.
 *
 * ⚠️ POR QUE O NOME INTEIRO, E NUNCA O PREFIXO. A versão anterior aceitava
 * qualquer host que COMEÇASSE com `127.` — e `127.evil.example.com` é um nome de
 * DNS válido, que resolve para onde o dono dele quiser. Um seed que recusa
 * produção por este predicado gravava nele. Ela também cortava o host no
 * primeiro `:`, o que transformava `[::1]:5432` em `[` e recusava o loopback
 * IPv6. Destino ilegível conta como remoto: na dúvida, o seed recusa.
 */
export function destinoEhLocal(alvo: string): boolean {
  if (alvo === "") return true;
  let hostname: string;
  try {
    hostname = new URL(alvo).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === "localhost" || hostname === "[::1]" || ehIpv4DeLoopback(hostname);
}

/** `127.x.y.z` como IP LITERAL: quatro octetos decimais, cada um de 0 a 255. */
function ehIpv4DeLoopback(hostname: string): boolean {
  const octetos = hostname.split(".");
  return (
    octetos.length === 4 &&
    octetos[0] === "127" &&
    octetos.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
  );
}
