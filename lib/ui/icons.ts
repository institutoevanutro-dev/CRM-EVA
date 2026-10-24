/**
 * Canonical icon map. Toda feature importa daqui — não direto de @phosphor-icons/react.
 * ADR-05 (Spec 09 §12). Permite swap futuro sem big-bang refactor.
 *
 * Re-exporting from `@phosphor-icons/react/dist/ssr` so Server Components can
 * render icons without forcing the entire CSR React-context module client-side.
 * Client Components still get fully interactive icons (size/weight/color).
 */

export {
  // navigation (inbox icon = Tray in Phosphor)
  Tray as Inbox,
  ListChecks,
  Plugs,
  PlugsConnected,
  QrCode,
  Kanban,
  Users,
  UsersThree,
  Storefront,
  Robot,
  Sparkle,
  ShieldCheck,
  Gear,
  House,
  // admin platform
  Buildings,
  FlowArrow,
  ChatsCircle,
  ClipboardText,
  Scales,
  Gauge,
  WifiSlash,
  Clock,
  // marca da instalação (o revendedor troca nome e cor do produto)
  Palette,
  // anúncios (Análise → Meta Ads). Megaphone e não outro ChartX: os dois
  // vizinhos do grupo já são gráficos (ChartBar em Desempenho, ChartLineUp em
  // Evolução da IA), e um terceiro gráfico deixaria as três linhas do menu
  // indistinguíveis de relance. Mesma família Phosphor, mesmo peso.
  Megaphone,
  // bônus da equipe (Análise › Bônus). Trophy e não outro ChartX: pelo mesmo
  // motivo do Megaphone acima, o ChartBar já é o de Desempenho no grupo.
  Trophy,
  // health dashboard
  WifiHigh,
  Brain,
  ArrowsClockwise,
  Dot,
  // actions
  ArrowBendUpLeft,
  // encaminhar (DeskcommCRM #2835): a seta espelhada do "Responder" — mesma
  // família, mesmo peso, para os dois gestos da bolha lerem como par.
  ArrowBendUpRight,
  List,
  Bell,
  BellSlash,
  PaperPlaneTilt,
  Smiley,
  Check,
  Checks,
  X,
  Plus,
  Trash,
  PencilSimple,
  MagnifyingGlass,
  Pause,
  Play,
  SkipForward,
  Copy,
  DownloadSimple,
  Archive,
  // origem de uma captação de formulário (página, IP, link para o lead)
  Globe,
  ArrowSquareOut,
  Tray,
  // feedback
  CheckCircle,
  Warning,
  WarningOctagon,
  Info,
  CircleNotch,
  // lgpd
  Scales as ScalesSimple,
  Eye,
  // ocultar um contato do Inbox (migration 0372)
  EyeSlash,
  ChartBar,
  ClockCountdown,
  // painéis de evolução / aprendizado
  ChartLineUp,
  Lightbulb,
  // theme
  Sun,
  Moon,
  MonitorPlay,
  // conversation
  ChatCircle,
  Phone,
  InstagramLogo,
  WhatsappLogo,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneX,
  Paperclip,
  Microphone,
  MicrophoneSlash,
  Image as ImageIcon,
  ImageSquare,
  MusicNote,
  Note,
  FileText,
  FilePdf,
  Lock,
  LockOpen,
  Receipt,
  Tag,
  Question,
  Keyboard,
  // followup flow builder (Task 6.2)
  GitBranch,
  Flag,
  TreeStructure,
  // reordenar por arrastar e soltar (porte do #3261): a alça das respostas rápidas
  DotsSixVertical as DragHandle,
  // misc
  DotsThree,
  CaretDown,
  CaretUp,
  CaretDoubleLeft,
  CaretDoubleRight,
  CaretLeft,
  CaretRight,
  ArrowRight,
  SignOut,
  WebhooksLogo,
  PuzzlePiece,
  UploadSimple,
  Signpost,
  // atualização de versão
  ArrowCircleUp,
  // navegação agrupada (registro em lib/navigation/registry.ts)
  Funnel,
  BookOpen,
  Key,
  UserCircle,
  ClockCounterClockwise,
  // inbox no celular: voltar para a lista e abrir a ficha do contato
  IdentificationCard,
  // agenda (o barril não tinha NENHUM ícone de calendário até aqui)
  CalendarBlank,
  CalendarDots,
  CalendarPlus,
  CalendarX,
  CalendarCheck,
  GoogleLogo,
  MapPin,
  ArrowsOutSimple,
} from "@phosphor-icons/react/dist/ssr";
