import localFont from "next/font/local";

// Note: next/font requires module-level constants; we expose all 4 pair vars
// at once. CSS swaps via --font-display / --font-body / --font-mono picker.
//
// Arquivos locais em app/fonts/ (subset latin): o build não baixa nada do
// Google. O nome da família é gerado pelo next/font (não é mais o do Google),
// então `lib/tokens.ts` aponta para as variáveis CSS, nunca para o nome.

export const bricolage = localFont({
  src: "../../fonts/bricolage-grotesque.woff2",
  weight: "200 800",
  display: "swap",
  variable: "--font-bricolage",
});

export const jakarta = localFont({
  src: "../../fonts/plus-jakarta-sans.woff2",
  weight: "200 800",
  display: "swap",
  variable: "--font-jakarta",
});

// Mantém os eixos SOFT, WONK e opsz, como o `axes` pedia ao Google.
export const fraunces = localFont({
  src: "../../fonts/fraunces.woff2",
  weight: "100 900",
  display: "swap",
  variable: "--font-fraunces",
  adjustFontFallback: "Times New Roman",
});

export const manrope = localFont({
  src: "../../fonts/manrope.woff2",
  weight: "200 800",
  display: "swap",
  variable: "--font-manrope",
});

export const atkinson = localFont({
  src: [
    { path: "../../fonts/atkinson-hyperlegible-400.woff2", weight: "400" },
    { path: "../../fonts/atkinson-hyperlegible-700.woff2", weight: "700" },
  ],
  display: "swap",
  variable: "--font-atkinson",
});

export const sourceSerif = localFont({
  src: "../../fonts/source-serif-4.woff2",
  weight: "200 900",
  display: "swap",
  variable: "--font-source-serif",
  adjustFontFallback: "Times New Roman",
});

export const plexSans = localFont({
  src: "../../fonts/ibm-plex-sans.woff2",
  weight: "100 700",
  display: "swap",
  variable: "--font-plex-sans",
});

export const plexMono = localFont({
  src: [
    { path: "../../fonts/ibm-plex-mono-400.woff2", weight: "400" },
    { path: "../../fonts/ibm-plex-mono-500.woff2", weight: "500" },
  ],
  display: "swap",
  variable: "--font-plex-mono",
});

export const jetbrains = localFont({
  src: "../../fonts/jetbrains-mono.woff2",
  weight: "100 800",
  display: "swap",
  variable: "--font-jetbrains",
});

export const allFontVariables = [
  bricolage.variable,
  jakarta.variable,
  fraunces.variable,
  manrope.variable,
  atkinson.variable,
  sourceSerif.variable,
  plexSans.variable,
  plexMono.variable,
  jetbrains.variable,
].join(" ");
