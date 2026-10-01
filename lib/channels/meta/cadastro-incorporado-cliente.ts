/**
 * O lado do BROWSER do Cadastro Incorporado: carrega o SDK da Meta, abre o
 * fluxo e devolve `code` + evento. Nome e domínio da Meta ficam aqui porque é
 * `lib/channels/meta/` (invariante 1 da restrição de canal).
 *
 * Se `window.FB` já existe (o e2e o simula), o script não é carregado.
 */
import { EVENTO_CANCELADO, montarExtras } from "./coexistencia";

const SDK = "https://connect.facebook.net/en_US/sdk.js";
const ORIGEM_DA_META = /\.facebook\.com$/;
const ESPERA_DO_EVENTO_MS = 3000;

interface FbSdk {
  init(o: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(cb: (r: { authResponse?: { code?: string } | null }) => void, o: Record<string, unknown>): void;
}

interface EventoDaMeta {
  nome: string;
  wabaId: string | null;
  phoneNumberId: string | null;
}

export interface ResultadoDoCadastro {
  code: string;
  evento: string;
  wabaId: string | null;
  phoneNumberId: string | null;
}
export type DesfechoDoCadastro =
  | { ok: true; resultado: ResultadoDoCadastro }
  | { ok: false; motivo: "cancelado" | "sem_code" | "sdk_indisponivel" | "sem_evento" };

const ESPERA_DO_SDK_MS = 10_000;

/** O SDK já está carregado? O clique só abre a janela de forma síncrona se sim. */
export function sdkPronto(win: Window = window): boolean {
  return Boolean((win as unknown as { FB?: FbSdk }).FB);
}

/**
 * Carrega o script do SDK (ou devolve o `FB` existente). Chamada na montagem da
 * tela, para o clique não esperar rede e perder o gesto do usuário (bloqueador
 * de popup). Resolve `null` se o script falha ou não inicializa no prazo.
 */
export function carregarSdk(win: Window = window, prazoMs = ESPERA_DO_SDK_MS): Promise<FbSdk | null> {
  const w = win as unknown as { FB?: FbSdk; fbAsyncInit?: () => void };
  if (w.FB) return Promise.resolve(w.FB);
  return new Promise((resolve) => {
    const s = win.document.createElement("script");
    const fim = (fb: FbSdk | null) => {
      clearTimeout(timer);
      if (!fb) s.remove(); // permite nova tentativa sem acumular <script>
      resolve(fb);
    };
    const timer = setTimeout(() => fim(null), prazoMs);
    w.fbAsyncInit = () => fim(w.FB ?? null);
    s.src = SDK;
    s.async = true;
    s.onerror = () => fim(null);
    win.document.body.appendChild(s);
  });
}

/** `ev.origin` pode ser a string "null" (iframe opaco): `new URL("null")` lança. */
function origemDaMeta(origin: string): boolean {
  try {
    return ORIGEM_DA_META.test(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function esperarEvento(chegou: () => boolean, prazoMs: number): Promise<void> {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const tique = () => {
      if (chegou() || Date.now() - inicio >= prazoMs) return resolve();
      setTimeout(tique, 25);
    };
    tique();
  });
}

export async function abrirCadastroIncorporado(input: {
  appId: string;
  configId: string;
  versao: string;
  win?: Window;
  /** Quanto esperar o `postMessage` depois do callback do `login` (ruling P15i). */
  esperaDoEventoMs?: number;
  esperaDoSdkMs?: number;
}): Promise<DesfechoDoCadastro> {
  const win = input.win ?? window;
  const fb = await carregarSdk(win, input.esperaDoSdkMs);
  if (!fb) return { ok: false, motivo: "sdk_indisponivel" };
  fb.init({ appId: input.appId, autoLogAppEvents: true, xfbml: true, version: input.versao });

  // Guardado num objeto, não numa `let`: atribuição dentro da closure faz o TS
  // estreitar a variável para `null` fora dela (TS2339 em `evento?.nome`).
  const recebido: { evento: EventoDaMeta | null } = { evento: null };
  const ouvir = (ev: MessageEvent) => {
    if (!origemDaMeta(ev.origin)) return;
    try {
      const d = JSON.parse(String(ev.data)) as {
        type?: string;
        event?: string;
        data?: { waba_id?: string; phone_number_id?: string };
      };
      if (d.type !== "WA_EMBEDDED_SIGNUP" || !d.event) return;
      recebido.evento = { nome: d.event, wabaId: d.data?.waba_id ?? null, phoneNumberId: d.data?.phone_number_id ?? null };
    } catch {
      /* mensagem que não é nossa */
    }
  };
  win.addEventListener("message", ouvir);

  try {
    const code = await new Promise<string | null>((resolve) =>
      fb.login((r) => resolve(r.authResponse?.code ?? null), {
        config_id: input.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: montarExtras(),
      }),
    );
    // A Meta pode mandar o `postMessage` depois do callback do `login`: espera
    // até o prazo, saindo cedo assim que o evento chega.
    await esperarEvento(() => recebido.evento !== null, input.esperaDoEventoMs ?? ESPERA_DO_EVENTO_MS);

    const evento = recebido.evento;
    if (evento?.nome === EVENTO_CANCELADO) return { ok: false, motivo: "cancelado" };
    if (!code && !evento) return { ok: false, motivo: "cancelado" };
    if (!code) return { ok: false, motivo: "sem_code" };
    if (!evento) return { ok: false, motivo: "sem_evento" };
    return { ok: true, resultado: { code, evento: evento.nome, wabaId: evento.wabaId, phoneNumberId: evento.phoneNumberId } };
  } finally {
    win.removeEventListener("message", ouvir);
  }
}
