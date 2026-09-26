import {
	AlertTriangle,
	AppWindow,
	BadgeCheck,
	Bell,
	BellOff,
	Camera,
	Cat,
	Check,
	CheckCircle2,
	CircleHelp,
	ChevronLeft,
	ChevronRight,
	Clock,
	CodeXml,
	Copy,
	createIcons,
	ExternalLink,
	FlaskConical,
	Eye,
	EyeOff,
	CheckCheck,
	Globe,
	GraduationCap,
	Hammer,
	House,
	Hash,
	Image,
	Info,
	KeyRound,
	Loader2,
	Lock,
	LogIn,
	LogOut,
	Megaphone,
	MicOff,
	Monitor,
	Moon,
	Play,
	PlayCircle,
	Power,
	Radio,
	RefreshCw,
	RotateCw,
	ScreenShare,
	Search,
	Send,
	Settings,
	ShieldCheck,
	Sparkles,
	Square,
	Timer,
	Sun,
	Target,
	Trash2,
	User,
	UserCheck,
	UserCog,
	UserPlus,
	Users,
	Video,
	Volume1,
	Volume2,
	VolumeX,
	Wifi,
	WifiOff,
	X,
	Zap,
} from "lucide";
import type {
	AudioCaptureMode,
	StreamQualityOptions,
	WindowSource,
} from "../../types/capture";
import {
	acceptFriendRequest,
	type BadgeId,
	type BadgeStats,
	checkSavedSession,
	createRoom,
	dismissRoomInvite,
	FriendInfo,
	FriendRequest,
	getFriends,
	getOnlineUsers,
	getProfile,
	getRooms,
	getRoomStreams,
	getToken,
	getUser,
	inviteFriendToRoom,
	isAuthenticated,
	joinRoom,
	joinRoomByInvite,
	kickUserFromRoom,
	leaveRoom,
	login,
	logout,
	notifyRoomStream,
	register,
	rejectFriend,
	RoomInfo,
	RoomInvite,
	SavedSessionResult,
	saveRememberSession,
	sendFriendRequest,
	sendHeartbeat,
	setUserBadge,
	ShiroUser,
	updateProfile,
	updateRoomSettings,
} from "./authManager";
import { P2PManager } from "./p2pManager";
import { Poller } from "./poller";
import { GuidedTour, type TourStep } from "./tutorial";
import { AudioPipeline } from "./audioPipeline";
import { SourcePicker } from "./sourcePicker";
import {
	AudioVisualizer,
	setupWindowControls,
} from "./uiComponents";

function setStreamStatus(live: boolean, text: string): void {
	const badge = document.getElementById("stream-badge");
	if (!badge) return;
	badge.textContent = text;
	badge.className = `badge ${live ? "badge-live" : "badge-offline"}`;
}
interface PollIntervals {
	heartbeat: number;
	rooms: number;
	friends: number;
	users: number;
}

const POLL_INTERVALS: { fallback: PollIntervals; withServerEvents: PollIntervals } = {
	// Servidor sem avisos em tempo real: polling é a única fonte de atualização
	fallback: { heartbeat: 60_000, rooms: 15_000, friends: 15_000, users: 30_000 },
	// Servidor envia avisos pelo SSE (que também mantém a presença online):
	// polling é só rede de segurança. Heartbeat < 150s (limite de offline das salas no servidor).
	withServerEvents: { heartbeat: 120_000, rooms: 120_000, friends: 300_000, users: 300_000 },
};

export const DEV_ADMIN_ID = "6ab1e7120ee994421cd420be";

/** Desenvolvedores oficiais (a API valida; aqui só controla o que aparece na tela) */
const DEVELOPER_IDS = ["6ab1e7120ee994421cd420be", "6ab20b7b889d5d620b52c89a"];

interface BadgeDef {
	name: string;
	icon: string;
	/** Texto do tooltip (recebe a última contagem das estatísticas) */
	describe: (stats: BadgeStats | undefined, viewerIsDev: boolean) => string;
}

function formatStreamTime(seconds: number): string {
	const totalMinutes = Math.floor(seconds / 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours}h ${minutes}min` : `${minutes}min`;
}

/** Ordem de exibição = ordem das chaves */
const BADGE_DEFS: Record<BadgeId, BadgeDef> = {
	developer: {
		name: "Desenvolvedor",
		icon: "code-xml",
		describe: () => "Desenvolvedor oficial do Shiro Screen Share",
	},
	"early-user": {
		name: "Primeiros usuários",
		icon: "sparkles",
		describe: () => "Um dos 10 primeiros usuários do app",
	},
	"beta-tester": {
		name: "Beta Tester",
		icon: "flask-conical",
		describe: () => "Ajudou a testar o app",
	},
	"stream-24-7": {
		name: "24/7",
		icon: "timer",
		describe: (s) => `${formatStreamTime(s?.streamSeconds ?? 0)} de transmissão`,
	},
	builder: {
		name: "Construtor Civil",
		icon: "hammer",
		describe: (s) => `${s?.roomsCreated ?? 0} salas criadas`,
	},
	neighbor: {
		name: "Amigo da Vizinhança",
		icon: "house",
		// A contagem exata de amigos só aparece para os desenvolvedores
		describe: (s, viewerIsDev) => (viewerIsDev ? `20+ amigos (total atual: ${s?.friendsCount ?? 0})` : "Fez 20 amigos no app"),
	},
};

export interface SystemNotice {
	id: string;
	title: string;
	message: string;
	type: "info" | "warning" | "update";
	date: string;
}

class ShiroApp {
	private friends: FriendInfo[] = [];
	private friendRequests: FriendRequest[] = [];
	private roomInvites: RoomInvite[] = [];
	private activeRoomInvite: RoomInvite | null = null;
	private activeFriendRequest: FriendRequest | null = null;
	private sentFriendRequestUserIds: Set<string> = new Set();
	private systemNotices: SystemNotice[] = [
		{
			id: "sys-v21",
			title: "Shiro Screen Share v2.1.0",
			message: "Nova arquitetura WebRTC P2P multi-stream ativa com isolamento de áudio.",
			type: "info",
			date: "Sistema",
		},
	];
	private activeNotifFilter: "all" | "friends" | "invites" | "system" = "all";

	private leftSourcePicker: SourcePicker | null = null;
	private mainSourcePicker: SourcePicker | null = null;

	private audioPipeline: AudioPipeline = new AudioPipeline();
	private audioVisualizer: AudioVisualizer = new AudioVisualizer();

	private p2pManager: P2PManager | null = null;

	private allSources: WindowSource[] = [];
	private selectedSourceIndex: number = -1;
	private currentVideoTrack: MediaStreamTrack | null = null;
	private previewStream: MediaStream | null = null;
	private selectedTargetUserId: string | null = null;
	private pollers: Poller[] = [];
	private heartbeatPoller: Poller | null = null;
	private roomsPoller: Poller | null = null;
	private friendsPoller: Poller | null = null;
	private usersPoller: Poller | null = null;
	private streamsPoller: Poller | null = null;
	// O servidor confirmou (evento SSE "hello") que envia avisos de mudança
	private serverSupportsEvents = false;
	private serverEventTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private autoConnectRetryInterval: ReturnType<typeof setInterval> | null = null;
	private serverEventsHelloCount = 0;
	private thumbnailInterval: ReturnType<typeof setInterval> | null = null;
	private mainUiInitialized = false;
	private autoConnectInFlight = false;
	private lastUsersRenderKey = "";
	private tutorial: GuidedTour | null = null;
	private authUiInitialized = false;
	// Indicam se já houve ao menos um carregamento bem-sucedido (para não trocar dados bons por "vazio" em falhas)
	private roomsLoaded = false;
	private usersLoaded = false;

	private rooms: RoomInfo[] = [];
	private onlineUsers: ShiroUser[] = [];
	private currentRoom: RoomInfo | null = null;
	private targetJoinRoomId: string | null = null;
	private remoteStreams = new Map<string, { stream: MediaStream; username: string }>();
	private maximizedStreamId: string | null = null;
	private streamDeckBridgeInitialized = false;
	private activeMiniProfileUserId: string | null = null;

	public async initialize(): Promise<void> {
		console.log("[App] Initializing Shiro Screen Share...");
		this.refreshIcons();
		this.setupLoginWindowControls();
		this.setupCustomTooltips();
		this.setupStreamDeckBridge();
		this.setupQuitCleanup();

		const saved = checkSavedSession();

		if (saved.autoLogin && isAuthenticated()) {
			await this.showMainView();
		} else {
			this.showLoginView(saved);
		}
	}


	private showLoginView(saved?: SavedSessionResult): void {
		const viewLogin = document.getElementById("view-login");
		const viewMain = document.getElementById("view-main");
		if (viewLogin) viewLogin.classList.remove("hidden");
		if (viewMain) viewMain.classList.add("hidden");

		if (!this.authUiInitialized) {
			this.authUiInitialized = true;
			this.setupAuthTabs();
			this.setupAuthForms();
		}

		const usernameInput = document.getElementById("login-username") as HTMLInputElement | null;
		const rememberChk = document.getElementById("login-remember-me") as HTMLInputElement | null;
		const passwordInput = document.getElementById("login-password") as HTMLInputElement | null;
		const errorEl = document.getElementById("login-error");

		if (saved?.username && usernameInput) {
			usernameInput.value = saved.username;
			if (rememberChk) rememberChk.checked = true;
			if (passwordInput) passwordInput.focus();
		}

		if (saved?.expired && errorEl) {
			errorEl.style.color = "var(--warning-color)";
			errorEl.style.background = "rgba(245, 158, 11, 0.1)";
			errorEl.style.border = "1px solid rgba(245, 158, 11, 0.3)";
			errorEl.textContent = "Sua sessão expira a cada 2 semanas por segurança. Digite sua senha novamente.";
		}

		this.refreshIcons();
	}

	private setupLoginWindowControls(): void {
		document.getElementById("login-btn-minimize")?.addEventListener("click", () => {
			window.api?.minimizeWindow?.();
		});
		document.getElementById("login-btn-close")?.addEventListener("click", () => {
			window.api?.closeWindow?.();
		});
	}

	private setupCustomTooltips(): void {
		let tooltipEl = document.getElementById("app-tooltip");
		if (!tooltipEl) {
			tooltipEl = document.createElement("div");
			tooltipEl.id = "app-tooltip";
			tooltipEl.className = "app-tooltip hidden";
			tooltipEl.setAttribute("role", "tooltip");
			tooltipEl.setAttribute("aria-hidden", "true");
			document.body.appendChild(tooltipEl);
		}

		let currentTarget: HTMLElement | null = null;
		let showTimer: number | null = null;

		const hideTooltip = () => {
			if (showTimer !== null) {
				window.clearTimeout(showTimer);
				showTimer = null;
			}
			if (tooltipEl) {
				tooltipEl.classList.remove("visible");
				tooltipEl.classList.add("hidden");
			}
			currentTarget = null;
		};

		const displayTooltip = (target: HTMLElement) => {
			const text = target.getAttribute("data-tooltip");
			if (!text || !text.trim() || !tooltipEl) {
				hideTooltip();
				return;
			}

			tooltipEl.textContent = text;
			tooltipEl.classList.remove("hidden");

			const targetRect = target.getBoundingClientRect();
			const tipRect = tooltipEl.getBoundingClientRect();

			// Determina posição (preferência ou detecção inteligente de borda da tela)
			const posPref = target.getAttribute("data-tooltip-pos");
			let placement: "top" | "bottom" = "top";

			if (posPref === "bottom") {
				placement = "bottom";
			} else if (posPref === "top") {
				placement = "top";
			} else if (targetRect.top < 85 || targetRect.top - tipRect.height - 8 < 6) {
				placement = "bottom";
			} else {
				placement = "top";
			}

			let top = placement === "bottom"
				? targetRect.bottom + 6
				: targetRect.top - tipRect.height - 6;

			let left = targetRect.left + (targetRect.width - tipRect.width) / 2;

			// Viewport clamping
			const margin = 8;
			if (left < margin) {
				left = margin;
			} else if (left + tipRect.width > window.innerWidth - margin) {
				left = window.innerWidth - margin - tipRect.width;
			}

			if (top < margin) {
				top = margin;
			} else if (top + tipRect.height > window.innerHeight - margin) {
				top = window.innerHeight - margin - tipRect.height;
			}

			tooltipEl.style.top = `${Math.round(top)}px`;
			tooltipEl.style.left = `${Math.round(left)}px`;
			tooltipEl.setAttribute("data-placement", placement);

			requestAnimationFrame(() => {
				tooltipEl?.classList.add("visible");
			});
		};

		// Event Delegation em document para capturar qualquer elemento (inclusive dinâmicos)
		document.addEventListener("pointerover", (e) => {
			const target = (e.target as Element)?.closest?.<HTMLElement>("[data-tooltip], [title]");
			if (!target) return;

			// Intercepta e converte title nativo para data-tooltip para desativar o tooltip nativo feio do SO
			const titleAttr = target.getAttribute("title") || target.title;
			if (titleAttr) {
				target.setAttribute("data-tooltip", titleAttr);
				target.removeAttribute("title");
				target.title = "";
			}

			if (currentTarget === target) return;

			if (showTimer !== null) {
				window.clearTimeout(showTimer);
				showTimer = null;
			}

			currentTarget = target;
			const isAlreadyVisible = tooltipEl?.classList.contains("visible");
			const delay = isAlreadyVisible ? 40 : 120;

			showTimer = window.setTimeout(() => {
				if (currentTarget === target) {
					displayTooltip(target);
				}
			}, delay);
		});

		document.addEventListener("pointerout", (e) => {
			const related = e.relatedTarget as HTMLElement | null;
			if (currentTarget && (!related || !currentTarget.contains(related))) {
				hideTooltip();
			}
		});

		document.addEventListener("pointerdown", () => hideTooltip());
		window.addEventListener("scroll", () => hideTooltip(), true);
		window.addEventListener("blur", () => hideTooltip());
	}

	private setupAuthTabs(): void {
		const tabLogin = document.getElementById("tab-login");
		const tabRegister = document.getElementById("tab-register");
		const formLogin = document.getElementById("form-login");
		const formRegister = document.getElementById("form-register");
		const indicator = document.querySelector(".auth-tab-indicator") as HTMLElement | null;

		tabLogin?.addEventListener("click", () => {
			tabLogin.classList.add("active");
			tabRegister?.classList.remove("active");
			formLogin?.classList.remove("hidden");
			formRegister?.classList.add("hidden");
			if (indicator) indicator.classList.remove("on-register");
		});

		tabRegister?.addEventListener("click", () => {
			tabRegister.classList.add("active");
			tabLogin?.classList.remove("active");
			formRegister?.classList.remove("hidden");
			formLogin?.classList.add("hidden");
			if (indicator) indicator.classList.add("on-register");
			this.refreshIcons();
		});
	}

	private setupAuthForms(): void {
		const setupEye = (toggleId: string, inputId: string) => {
			const btn = document.getElementById(toggleId);
			const input = document.getElementById(inputId) as HTMLInputElement | null;
			btn?.addEventListener("click", () => {
				if (!input) return;
				const isText = input.type === "text";
				input.type = isText ? "password" : "text";
				const showIcon = btn.querySelector(".eye-icon-show") as HTMLElement | null;
				const hideIcon = btn.querySelector(".eye-icon-hide") as HTMLElement | null;
				if (showIcon) showIcon.style.display = isText ? "inline-block" : "none";
				if (hideIcon) hideIcon.style.display = isText ? "none" : "inline-block";
			});
		};

		setupEye("toggle-login-password", "login-password");
		setupEye("toggle-reg-password", "reg-password");

		document.getElementById("form-login")?.addEventListener("submit", async (e) => {
			e.preventDefault();
			const username = (document.getElementById("login-username") as HTMLInputElement)?.value.trim();
			const password = (document.getElementById("login-password") as HTMLInputElement)?.value;
			const rememberMe = (document.getElementById("login-remember-me") as HTMLInputElement)?.checked ?? false;
			const errorEl = document.getElementById("login-error");

			if (!username || !password) {
				if (errorEl) {
					errorEl.style.color = "";
					errorEl.style.background = "";
					errorEl.style.border = "";
					errorEl.textContent = "Preencha todos os campos.";
				}
				return;
			}

			this.setAuthLoading("btn-login", true);
			if (errorEl) {
				errorEl.style.color = "";
				errorEl.style.background = "";
				errorEl.style.border = "";
				errorEl.textContent = "";
			}

			const result = await login(username, password);
			this.setAuthLoading("btn-login", false);

			if (!result.ok || !result.user) {
				if (errorEl) {
					errorEl.style.color = "";
					errorEl.style.background = "";
					errorEl.style.border = "";
					errorEl.textContent = result.error ?? "Erro ao fazer login.";
				}
				return;
			}

			const token = getToken();
			if (token) {
				saveRememberSession(token, result.user, rememberMe);
			}

			await this.showMainView();
		});

		document.getElementById("form-register")?.addEventListener("submit", async (e) => {
			e.preventDefault();
			const username = (document.getElementById("reg-username") as HTMLInputElement)?.value.trim();
			const password = (document.getElementById("reg-password") as HTMLInputElement)?.value;
			const confirm = (document.getElementById("reg-password-confirm") as HTMLInputElement)?.value;
			const errorEl = document.getElementById("register-error");

			if (!username || !password || !confirm) {
				if (errorEl) errorEl.textContent = "Preencha todos os campos.";
				return;
			}

			if (password !== confirm) {
				if (errorEl) errorEl.textContent = "As senhas não coincidem.";
				return;
			}

			if (password.length < 6) {
				if (errorEl) errorEl.textContent = "A senha precisa ter ao menos 6 caracteres.";
				return;
			}

			this.setAuthLoading("btn-register", true);
			if (errorEl) errorEl.textContent = "";

			const result = await register(username, password);

			if (!result.ok) {
				this.setAuthLoading("btn-register", false);
				if (errorEl) errorEl.textContent = result.error ?? "Erro ao registrar.";
				return;
			}

			const loginResult = await login(username, password);
			this.setAuthLoading("btn-register", false);

			if (!loginResult.ok) {
				if (errorEl) errorEl.textContent = "Conta criada! Faça login manualmente.";
				return;
			}

			await this.showMainView();
		});
	}

	private setAuthLoading(btnId: string, loading: boolean): void {
		const btn = document.getElementById(btnId) as HTMLButtonElement | null;
		if (!btn) return;
		const text = btn.querySelector(".btn-text") as HTMLElement | null;
		const spinner = btn.querySelector(".btn-spinner") as HTMLElement | null;
		btn.disabled = loading;
		if (text) text.style.opacity = loading ? "0" : "1";
		if (spinner) spinner.style.display = loading ? "inline-block" : "none";
	}

	private async showMainView(): Promise<void> {
		const viewLogin = document.getElementById("view-login");
		const viewMain = document.getElementById("view-main");

		if (viewLogin) viewLogin.classList.add("hidden");
		if (viewMain) viewMain.classList.remove("hidden");

		const user = getUser();
		if (user) {
			this.updateHeaderUserInfo();
		}

		if (user) {
			this.p2pManager = new P2PManager(user.id, {
				isPeerAllowed: (peerId) => {
					if (!this.currentRoom) return false;
					const inActiveStreams = this.currentRoom.activeStreams?.some((s) => s.userId === peerId);
					if (this.p2pManager?.getIsStreaming()) {
						return true;
					}
					return inActiveStreams ?? false;
				},
				onConnected: (peerId) => {
					console.log(`[App] P2P conectado com sucesso a ${peerId}`);
					if (this.p2pManager?.getIsStreaming()) {
						setStreamStatus(true, "AO VIVO");
						if (window.api) window.api.reportStreamShareState(true);
						document.getElementById("btn-start-stream")?.classList.add("hidden");
						document.getElementById("btn-stop-stream")?.classList.remove("hidden");
					} else {
						setStreamStatus(true, "Assistindo");
					}
				},
				onDisconnected: (peerId) => {
					console.log(`[App] P2P desconectado de ${peerId}`);
					this.remoteStreams.delete(peerId);
					this.renderLiveStreamsGrid();
					if (this.remoteStreams.size === 0 && !this.p2pManager?.getIsStreaming()) {
						setStreamStatus(false, "Desconectado");
					}
				},
				onError: (err) => {
					console.error(`[App] P2P erro: ${err}`);
				},
				onRemoteStream: (stream, peerId) => {
					console.log(`[App] Stream remota recebida de ${peerId}`);
					const isStreamerInCurrentRoom = this.currentRoom?.activeStreams?.some((s) => s.userId === peerId);
					if (!this.currentRoom || !isStreamerInCurrentRoom) {
						console.warn(`[App] Ignorando stream de ${peerId} pois não está transmitindo na sala ativa (${this.currentRoom?.roomId}).`);
						this.p2pManager?.closePeer(peerId);
						return;
					}

					const activeStreamer = this.currentRoom.activeStreams?.find((s) => s.userId === peerId);
					const onlineUser = this.onlineUsers.find((u) => u.id === peerId);
					const username = activeStreamer?.username ?? onlineUser?.username ?? peerId;
					this.remoteStreams.set(peerId, { stream, username });
					this.renderLiveStreamsGrid();
				},
				onSystemNotice: (notice) => {
					this.addSystemNotice(notice);
					this.showSystemNoticeToast(notice);
				},
			});
			this.p2pManager.startSignaling();
		}

		if (!this.mainUiInitialized) {
			this.mainUiInitialized = true;
			this.setupMainUi();
		}

		this.roomsLoaded = false;
		this.usersLoaded = false;
		this.lastUsersRenderKey = "";

		await this.refreshRooms();
		await this.leaveStaleRooms();
		await this.refreshSources();
		await this.refreshFriends();
		await this.refreshUsersList();

		this.startPolling();
		this.maybeShowTutorialWelcome();
	}

	/**
	 * Ao abrir o app o usuário ainda não está em nenhuma sala, mas o servidor pode listá-lo
	 * como membro de uma sala antiga (app fechado sem sair: crash, atualização, PC suspenso...).
	 * Como ele está online, o servidor nunca o remove sozinho: sai dessas salas aqui.
	 */
	private async leaveStaleRooms(): Promise<void> {
		const me = getUser();
		if (!me) return;
		const stale = this.rooms.filter(
			(r) => r.roomId !== this.currentRoom?.roomId && Array.isArray(r.members) && r.members.includes(me.username),
		);
		if (stale.length === 0) return;

		console.log(`[App] Saindo de ${stale.length} sala(s) antiga(s) onde o servidor ainda listava este usuário:`, stale.map((r) => r.roomId));
		for (const room of stale) {
			try {
				await leaveRoom(room.roomId);
			} catch (err) {
				console.warn(`[App] Falha ao sair da sala antiga ${room.roomId}:`, err);
			}
		}
		await this.refreshRooms();
	}

	/** Ao fechar o app (ex.: "Sair" na bandeja), sai da sala antes de o processo encerrar */
	private setupQuitCleanup(): void {
		window.api?.onAppBeforeQuit?.(async () => {
			try {
				if (this.currentRoom && isAuthenticated()) {
					const roomId = this.currentRoom.roomId;
					if (this.p2pManager?.getIsStreaming()) {
						await notifyRoomStream(roomId, "stop").catch(() => {});
					}
					await leaveRoom(roomId).catch(() => {});
					this.currentRoom = null;
				}
				this.p2pManager?.hangupAll();
			} finally {
				window.api?.appQuitReady?.();
			}
		});
	}

	/** Registra listeners da tela principal (executa uma única vez, mesmo após logout/login) */
	private setupMainUi(): void {
		// Cada setup roda isolado: um erro em um deles não pode impedir o registro dos
		// listeners dos seguintes (o que deixaria vários botões sem resposta)
		const setups: Array<[string, () => unknown]> = [
			["windowControls", () => setupWindowControls()],
			["refreshUsersButton", () => document.getElementById("btn-refresh-users")?.addEventListener("click", () => this.refreshUsersList())],
			["themeToggle", () => this.setupThemeToggle()],
			["shiroPromo", () => this.setupShiroPromo()],
			["profileSettings", () => this.setupProfileSettings()],
			["miniProfilePopover", () => this.setupMiniProfilePopover()],
			["panelTabs", () => this.setupPanelTabs()],
			["friendsSystem", () => this.setupFriendsSystem()],
			["roomSettingsModal", () => this.setupRoomSettingsModal()],
			["joinByInviteModal", () => this.setupJoinByInviteModal()],
			["roomInvitesToast", () => this.setupRoomInvitesToast()],
			["friendRequestToast", () => this.setupFriendRequestToast()],
			["notificationsPopover", () => this.setupNotificationsPopover()],
			["createNoticeModal", () => this.setupCreateNoticeModal()],
			["systemNoticeToast", () => this.setupSystemNoticeToast()],
			["roomListeners", () => this.setupRoomListeners()],
			["sourcePicker", () => this.setupSourcePicker()],
			["subTabs", () => this.setupSubTabs()],
			["streamButtons", () => this.setupStreamButtons()],
			["popoverToggles", () => this.setupPopoverToggles()],
			["audioRadioListeners", () => this.setupAudioRadioListeners()],
			["qualityChangeListeners", () => this.setupQualityChangeListeners()],
			["customSelects", () => this.setupCustomSelects()],
			["appSettings", () => this.setupAppSettings()],
			["logout", () => this.setupLogout()],
			["streamDeckBridge", () => this.setupStreamDeckBridge()],
			["serverEvents", () => this.subscribeServerEvents()],
			["tutorial", () => this.setupTutorial()],
			["controlsAutoHide", () => this.setupControlsAutoHide()],
		];
		for (const [name, setup] of setups) {
			try {
				const result = setup();
				if (result instanceof Promise) {
					result.catch((err) => console.error(`[App] Erro no setup "${name}":`, err));
				}
			} catch (err) {
				console.error(`[App] Erro no setup "${name}":`, err);
			}
		}

		this.audioVisualizer.mount("vu-canvas");
		this.refreshIcons();

		window.addEventListener("keydown", (e) => {
			if (e.key === "Escape") this.restoreGridMode();
		});

		window.addEventListener("beforeunload", () => {
			if (this.currentRoom) {
				const roomId = this.currentRoom.roomId;
				if (this.p2pManager?.getIsStreaming()) {
					notifyRoomStream(roomId, "stop").catch(() => {});
				}
				leaveRoom(roomId).catch(() => {});
			}
			this.p2pManager?.hangupAll();
		});
	}

	/**
	 * Inicia os pollings da API. Cada poller não se sobrepõe, faz backoff em falhas
	 * e desacelera com a janela oculta (bandeja/minimizada).
	 *
	 * Os intervalos abaixo são o modo "sem avisos". Quando o servidor confirma pelo SSE
	 * que envia avisos de mudança (evento "hello"), os pollings viram só uma rede de
	 * segurança lenta e os dados são buscados quando chega um aviso (rooms/users/friends-changed).
	 */
	private startPolling(): void {
		this.stopPolling();
		this.heartbeatPoller = new Poller(() => sendHeartbeat(), { intervalMs: POLL_INTERVALS.fallback.heartbeat, hiddenFactor: 1 });
		this.roomsPoller = new Poller(() => this.refreshRooms(), { intervalMs: POLL_INTERVALS.fallback.rooms });
		this.friendsPoller = new Poller(() => this.refreshFriends(), { intervalMs: POLL_INTERVALS.fallback.friends });
		this.usersPoller = new Poller(() => this.refreshUsersList(), { intervalMs: POLL_INTERVALS.fallback.users });
		// Consulta leve de quem está transmitindo na sala atual: frequente, para a transmissão aparecer rápido
		this.streamsPoller = new Poller(() => this.refreshRoomStreams(), { intervalMs: 5_000 });
		this.pollers = [
			this.streamsPoller,
			this.heartbeatPoller,
			this.roomsPoller,
			this.friendsPoller,
			this.usersPoller,
			// Fontes locais (sem API): mantidas com a janela oculta por causa do Stream Deck
			new Poller(() => this.refreshSources(), { intervalMs: 15_000, hiddenFactor: 1 }),
		];
		if (this.serverSupportsEvents) this.applyPollIntervals(POLL_INTERVALS.withServerEvents);
		this.heartbeatPoller.start(true);
		for (const poller of this.pollers.slice(1)) poller.start();

		// Re-tenta conexões P2P pendentes usando os dados já carregados (sem chamar a API)
		this.autoConnectRetryInterval = setInterval(() => {
			if (this.currentRoom?.activeStreams?.length) this.autoConnectRoomStreams();
		}, 10_000);

		this.thumbnailInterval = setInterval(() => this.updateAllThumbnails(), 120_000); // Atualiza preview estática a cada 2 minutos
	}

	private stopPolling(): void {
		for (const poller of this.pollers) poller.stop();
		this.pollers = [];
		this.heartbeatPoller = this.roomsPoller = this.friendsPoller = this.usersPoller = this.streamsPoller = null;

		for (const timer of this.serverEventTimers.values()) clearTimeout(timer);
		this.serverEventTimers.clear();

		if (this.autoConnectRetryInterval) {
			clearInterval(this.autoConnectRetryInterval);
			this.autoConnectRetryInterval = null;
		}
		if (this.thumbnailInterval) {
			clearInterval(this.thumbnailInterval);
			this.thumbnailInterval = null;
		}
	}

	/**
	 * Reage aos avisos de mudança enviados pelo servidor via SSE.
	 * Registrado uma única vez, logo no setup da UI: o SSE abre no login e o "hello"
	 * costuma chegar antes de os pollers existirem, por isso o estado fica em serverSupportsEvents.
	 */
	private subscribeServerEvents(): void {
		if (!window.api?.onSseSignal) return;
		window.api.onSseSignal((event, data) => {
			switch (event) {
				case "hello": {
					if ((data as { events?: boolean } | null)?.events) {
						this.serverSupportsEvents = true;
						this.applyPollIntervals(POLL_INTERVALS.withServerEvents);
					}
					// Reconexão do SSE: avisos podem ter sido perdidos enquanto estava fora
					if (this.serverEventsHelloCount++ > 0) {
						this.roomsPoller?.trigger();
						this.friendsPoller?.trigger();
						this.usersPoller?.trigger();
					}
					break;
				}
				case "rooms-changed":
					this.scheduleServerRefresh(event, this.roomsPoller);
					break;
				case "friends-changed":
					this.scheduleServerRefresh(event, this.friendsPoller);
					break;
				case "users-changed":
					this.scheduleServerRefresh(event, this.usersPoller);
					break;
			}
		});
	}

	/**
	 * Agrupa avisos em sequência e espalha os clientes no tempo (jitter), para que um aviso
	 * enviado a todos não faça todo mundo chamar a API no mesmo milissegundo.
	 */
	private scheduleServerRefresh(key: string, poller: Poller | null): void {
		if (!poller || this.serverEventTimers.has(key)) return;
		const delay = 250 + Math.random() * 1000;
		this.serverEventTimers.set(
			key,
			setTimeout(() => {
				this.serverEventTimers.delete(key);
				poller.trigger();
			}, delay),
		);
	}

	private applyPollIntervals(intervals: PollIntervals): void {
		this.heartbeatPoller?.setIntervalMs(intervals.heartbeat);
		this.roomsPoller?.setIntervalMs(intervals.rooms);
		this.friendsPoller?.setIntervalMs(intervals.friends);
		this.usersPoller?.setIntervalMs(intervals.users);
	}

	// ------------------------------------------------------------------------------------------------------------------------------
	//  TUTORIAL GUIADO
	// ------------------------------------------------------------------------------------------------------------------------------
	private tutorialSeenKey(): string | null {
		const user = getUser();
		return user ? `shiro_tutorial_seen_${user.id}` : null;
	}

	private markTutorialSeen(): void {
		const key = this.tutorialSeenKey();
		if (!key) return;
		try {
			localStorage.setItem(key, "1");
		} catch {}
	}

	/** No primeiro login desta conta neste PC, pergunta se o usuário quer fazer o tutorial */
	private maybeShowTutorialWelcome(): void {
		const key = this.tutorialSeenKey();
		if (!key) return;
		let seen = false;
		try {
			seen = localStorage.getItem(key) === "1";
		} catch {}
		if (seen || this.tutorial?.isActive()) return;
		document.getElementById("modal-tutorial-welcome")?.classList.remove("hidden");
	}

	private setupTutorial(): void {
		const modal = document.getElementById("modal-tutorial-welcome");
		const close = () => {
			modal?.classList.add("hidden");
			this.markTutorialSeen();
		};

		document.getElementById("btn-tutorial-welcome-skip")?.addEventListener("click", close);
		document.getElementById("btn-tutorial-welcome-start")?.addEventListener("click", () => {
			close();
			this.startTutorial();
		});
		// (startTutorial já leva o usuário para a aba Salas antes da primeira etapa)
		modal?.addEventListener("click", (e) => {
			if (e.target === modal) close();
		});
		document.getElementById("btn-start-tutorial")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.startTutorial();
		});
	}

	private startTutorial(): void {
		this.tutorial?.stop(false);
		this.markTutorialSeen();

		const click = (id: string) => (document.getElementById(id) as HTMLElement | null)?.click();

		// O tour começa no lugar certo: sai da transmissão maximizada, fecha popovers e abre a aba Salas
		if (this.maximizedStreamId) this.restoreGridMode();
		document.getElementById("settings-popover")?.classList.add("hidden");
		document.getElementById("audio-popover")?.classList.add("hidden");
		const expandSidebar = () => {
			if (document.querySelector(".main-content.sidebar-collapsed")) click("btn-toggle-sidebar");
		};
		const isHidden = (id: string) => document.getElementById(id)?.classList.contains("hidden") ?? true;
		const openPopover = (popoverId: string, toggleId: string) => {
			if (isHidden(popoverId)) click(toggleId);
		};
		const closePopover = (popoverId: string, closeId: string) => {
			if (!isHidden(popoverId)) click(closeId);
		};
		const selectedSource = () =>
			this.leftSourcePicker?.getSelectedSource() ?? this.mainSourcePicker?.getSelectedSource() ?? null;

		const steps: TourStep[] = [
			{
				title: "Entre em uma sala",
				text: `Toda transmissão acontece dentro de uma sala. Clique em <b>Criar</b> para criar a sua:
					<b>sem senha</b> ela fica <b>pública</b>; com uma <b>senha de 8 dígitos</b> ela fica <b>privada</b>.
					Já tem o ID de uma sala? Use <b>Entrar por ID</b>, ou clique em uma sala da lista.`,
				target: () => document.querySelector(".rooms-header-actions"),
				onEnter: () => {
					expandSidebar();
					click("panel-tab-rooms");
				},
				completeWhen: () => !!this.currentRoom,
				waitingHint: "Crie ou entre em uma sala para continuar",
			},
			{
				title: "Escolha o que transmitir",
				text: `Selecione a <b>janela</b> (um jogo, o navegador…) ou a <b>tela inteira</b> que você quer compartilhar.
					Use as abas <b>Janelas</b> e <b>Telas</b> para alternar.`,
				target: () => document.getElementById("panel-sources"),
				onEnter: () => {
					expandSidebar();
					click("panel-tab-sources");
				},
				completeWhen: () => !!selectedSource(),
				waitingHint: "Clique em uma janela ou tela para continuar",
			},
			{
				title: "Ajuste a qualidade",
				text: `Escolha a <b>resolução</b> e o <b>FPS</b> da transmissão. <b>1080p a 60 FPS</b> é o ideal para a maioria;
					se a internet de quem assiste for mais fraca, use <b>720p</b>.`,
				target: () => document.getElementById("settings-popover"),
				onEnter: () => openPopover("settings-popover", "btn-toggle-settings"),
				onExit: () => closePopover("settings-popover", "btn-close-settings"),
			},
			{
				title: "Escolha o áudio",
				text: `<b>Áudio do Processo</b>: só o som da janela escolhida (ideal para jogos).<br>
					<b>Áudio do Sistema</b>: todo o som do PC.<br>
					<b>Desativado</b>: transmite só o vídeo.`,
				target: () => document.getElementById("audio-popover"),
				onEnter: () => openPopover("audio-popover", "btn-toggle-audio"),
				onExit: () => closePopover("audio-popover", "btn-close-audio"),
			},
			{
				title: "Comece a transmitir",
				text: `Tudo pronto! Clique em <b>Iniciar transmissão</b> e quem estiver na sala já vai ver sua tela.`,
				target: () => document.getElementById("btn-start-stream"),
				completeWhen: () => !!this.p2pManager?.getIsStreaming(),
				waitingHint: "Clique em Iniciar transmissão",
			},
			{
				title: "Você está ao vivo! 🎉",
				text: `Para parar, clique em <b>Encerrar transmissão</b>. Chame seus amigos pela aba <b>Amigos</b>
					ou compartilhe o ID da sala. Quer rever este tour? É só clicar no <b>?</b> no topo da tela.`,
				target: () => document.getElementById("btn-stop-stream"),
				nextLabel: "Concluir",
			},
		];

		this.tutorial = new GuidedTour(steps, {
			onFinish: () => {
				this.tutorial = null;
			},
		});
		this.tutorial.start();
	}

	/**
	 * Na transmissão maximizada, a pílula de controles some (desliza para baixo) quando o
	 * mouse está longe dela ou a janela perde o foco, e volta ao aproximar o mouse do rodapé.
	 */
	private setupControlsAutoHide(): void {
		const section = document.querySelector<HTMLElement>(".right-section");
		const bar = document.querySelector<HTMLElement>(".bottom-controls-bar");
		if (!section || !bar) return;

		const REVEAL_DISTANCE_PX = 160; // distância do rodapé que revela a pílula
		const HIDE_DELAY_MS = 700;
		let hideTimer: ReturnType<typeof setTimeout> | null = null;

		const isMaximized = () => section.classList.contains("maximized-active");
		const popoverOpen = () =>
			["settings-popover", "audio-popover"].some((id) => !document.getElementById(id)?.classList.contains("hidden"));

		const show = () => {
			if (hideTimer) clearTimeout(hideTimer);
			hideTimer = null;
			bar.classList.remove("controls-hidden");
		};
		const scheduleHide = (delay = HIDE_DELAY_MS) => {
			if (hideTimer) clearTimeout(hideTimer);
			hideTimer = setTimeout(() => {
				hideTimer = null;
				// Não esconde com um popover aberto nem com o mouse em cima da pílula
				if (isMaximized() && !popoverOpen() && !bar.matches(":hover")) {
					bar.classList.add("controls-hidden");
				}
			}, delay);
		};

		section.addEventListener("mousemove", (e) => {
			if (!isMaximized()) return;
			const nearBottom = section.getBoundingClientRect().bottom - e.clientY <= REVEAL_DISTANCE_PX;
			if (nearBottom) show();
			else if (!hideTimer) scheduleHide();
		});
		section.addEventListener("mouseleave", () => {
			if (isMaximized()) scheduleHide(300);
		});
		window.addEventListener("blur", () => {
			if (isMaximized()) scheduleHide(0);
		});
		document.addEventListener("visibilitychange", () => {
			if (document.hidden && isMaximized()) scheduleHide(0);
		});

		// Ao maximizar, mostra a pílula por um instante e depois recolhe; ao restaurar, volta ao normal.
		// Só reage à transição: o grid reaplica a mesma classe várias vezes ao re-renderizar.
		let wasMaximized = isMaximized();
		new MutationObserver(() => {
			const maximized = isMaximized();
			if (maximized === wasMaximized) return;
			wasMaximized = maximized;
			show();
			if (maximized) scheduleHide(2500);
		}).observe(section, { attributes: true, attributeFilter: ["class"] });
	}

	private setupPanelTabs(): void {
		const tabRooms = document.getElementById("panel-tab-rooms");
		const tabSources = document.getElementById("panel-tab-sources");
		const tabFriends = document.getElementById("panel-tab-friends");
		const tabUsers = document.getElementById("panel-tab-users");
		const btnToggleSidebar = document.getElementById("btn-toggle-sidebar");

		const panelRooms = document.getElementById("panel-rooms");
		const panelSources = document.getElementById("panel-sources");
		const panelFriends = document.getElementById("panel-friends");
		const panelUsers = document.getElementById("panel-users");

		const activate = (activeTab: HTMLElement | null, activePanel: HTMLElement | null) => {
			[tabRooms, tabSources, tabFriends, tabUsers].forEach((t) => t?.classList.remove("active"));
			[panelRooms, panelSources, panelFriends, panelUsers].forEach((p) => p?.classList.add("hidden"));

			activeTab?.classList.add("active");
			activePanel?.classList.remove("hidden");
			this.refreshIcons();
		};

		tabRooms?.addEventListener("click", () => activate(tabRooms, panelRooms));
		tabSources?.addEventListener("click", () => {
			if (!this.currentRoom) return;
			activate(tabSources, panelSources);
		});
		tabFriends?.addEventListener("click", () => {
			activate(tabFriends, panelFriends);
			this.refreshFriends();
		});
		tabUsers?.addEventListener("click", () => activate(tabUsers, panelUsers));

		const toggleSidebar = () => {
			const mainContent = document.querySelector(".main-content");
			mainContent?.classList.toggle("sidebar-collapsed");
			this.refreshIcons();
		};

		btnToggleSidebar?.addEventListener("click", toggleSidebar);
		document.getElementById("btn-expand-sidebar-floating")?.addEventListener("click", toggleSidebar);
	}

	// ------------------------------------------------------------------------------------------------------------------------------
	//  ROOMS, MODALS & SEARCH
	// ------------------------------------------------------------------------------------------------------------------------------
	private setupRoomListeners(): void {
		// Abrir modal de criação de sala
		document.getElementById("btn-open-create-room")?.addEventListener("click", () => {
			const modal = document.getElementById("modal-create-room");
			if (modal) modal.classList.remove("hidden");
			const nameInput = document.getElementById("create-room-name") as HTMLInputElement | null;
			const idInput = document.getElementById("create-room-id") as HTMLInputElement | null;
			const passInput = document.getElementById("create-room-password") as HTMLInputElement | null;
			const err = document.getElementById("create-room-error");
			if (nameInput) nameInput.value = "";
			if (idInput) idInput.value = "";
			if (passInput) passInput.value = "";
			if (err) err.textContent = "";
			nameInput?.focus();
			this.refreshIcons();
		});

		const closeCreateModal = () => {
			document.getElementById("modal-create-room")?.classList.add("hidden");
			const nameInput = document.getElementById("create-room-name") as HTMLInputElement | null;
			const idInput = document.getElementById("create-room-id") as HTMLInputElement | null;
			const passInput = document.getElementById("create-room-password") as HTMLInputElement | null;
			const err = document.getElementById("create-room-error");
			if (nameInput) nameInput.value = "";
			if (idInput) idInput.value = "";
			if (passInput) passInput.value = "";
			if (err) err.textContent = "";
		};
		document.getElementById("btn-close-create-room")?.addEventListener("click", closeCreateModal);
		document.getElementById("btn-cancel-create-room")?.addEventListener("click", closeCreateModal);

		// Botão Gerar Senha (8 dígitos numéricos aleatórios)
		document.getElementById("btn-generate-password")?.addEventListener("click", () => {
			const randomPass = Math.floor(10000000 + Math.random() * 90000000).toString();
			const passInput = document.getElementById("create-room-password") as HTMLInputElement | null;
			if (passInput) passInput.value = randomPass;
		});

		// Submeter formulário de criar sala
		document.getElementById("form-create-room")?.addEventListener("submit", async (e) => {
			e.preventDefault();
			const form = e.currentTarget as HTMLFormElement;
			const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
			if (submitBtn?.disabled) return;

			const name = (document.getElementById("create-room-name") as HTMLInputElement)?.value.trim();
			const customId = (document.getElementById("create-room-id") as HTMLInputElement)?.value.trim();
			const password = (document.getElementById("create-room-password") as HTMLInputElement)?.value.trim();
			const errorEl = document.getElementById("create-room-error");

			if (!name) {
				if (errorEl) errorEl.textContent = "Digite o nome da sala.";
				return;
			}

			if (password && !/^\d{8}$/.test(password)) {
				if (errorEl) errorEl.textContent = "A senha deve conter exatamente 8 dígitos numéricos.";
				return;
			}

			if (submitBtn) {
				submitBtn.disabled = true;
				submitBtn.innerHTML = `<i data-lucide="loader-2" class="spin"></i> <span>Criando Sala...</span>`;
				this.refreshIcons();
			}

			if (errorEl) errorEl.textContent = "";
			try {
				const res = await createRoom({ name, roomId: customId || undefined, password: password || undefined });

				if (!res.ok || !res.room) {
					if (errorEl) errorEl.textContent = res.error ?? "Erro ao criar sala.";
					if (submitBtn) {
						submitBtn.disabled = false;
						submitBtn.innerHTML = `<span>Criar Sala</span>`;
					}
					return;
				}

				closeCreateModal();
				await this.refreshRooms();
				await this.onRoomSelected(res.room);
			} catch (err: any) {
				if (errorEl) errorEl.textContent = err?.message || "Erro ao criar sala.";
			} finally {
				if (submitBtn) {
					submitBtn.disabled = false;
					submitBtn.innerHTML = `<span>Criar Sala</span>`;
				}
			}
		});

		// Abrir modal de Buscar / Entrar em Sala por ID
		document.getElementById("btn-open-join-by-id")?.addEventListener("click", () => {
			const modal = document.getElementById("modal-join-by-id");
			if (modal) modal.classList.remove("hidden");

			const tabId = document.getElementById("tab-join-mode-id");
			const tabInvite = document.getElementById("tab-join-mode-invite");
			const formId = document.getElementById("form-join-by-id");
			const formInvite = document.getElementById("form-join-by-invite-code");
			const indicator = document.getElementById("join-tab-indicator");

			tabId?.classList.add("active");
			tabInvite?.classList.remove("active");
			indicator?.classList.remove("on-register");
			formId?.classList.remove("hidden");
			formInvite?.classList.add("hidden");

			const idInput = document.getElementById("join-by-id-room-id") as HTMLInputElement | null;
			const passInput = document.getElementById("join-by-id-password") as HTMLInputElement | null;
			const inviteInput = document.getElementById("join-invite-code-input") as HTMLInputElement | null;
			const err1 = document.getElementById("join-by-id-error");
			const err2 = document.getElementById("join-by-invite-error");
			if (idInput) idInput.value = "";
			if (passInput) passInput.value = "";
			if (inviteInput) inviteInput.value = "";
			if (err1) err1.textContent = "";
			if (err2) err2.textContent = "";

			idInput?.focus();
			this.refreshIcons();
		});

		const closeJoinByIdModal = () => {
			document.getElementById("modal-join-by-id")?.classList.add("hidden");
			const idInput = document.getElementById("join-by-id-room-id") as HTMLInputElement | null;
			const passInput = document.getElementById("join-by-id-password") as HTMLInputElement | null;
			const inviteInput = document.getElementById("join-invite-code-input") as HTMLInputElement | null;
			const err1 = document.getElementById("join-by-id-error");
			const err2 = document.getElementById("join-by-invite-error");
			if (idInput) idInput.value = "";
			if (passInput) passInput.value = "";
			if (inviteInput) inviteInput.value = "";
			if (err1) err1.textContent = "";
			if (err2) err2.textContent = "";
		};
		document.getElementById("btn-close-join-by-id")?.addEventListener("click", closeJoinByIdModal);
		document.getElementById("btn-cancel-join-by-id")?.addEventListener("click", closeJoinByIdModal);

		// Submeter formulário de Entrar por ID (pública ou privada)
		document.getElementById("form-join-by-id")?.addEventListener("submit", async (e) => {
			e.preventDefault();
			const roomId = (document.getElementById("join-by-id-room-id") as HTMLInputElement)?.value.trim();
			const password = (document.getElementById("join-by-id-password") as HTMLInputElement)?.value.trim();
			const errorEl = document.getElementById("join-by-id-error");

			if (!roomId) {
				if (errorEl) errorEl.textContent = "Digite o ID da sala.";
				return;
			}

			if (errorEl) errorEl.textContent = "";
			const res = await joinRoom(roomId, password || undefined);

			if (!res.ok || !res.room) {
				if (errorEl) errorEl.textContent = res.error ?? "Não foi possível entrar na sala.";
				return;
			}

			closeJoinByIdModal();
			await this.onRoomSelected(res.room);
		});

		// Fechar/Cancelar modal de senha para entrar
		const closeJoinModal = () => {
			document.getElementById("modal-join-room-password")?.classList.add("hidden");
			const passInput = document.getElementById("join-room-password") as HTMLInputElement | null;
			const err = document.getElementById("join-room-error");
			if (passInput) passInput.value = "";
			if (err) err.textContent = "";
			this.targetJoinRoomId = null;
		};
		document.getElementById("btn-close-join-room")?.addEventListener("click", closeJoinModal);
		document.getElementById("btn-cancel-join-room")?.addEventListener("click", closeJoinModal);

		// Submeter formulário de senha para entrar na sala privada
		document.getElementById("form-join-room-password")?.addEventListener("submit", async (e) => {
			e.preventDefault();
			if (!this.targetJoinRoomId) return;

			const password = (document.getElementById("join-room-password") as HTMLInputElement)?.value.trim();
			const errorEl = document.getElementById("join-room-error");

			if (!password || !/^\d{8}$/.test(password)) {
				if (errorEl) errorEl.textContent = "Digite a senha de exatamente 8 dígitos.";
				return;
			}

			if (errorEl) errorEl.textContent = "";
			const res = await joinRoom(this.targetJoinRoomId, password);

			if (!res.ok || !res.room) {
				if (errorEl) errorEl.textContent = res.error ?? "Senha incorreta.";
				return;
			}

			closeJoinModal();
			await this.onRoomSelected(res.room);
		});

		// Lupa de busca em tempo real na lista de salas
		document.getElementById("input-search-rooms")?.addEventListener("input", (e) => {
			const query = (e.target as HTMLInputElement).value.toLowerCase();
			this.renderRoomsList(query);
		});

		// Botão de atualizar salas
		document.getElementById("btn-refresh-rooms")?.addEventListener("click", () => this.refreshRooms());

		// Botão de voltar ao grid quando maximizado
		document.getElementById("btn-back-to-grid")?.addEventListener("click", () => this.restoreGridMode());

		// Botão de sair da sala atual
		document.getElementById("btn-leave-current-room")?.addEventListener("click", async () => {
			if (!this.currentRoom) return;
			const roomId = this.currentRoom.roomId;
			if (this.p2pManager?.getIsStreaming()) {
				await this.stopStreaming();
			}
			await leaveRoom(roomId);
			this.p2pManager?.hangupAll();
			this.remoteStreams.clear();
			this.currentRoom = null;
			this.maximizedStreamId = null;

			// Atualiza banner e header
			this.updateCurrentRoomBanner();

			// Desabilita aba de fontes
			const sourcesTab = document.getElementById("panel-tab-sources");
			if (sourcesTab) {
				sourcesTab.classList.add("disabled");
				sourcesTab.setAttribute("disabled", "true");
				sourcesTab.removeAttribute("data-tooltip");
				sourcesTab.title = "";
			}
			const sourcesWrapper = sourcesTab?.closest(".panel-tab-wrapper");
			if (sourcesWrapper) {
				sourcesWrapper.setAttribute("data-tooltip", "Entre em uma sala para liberar as fontes");
			}

			// Volta para aba de salas
			const tabRooms = document.getElementById("panel-tab-rooms");
			const panelRooms = document.getElementById("panel-rooms");
			const tabSources = document.getElementById("panel-tab-sources");
			const panelSources = document.getElementById("panel-sources");
			const tabUsers = document.getElementById("panel-tab-users");
			const panelUsers = document.getElementById("panel-users");

			[tabSources, tabUsers].forEach((t) => t?.classList.remove("active"));
			[panelSources, panelUsers].forEach((p) => p?.classList.add("hidden"));
			tabRooms?.classList.add("active");
			panelRooms?.classList.remove("hidden");

			await this.refreshRooms();
			this.renderLiveStreamsGrid();
		});

		// Botão de copiar ID da sala ativa
		document.getElementById("btn-copy-current-room-id")?.addEventListener("click", () => {
			if (!this.currentRoom) return;
			navigator.clipboard.writeText(this.currentRoom.roomId);
			const btn = document.getElementById("btn-copy-current-room-id");
			if (btn) {
				btn.classList.add("copied");
				btn.innerHTML = `<i data-lucide="check"></i>`;
				this.refreshIcons();
				setTimeout(() => {
					btn.classList.remove("copied");
					btn.innerHTML = `<i data-lucide="copy"></i>`;
					this.refreshIcons();
				}, 1500);
			}
		});

		// Botão de copiar Código de Convite da sala ativa (Apenas dono da sala)
		document.getElementById("btn-copy-invite-code")?.addEventListener("click", () => {
			const user = getUser();
			const isOwner = !!(user && this.currentRoom && (this.currentRoom.ownerId === user.id || this.currentRoom.createdBy === user.username));
			if (!isOwner || !this.currentRoom?.inviteCode) return;
			navigator.clipboard.writeText(this.currentRoom.inviteCode);
			const btn = document.getElementById("btn-copy-invite-code");
			if (btn) {
				btn.classList.add("copied");
				btn.innerHTML = `<i data-lucide="check"></i>`;
				this.refreshIcons();
				setTimeout(() => {
					btn.classList.remove("copied");
					btn.innerHTML = `<i data-lucide="key-round"></i>`;
					this.refreshIcons();
				}, 1500);
			}
		});
	}

	private getRoomMembersCount(room?: any): number {
		if (!room) return 1;

		if (Array.isArray(room.members)) {
			// O servidor pode ter membros duplicados (entradas simultâneas antigas): conta cada um uma vez
			const uniqueMembers = Array.from(
				new Map((room.members as any[]).map((m) => [typeof m === "string" ? m : m?.id || m?.userId || m?.username, m])).values(),
			);
			if (this.onlineUsers && this.onlineUsers.length > 0) {
				const activeMembers = uniqueMembers.filter((m: any) => {
					const id = typeof m === "string" ? m : m?.id || m?.userId;
					const name = typeof m === "string" ? m : m?.username || m?.name;
					return this.onlineUsers.some((u) => u.id === id || u.username === name);
				});
				if (activeMembers.length > 0) return activeMembers.length;
			}
			return uniqueMembers.length;
		}

		if (Array.isArray(room.users)) {
			if (this.onlineUsers && this.onlineUsers.length > 0) {
				const activeUsers = room.users.filter((u: any) => {
					const id = typeof u === "string" ? u : u?.id || u?.userId;
					const name = typeof u === "string" ? u : u?.username || u?.name;
					return this.onlineUsers.some((ou) => ou.id === id || ou.username === name);
				});
				if (activeUsers.length > 0) return activeUsers.length;
			}
			return room.users.length;
		}

		if (typeof room.membersCount === "number" && !isNaN(room.membersCount)) return room.membersCount;
		if (typeof room.memberCount === "number" && !isNaN(room.memberCount)) return room.memberCount;
		if (typeof room.members === "number" && !isNaN(room.members)) return room.members;
		return 1;
	}

	private updateCurrentRoomBanner(): void {
		// Toda troca de sala passa por aqui: mantém o painel de usuários filtrado pela sala atual
		this.renderUsersList();

		const banner = document.getElementById("current-room-banner");
		const headerPill = document.getElementById("header-room-pill");
		const headerRoomName = document.getElementById("header-room-name-text");
		const headerRoomIcon = document.getElementById("header-room-icon");

		if (!this.currentRoom) {
			banner?.classList.add("hidden");
			headerPill?.classList.add("hidden");
			return;
		}

		if (banner) {
			banner.classList.remove("hidden");
			if (this.currentRoom.isPrivate) {
				banner.classList.add("is-private");
			} else {
				banner.classList.remove("is-private");
			}

			const badgeEl = document.getElementById("current-room-type-badge");
			if (badgeEl) {
				if (this.currentRoom.roomId === "GERAL") {
					badgeEl.className = "badge badge-global";
					badgeEl.innerHTML = `<i data-lucide="globe" class="badge-icon"></i> <span id="current-room-type-text">SALA GLOBAL</span>`;
				} else if (this.currentRoom.isPrivate) {
					badgeEl.className = "badge badge-private";
					badgeEl.innerHTML = `<i data-lucide="lock" class="badge-icon"></i> <span id="current-room-type-text">SALA PRIVADA</span>`;
				} else {
					badgeEl.className = "badge badge-public";
					badgeEl.innerHTML = `<i data-lucide="radio" class="badge-icon"></i> <span id="current-room-type-text">SALA PÚBLICA</span>`;
				}
			}

			const nameEl = document.getElementById("current-room-name");
			if (nameEl) nameEl.textContent = this.currentRoom.name;

			const idCodeEl = document.getElementById("current-room-id-code");
			if (idCodeEl) idCodeEl.textContent = this.currentRoom.roomId;

			const user = getUser();
			const isOwner = !!(user && this.currentRoom && (this.currentRoom.ownerId === user.id || this.currentRoom.createdBy === user.username));

			const members = this.getRoomMembersCount(this.currentRoom);
			const maxMembers = this.currentRoom.maxMembers || 20;
			const streams = Array.isArray(this.currentRoom.activeStreams) ? this.currentRoom.activeStreams.length : 0;

			const membersEl = document.getElementById("current-room-members-count");
			if (membersEl) membersEl.innerHTML = `<i data-lucide="users"></i> ${members}/${maxMembers} membro(s)`;

			const streamsEl = document.getElementById("current-room-streams-count");
			if (streamsEl) streamsEl.innerHTML = `<i data-lucide="radio"></i> ${streams} ao vivo`;

			const copyBtn = document.getElementById("btn-copy-current-room-id");
			if (copyBtn && !copyBtn.querySelector("svg")) {
				copyBtn.innerHTML = `<i data-lucide="copy"></i>`;
			}

			const copyInviteBtn = document.getElementById("btn-copy-invite-code");
			if (copyInviteBtn) {
				if (isOwner && this.currentRoom.inviteCode) {
					copyInviteBtn.classList.remove("hidden");
					copyInviteBtn.title = `Copiar Código de Convite (${this.currentRoom.inviteCode})`;
				} else {
					copyInviteBtn.classList.add("hidden");
				}
			}

			const btnSettings = document.getElementById("btn-room-settings");
			if (btnSettings) {
				if (isOwner) {
					btnSettings.classList.remove("hidden");
				} else {
					btnSettings.classList.add("hidden");
				}
			}
		}

		if (headerPill && headerRoomName) {
			headerPill.classList.remove("hidden");
			headerRoomName.textContent = this.currentRoom.name;
			if (this.currentRoom.roomId === "GERAL") {
				headerPill.classList.remove("is-private");
				if (headerRoomIcon) headerRoomIcon.setAttribute("data-lucide", "globe");
			} else if (this.currentRoom.isPrivate) {
				headerPill.classList.add("is-private");
				if (headerRoomIcon) headerRoomIcon.setAttribute("data-lucide", "lock");
			} else {
				headerPill.classList.remove("is-private");
				if (headerRoomIcon) headerRoomIcon.setAttribute("data-lucide", "radio");
			}
		}

		this.refreshIcons();
	}

	private async refreshRooms(): Promise<boolean> {
		let ok = false;
		try {
			const res = await getRooms();
			if (res.ok) {
				this.rooms = res.rooms;
				this.roomsLoaded = true;
				ok = true;
			}
		} catch (err) {
			console.warn("[App] Erro ao carregar lista de salas:", err);
		}
		// Falha sem nenhum dado anterior: mostra erro em vez de "nenhuma sala"
		if (!ok && !this.roomsLoaded) {
			const listEl = document.getElementById("rooms-list");
			if (listEl) {
				listEl.innerHTML = `
				<div class="users-empty">
					<i data-lucide="wifi-off"></i>
					<span>Não foi possível carregar as salas. Tentando novamente...</span>
				</div>`;
				this.refreshIcons();
			}
			return false;
		}
		const searchInput = document.getElementById("input-search-rooms") as HTMLInputElement | null;
		const query = searchInput?.value.toLowerCase() ?? "";
		this.renderRoomsList(query);

		// Atualiza o estado da sala ativa e auto-conecta as transmissoes ativas
		if (this.currentRoom) {
			const updated = this.rooms.find((r) => r.roomId === this.currentRoom!.roomId);
			if (updated) {
				this.currentRoom = updated;
				this.autoConnectRoomStreams();
			}
		}
		this.updateCurrentRoomBanner();
		return ok;
	}

	/**
	 * Atualiza só as transmissões ativas da sala atual (endpoint leve /api/rooms/streams).
	 * Se mudou algo, atualiza o banner e conecta nas transmissões novas na hora.
	 */
	private async refreshRoomStreams(): Promise<boolean> {
		const room = this.currentRoom;
		if (!room) return true;

		const streams = await getRoomStreams(room.roomId);
		if (streams === null) return false;
		// O usuário pode ter trocado de sala enquanto a requisição estava em andamento
		if (this.currentRoom?.roomId !== room.roomId) return true;

		const key = (list: { userId: string }[] | undefined) => (list ?? []).map((s) => s.userId).sort().join(",");
		if (key(streams) !== key(this.currentRoom.activeStreams)) {
			this.currentRoom.activeStreams = streams;
			const listed = this.rooms.find((r) => r.roomId === room.roomId);
			if (listed) listed.activeStreams = streams;
			this.updateCurrentRoomBanner();
			this.renderRoomsList((document.getElementById("input-search-rooms") as HTMLInputElement | null)?.value.toLowerCase() ?? "");
		}
		// Conecta em transmissões ainda fora do grid (sem custo de API: usa os dados acima)
		await this.autoConnectRoomStreams();
		return true;
	}

	private async autoConnectRoomStreams(): Promise<void> {
		if (!this.currentRoom) return;
		const currentUser = getUser();
		const activeStreams = this.currentRoom.activeStreams || [];

		// 1. Remove qualquer remoteStream que não esteja mais transmitindo nesta sala
		for (const [peerId] of this.remoteStreams) {
			const isStillStreaming = activeStreams.some((s) => s.userId === peerId);
			if (!isStillStreaming) {
				console.log(`[App] Transmissão de ${peerId} encerrada. Removendo do grid.`);
				this.p2pManager?.closePeer(peerId);
				this.remoteStreams.delete(peerId);
				if (this.maximizedStreamId === `stream-card-${peerId}`) {
					this.restoreGridMode();
				} else {
					this.renderLiveStreamsGrid();
				}
			}
		}

		// 2. Conecta a qualquer transmissão ativa na sala que ainda não esteja visível
		if (this.autoConnectInFlight) return;
		this.autoConnectInFlight = true;
		try {
			for (const streamInfo of activeStreams) {
				const peerId = streamInfo.userId;
				if (!peerId || peerId === currentUser?.id || this.remoteStreams.has(peerId)) continue;

				// Tentativa recente ainda em andamento: aguarda em vez de reofertar por cima
				if (this.p2pManager?.isConnecting(peerId, 20_000)) continue;

				// Conectado mas sem mídia: renegocia na mesma conexão.
				// Sem conexão, ou presa conectando há mais de 20s: recomeça do zero.
				const connected = this.p2pManager?.isConnected(peerId) ?? false;
				console.log(`[App] Detectada stream ativa de ${streamInfo.username} (${peerId}) fora do grid. ${connected ? "Renegociando" : "Iniciando nova conexão"} P2P...`);
				await this.p2pManager?.renegotiate(peerId, !connected);
			}
		} finally {
			this.autoConnectInFlight = false;
		}
	}

	private renderRoomsList(searchQuery = ""): void {
		this.updateCurrentRoomBanner();

		const listEl = document.getElementById("rooms-list");
		if (!listEl) return;

		const filtered = this.rooms.filter(
			(r) =>
				r.name.toLowerCase().includes(searchQuery) ||
				r.roomId.toLowerCase().includes(searchQuery),
		);

		if (filtered.length === 0) {
			listEl.innerHTML = `
				<div class="users-empty">
					<i data-lucide="radio"></i>
					<span>${searchQuery ? "Nenhuma sala encontrada para a busca" : "Nenhuma sala pública disponível"}</span>
				</div>`;
			this.refreshIcons();
			return;
		}

		listEl.innerHTML = filtered
			.map((r) => {
				const isActive = this.currentRoom?.roomId === r.roomId;
				const streamCount = Array.isArray(r.activeStreams) ? r.activeStreams.length : 0;
				const membersCount = this.getRoomMembersCount(r);

				const isGlobal = r.roomId === "GERAL";
				return `
				<div class="room-item ${isActive ? "active" : ""} ${isGlobal ? "room-global" : ""}" data-room-id="${r.roomId}">
					<div class="room-item-left">
						<i data-lucide="${isGlobal ? "globe" : "radio"}" class="room-item-icon ${isGlobal ? "icon-global" : ""}"></i>
						<div class="room-item-details">
							<span class="room-item-name">${this.escapeHtml(r.name)}</span>
							<span class="room-item-sub">ID: ${r.roomId} - ${membersCount} membro(s)</span>
						</div>
					</div>
					<div class="room-item-right">
						${isGlobal ? '<span class="room-global-badge"><i data-lucide="globe"></i> GLOBAL</span>' : ""}
						${r.isPrivate ? '<span class="room-lock-badge" title="Sala Privada (Protegida por senha)"><i data-lucide="lock"></i></span>' : ""}
						${streamCount > 0 ? `<span class="room-streams-badge">${streamCount}</span>` : ""}
					</div>
				</div>`;
			})
			.join("");

		listEl.querySelectorAll<HTMLElement>(".room-item").forEach((item) => {
			item.addEventListener("click", async () => {
				const roomId = item.dataset.roomId!;
				const targetRoom = this.rooms.find((r) => r.roomId === roomId);
				if (!targetRoom) return;

				if (targetRoom.isPrivate && this.currentRoom?.roomId !== targetRoom.roomId) {
					this.targetJoinRoomId = targetRoom.roomId;
					const titleEl = document.getElementById("join-room-target-name");
					if (titleEl) titleEl.textContent = `${targetRoom.name} (${targetRoom.roomId})`;
					const modal = document.getElementById("modal-join-room-password");
					if (modal) modal.classList.remove("hidden");
					const passInput = document.getElementById("join-room-password") as HTMLInputElement | null;
					if (passInput) passInput.value = "";
					const errorEl = document.getElementById("join-room-error");
					if (errorEl) errorEl.textContent = "";
					passInput?.focus();
					this.refreshIcons();
				} else {
					const res = await joinRoom(targetRoom.roomId);
					if (res.ok && res.room) {
						await this.onRoomSelected(res.room);
					} else if (!res.ok) {
						alert(res.error || "Não foi possível entrar na sala.");
					}
				}
			});
		});

		this.refreshIcons();
	}

	private async onRoomSelected(room: RoomInfo): Promise<void> {
		if (this.currentRoom && this.currentRoom.roomId !== room.roomId) {
			if (this.p2pManager?.getIsStreaming()) {
				await this.stopStreaming();
			}
			await leaveRoom(this.currentRoom.roomId);
			this.p2pManager?.hangupAll();
			this.remoteStreams.clear();
			this.maximizedStreamId = null;
			this.renderLiveStreamsGrid();
		}

		this.currentRoom = room;
		console.log(`[App] Entrou na sala: ${room.name} (${room.roomId})`);
		this.updateCurrentRoomBanner();

		// Desbloqueia e ativa a aba de Fontes ao entrar na sala
		const sourcesTab = document.getElementById("panel-tab-sources");
		const panelSources = document.getElementById("panel-sources");
		const tabRooms = document.getElementById("panel-tab-rooms");
		const tabUsers = document.getElementById("panel-tab-users");
		const panelRooms = document.getElementById("panel-rooms");
		const panelUsers = document.getElementById("panel-users");

		if (sourcesTab) {
			sourcesTab.classList.remove("disabled");
			sourcesTab.removeAttribute("disabled");
			sourcesTab.setAttribute("data-tooltip", "Fontes de captura");
			sourcesTab.title = "";
		}
		const sourcesWrapper = sourcesTab?.closest(".panel-tab-wrapper");
		if (sourcesWrapper) {
			sourcesWrapper.removeAttribute("data-tooltip");
		}

		// Ativa a aba de fontes para o usuário selecionar o que transmitir
		[tabRooms, sourcesTab, tabUsers].forEach((t) => t?.classList.remove("active"));
		[panelRooms, panelSources, panelUsers].forEach((p) => p?.classList.add("hidden"));
		sourcesTab?.classList.add("active");
		panelSources?.classList.remove("hidden");

		// Auto-conecta as transmissões ativas já em andamento na sala
		await this.autoConnectRoomStreams();
		// Confere na hora quem está transmitindo (a sala recebida no join pode estar desatualizada)
		this.streamsPoller?.trigger();
		await this.refreshRooms();
	}

	// ------------------------------------------------------------------------------------------------------------------------------
	//  LIVE MULTI-STREAM GRID & MAXIMIZE
	// ------------------------------------------------------------------------------------------------------------------------------
	private renderLiveStreamsGrid(): void {
		const gridEl = document.getElementById("live-streams-grid");
		if (!gridEl) return;

		const isLocalStreaming = this.p2pManager?.getIsStreaming() && this.previewStream;

		if (this.remoteStreams.size === 0 && !isLocalStreaming) {
			gridEl.innerHTML = `
				<div id="main-grid-placeholder" class="main-grid-placeholder">
					<i data-lucide="radio" class="placeholder-lucide-icon"></i>
					<h3>Transmissões ao Vivo</h3>
					<p>Nenhuma transmissão ativa nesta sala. Selecione uma fonte ao lado e clique em <b>Iniciar Transmissão</b>!</p>
				</div>`;
			this.refreshIcons();
			return;
		}

		gridEl.innerHTML = "";

		if (isLocalStreaming && this.previewStream) {
			const isMax = this.maximizedStreamId === "local-preview";
			const localCard = document.createElement("div");
			localCard.className = `stream-card ${isMax ? "maximized" : ""}`;
			localCard.id = "stream-card-local";

			const user = getUser();
			localCard.innerHTML = `
				<div class="stream-card-header">
					<div class="stream-card-user">
						<i data-lucide="user"></i>
						<span>${this.escapeHtml(user?.username ?? "Você")} (Você Transmitindo)</span>
					</div>
					<span class="badge badge-live">AO VIVO</span>
				</div>
				<canvas class="stream-card-canvas ${isMax ? "hidden" : ""}"></canvas>
				<video class="stream-card-video ${isMax ? "" : "hidden"}" autoplay playsinline muted></video>
				<div class="stream-card-maximize-hint">
					<i data-lucide="target"></i> Clique para Maximizar
				</div>`;

			const videoEl = localCard.querySelector("video") as HTMLVideoElement;
			const canvasEl = localCard.querySelector("canvas") as HTMLCanvasElement;
			videoEl.srcObject = this.previewStream;
			videoEl.muted = true;
			videoEl.play().catch(() => { });

			this.captureInitialThumbnail(videoEl, canvasEl);

			localCard.addEventListener("click", () => this.toggleMaximizeStreamCard("local-preview", localCard));
			gridEl.appendChild(localCard);
		}

		for (const [peerId, remoteData] of this.remoteStreams) {
			const cardId = `stream-card-${peerId}`;
			const isMax = this.maximizedStreamId === cardId;
			const remoteCard = document.createElement("div");
			remoteCard.className = `stream-card ${isMax ? "maximized" : ""}`;
			remoteCard.id = cardId;

			const savedVol = this.getSavedStreamVolume(peerId);
			const volIcon = savedVol === 0 ? "volume-x" : (savedVol < 50 ? "volume-1" : "volume-2");

			remoteCard.innerHTML = `
				<div class="stream-card-header">
					<div class="stream-card-user">
						<i data-lucide="video"></i>
						<span>Transmissão de ${this.escapeHtml(remoteData.username)}</span>
					</div>
					<div class="stream-card-actions">
						<div class="stream-volume-control" title="Volume da transmissão">
							<button class="stream-vol-btn" title="Silenciar / Ativar som" type="button">
								<i data-lucide="${volIcon}"></i>
							</button>
							<input type="range" class="stream-vol-slider" min="0" max="100" value="${savedVol}">
							<span class="stream-vol-percent">${savedVol}%</span>
						</div>
						<span class="badge badge-live">AO VIVO</span>
					</div>
				</div>
				<canvas class="stream-card-canvas ${isMax ? "hidden" : ""}"></canvas>
				<video class="stream-card-video ${isMax ? "" : "hidden"}" autoplay playsinline></video>
				<div class="stream-card-maximize-hint">
					<i data-lucide="target"></i> Clique para Maximizar
				</div>`;

			const videoEl = remoteCard.querySelector("video") as HTMLVideoElement;
			const canvasEl = remoteCard.querySelector("canvas") as HTMLCanvasElement;
			const volBtn = remoteCard.querySelector(".stream-vol-btn") as HTMLButtonElement;
			const volSlider = remoteCard.querySelector(".stream-vol-slider") as HTMLInputElement;
			const volPercent = remoteCard.querySelector(".stream-vol-percent") as HTMLSpanElement;

			videoEl.srcObject = remoteData.stream;
			videoEl.volume = savedVol / 100;
			// No modo preview (grid), o áudio fica mutado até o usuário abrir a transmissão
			videoEl.muted = !isMax || savedVol === 0;
			videoEl.play().catch(() => { });

			const updateVolumeUI = (volume: number) => {
				const isCurrentMax = this.maximizedStreamId === cardId;
				videoEl.volume = volume / 100;
				// Se a transmissão estiver aberta (maximizada), toca no volume desejado; se não mantém mudo na preview
				videoEl.muted = !isCurrentMax || volume === 0;
				volSlider.value = volume.toString();
				volPercent.textContent = `${volume}%`;
				this.setSavedStreamVolume(peerId, volume);

				const currentIcon = volume === 0 ? "volume-x" : (volume < 50 ? "volume-1" : "volume-2");
				volBtn.innerHTML = `<i data-lucide="${currentIcon}"></i>`;
				this.refreshIcons();
			};

			volSlider.addEventListener("click", (e) => e.stopPropagation());
			volSlider.addEventListener("input", (e) => {
				e.stopPropagation();
				const val = parseInt(volSlider.value, 10) || 0;
				updateVolumeUI(val);
			});

			volBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				const current = parseInt(volSlider.value, 10) || 0;
				if (current > 0) {
					remoteCard.dataset.prevVolume = current.toString();
					updateVolumeUI(0);
				} else {
					const prev = parseInt(remoteCard.dataset.prevVolume || "100", 10) || 100;
					updateVolumeUI(prev);
				}
			});

			this.captureInitialThumbnail(videoEl, canvasEl);

			remoteCard.addEventListener("click", () => this.toggleMaximizeStreamCard(cardId, remoteCard));
			gridEl.appendChild(remoteCard);
		}

		if (this.maximizedStreamId) {
			const rightSectionEl = document.querySelector(".right-section");
			if (rightSectionEl) rightSectionEl.classList.add("maximized-active");
			if (gridEl) gridEl.classList.add("maximized-active");

			gridEl.querySelectorAll<HTMLElement>(".stream-card").forEach((c) => {
				const isCurrentMax = (c.id === "stream-card-local" && this.maximizedStreamId === "local-preview") || (c.id === this.maximizedStreamId);
				const videoEl = c.querySelector("video");
				if (isCurrentMax) {
					c.classList.add("maximized");
					c.style.display = "";
					if (videoEl && c.id !== "stream-card-local") {
						const peerId = c.id.replace("stream-card-", "");
						const savedVol = this.getSavedStreamVolume(peerId);
						videoEl.volume = savedVol / 100;
						videoEl.muted = savedVol === 0;
					}
				} else {
					c.style.display = "none";
					if (videoEl) videoEl.muted = true;
				}
			});
		} else {
			const rightSectionEl = document.querySelector(".right-section");
			if (rightSectionEl) rightSectionEl.classList.remove("maximized-active");
			if (gridEl) gridEl.classList.remove("maximized-active");

			// Garante que todas as transmissões fiquem com áudio mudo no modo preview/grid
			gridEl.querySelectorAll<HTMLVideoElement>(".stream-card video").forEach((v) => {
				v.muted = true;
			});
		}

		this.refreshIcons();
		this.updateAllThumbnails();
	}

	private captureInitialThumbnail(videoEl: HTMLVideoElement, canvasEl: HTMLCanvasElement): void {
		const tryCapture = (): boolean => {
			if (videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
				this.updateCardThumbnail(videoEl, canvasEl);
				return true;
			}
			return false;
		};

		if (!tryCapture()) {
			const onData = () => {
				if (tryCapture()) {
					videoEl.removeEventListener("loadeddata", onData);
					videoEl.removeEventListener("canplay", onData);
					videoEl.removeEventListener("timeupdate", onData);
				}
			};
			videoEl.addEventListener("loadeddata", onData);
			videoEl.addEventListener("canplay", onData);
			videoEl.addEventListener("timeupdate", onData);

			let attempts = 0;
			const interval = setInterval(() => {
				attempts++;
				if (tryCapture() || attempts >= 20) {
					clearInterval(interval);
					videoEl.removeEventListener("loadeddata", onData);
					videoEl.removeEventListener("canplay", onData);
					videoEl.removeEventListener("timeupdate", onData);
				}
			}, 150);
		}
	}

	private updateAllThumbnails(): void {
		if (this.maximizedStreamId) return;
		const gridEl = document.getElementById("live-streams-grid");
		if (!gridEl) return;

		const cards = gridEl.querySelectorAll<HTMLElement>(".stream-card");
		cards.forEach((card) => {
			const videoEl = card.querySelector("video") as HTMLVideoElement | null;
			const canvasEl = card.querySelector("canvas") as HTMLCanvasElement | null;
			if (videoEl && canvasEl) {
				this.updateCardThumbnail(videoEl, canvasEl);
			}
		});
	}

	private updateCardThumbnail(videoEl: HTMLVideoElement, canvasEl: HTMLCanvasElement): void {
		if (videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
			if (canvasEl.width !== videoEl.videoWidth || canvasEl.height !== videoEl.videoHeight) {
				canvasEl.width = videoEl.videoWidth;
				canvasEl.height = videoEl.videoHeight;
			}
			const ctx = canvasEl.getContext("2d");
			if (ctx) {
				ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
			}
		}
	}

	private toggleMaximizeStreamCard(cardId: string, cardEl: HTMLElement): void {
		if (this.maximizedStreamId === cardId) {
			this.restoreGridMode();
		} else {
			this.maximizeStreamCard(cardId, cardEl);
		}
	}

	private maximizeStreamCard(cardId: string, cardEl: HTMLElement): void {
		this.maximizedStreamId = cardId;

		const gridEl = document.getElementById("live-streams-grid");
		const rightSectionEl = document.querySelector(".right-section");

		if (rightSectionEl) rightSectionEl.classList.add("maximized-active");
		if (gridEl) gridEl.classList.add("maximized-active");

		document.querySelectorAll<HTMLElement>(".stream-card").forEach((c) => {
			const canvasEl = c.querySelector("canvas");
			const videoEl = c.querySelector("video");

			if (c === cardEl) {
				c.classList.add("maximized");
				c.style.display = "";
				if (canvasEl) canvasEl.classList.add("hidden");
				if (videoEl) {
					videoEl.classList.remove("hidden");
					const isLocal = cardId === "local-preview" || cardId === "stream-card-local";
					if (isLocal) {
						videoEl.muted = true;
					} else {
						const peerId = cardId.replace("stream-card-", "");
						const savedVol = this.getSavedStreamVolume(peerId);
						videoEl.volume = savedVol / 100;
						videoEl.muted = savedVol === 0;
					}
					videoEl.play().catch(() => { });
				}
			} else {
				c.style.display = "none";
				if (videoEl) videoEl.muted = true;
			}
		});
	}

	private restoreGridMode(): void {
		this.maximizedStreamId = null;

		const gridEl = document.getElementById("live-streams-grid");
		const rightSectionEl = document.querySelector(".right-section");

		if (rightSectionEl) rightSectionEl.classList.remove("maximized-active");
		if (gridEl) gridEl.classList.remove("maximized-active");

		document.querySelectorAll<HTMLElement>(".stream-card").forEach((c) => {
			c.classList.remove("maximized");
			c.style.display = "";
			const canvasEl = c.querySelector("canvas");
			const videoEl = c.querySelector("video");

			if (videoEl) {
				videoEl.muted = true; // Garante que o áudio seja silenciado ao voltar ao grid
				videoEl.classList.add("hidden");
			}
			if (canvasEl) canvasEl.classList.remove("hidden");
		});

		this.updateAllThumbnails();
	}

	private setupSubTabs(): void {
		const tabWindows = document.getElementById("tab-windows");
		const tabScreens = document.getElementById("tab-screens");

		if (tabWindows && tabScreens) {
			tabWindows.addEventListener("click", () => {
				tabWindows.classList.add("active");
				tabScreens.classList.remove("active");
				this.leftSourcePicker?.setFilter("window");
				this.mainSourcePicker?.setFilter("window");
				this.refreshIcons();
			});

			tabScreens.addEventListener("click", () => {
				tabScreens.classList.add("active");
				tabWindows.classList.remove("active");
				this.leftSourcePicker?.setFilter("screen");
				this.mainSourcePicker?.setFilter("screen");
				this.refreshIcons();
			});
		}
	}

	private setupSourcePicker(): void {
		const leftGrid = document.getElementById("sources-panel-grid");
		const mainGrid = document.getElementById("sources-grid");
		const btnRefresh = document.getElementById("btn-refresh-sources");

		if (leftGrid) {
			this.leftSourcePicker = new SourcePicker(leftGrid, (source) => {
				this.onSourceSelected(source);
				this.mainSourcePicker?.setSelectedSourceById?.(source.id);
			});
		}

		if (mainGrid) {
			this.mainSourcePicker = new SourcePicker(mainGrid, (source) => {
				this.onSourceSelected(source);
				this.leftSourcePicker?.setSelectedSourceById?.(source.id);
			});
		}

		btnRefresh?.addEventListener("click", () => this.refreshSources());
	}

	// ------------------------------------------------------------------------------------------------------------------------------
	//  USERS PANEL (Exibe todos, inclusive Você)
	// ------------------------------------------------------------------------------------------------------------------------------
	private async refreshUsersList(): Promise<boolean> {
		const listEl = document.getElementById("users-list");
		if (!listEl) return true;

		const users = await getOnlineUsers();
		if (users === null) {
			// Falha na API: mantém a última lista válida na tela
			if (!this.usersLoaded) {
				listEl.innerHTML = `
				<div class="users-empty">
					<i data-lucide="wifi-off"></i>
					<span>Não foi possível carregar os usuários. Tentando novamente...</span>
				</div>`;
				this.refreshIcons();
			}
			return false;
		}
		this.usersLoaded = true;
		this.onlineUsers = users;
		this.renderUsersList();
		return true;
	}

	/**
	 * Usuários exibidos no painel: dentro de uma sala, só os membros online dela;
	 * fora de sala, todos os online.
	 */
	private getVisibleUsers(): ShiroUser[] {
		const room = this.currentRoom;
		if (!room || !Array.isArray(room.members)) return this.onlineUsers;

		const memberKeys = new Set<string>();
		for (const m of room.members as any[]) {
			if (typeof m === "string") memberKeys.add(m);
			else {
				const id = m?.id || m?.userId;
				const name = m?.username || m?.name;
				if (id) memberKeys.add(id);
				if (name) memberKeys.add(name);
			}
		}
		const selfId = getUser()?.id;
		return this.onlineUsers.filter((u) => u.id === selfId || memberKeys.has(u.id) || memberKeys.has(u.username));
	}

	private renderUsersList(): void {
		const listEl = document.getElementById("users-list");
		if (!listEl || !this.usersLoaded) return;

		const titleEl = document.getElementById("users-panel-title");
		if (titleEl) titleEl.textContent = this.currentRoom ? "Online na sala" : "Online agora";

		const users = this.getVisibleUsers();
		const currentUser = getUser();

		// Evita re-renderizar (e fechar o mini perfil) quando nada visível mudou
		const renderKey = JSON.stringify([
			this.currentRoom?.roomId ?? null,
			users.map((u) => [u.id, u.username, u.nickname, u.avatar]),
		]);
		if (renderKey === this.lastUsersRenderKey) return;
		this.lastUsersRenderKey = renderKey;

		if (users.length === 0) {
			listEl.innerHTML = `
				<div class="users-empty">
					<i data-lucide="wifi-off"></i>
					<span>${this.currentRoom ? "Ninguém online nesta sala" : "Nenhum usuário online"}</span>
				</div>`;
			this.refreshIcons();
			return;
		}

		listEl.innerHTML = users
			.map((u) => {
				const isSelf = u.id === currentUser?.id;
				const isSelected = this.selectedTargetUserId === u.id;
				const displayName = u.nickname ? this.escapeHtml(u.nickname) : this.escapeHtml(u.username);
				const subText = u.nickname ? `@${this.escapeHtml(u.username)} • ID: ${u.id}` : `ID: ${u.id}`;
				const initial = (u.nickname || u.username)[0].toUpperCase();

				const avatarHtml = u.avatar && u.avatar.trim().startsWith("http")
					? `<img src="${this.escapeHtml(u.avatar.trim())}" alt="${displayName}" onerror="this.remove(); this.parentElement.textContent='${initial}';" />`
					: initial;

				return `
			<div class="user-card ${isSelected ? "selected" : ""} ${isSelf ? "self-user" : ""}" data-user-id="${u.id}" data-username="${u.username}">
				<div class="user-card-avatar-wrapper">
					<div class="user-card-avatar">
						${avatarHtml}
					</div>
					<div class="user-card-status-dot" title="Online"></div>
				</div>
				<div class="user-card-info">
					<span class="user-card-name">${displayName} ${isSelf ? '<span class="user-self-tag">você</span>' : ""}</span>
					<span class="user-card-id">${subText}</span>
				</div>
			</div>`;
			})
			.join("");

		listEl.querySelectorAll<HTMLElement>(".user-card").forEach((card) => {
			card.addEventListener("click", () => {
				const userId = card.dataset.userId;
				if (this.activeMiniProfileUserId === userId) {
					this.hideUserMiniProfile();
					return;
				}
				listEl.querySelectorAll(".user-card").forEach((c) => c.classList.remove("selected"));
				card.classList.add("selected");
				const userObj = this.onlineUsers.find((u) => u.id === userId) || (currentUser?.id === userId ? currentUser : null);
				if (userObj) {
					this.showUserMiniProfile(userObj, card);
				}
			});
		});

		this.refreshIcons();
	}

	private escapeHtml(str: string): string {
		return str.replace(/[&<>"']/g, (c) => ({
			"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
		}[c] ?? c));
	}

	private async onSourceSelected(source: WindowSource): Promise<void> {
		console.log(`[App] Fonte selecionada: ${source.name} (ID: ${source.id})`);
		this.selectedSourceIndex = this.allSources.findIndex((s) => s.id === source.id);

		this.leftSourcePicker?.setSelectedSourceById?.(source.id);
		this.mainSourcePicker?.setSelectedSourceById?.(source.id);

		this.checkCanStartStream();

		const quality = this.getQualityOptions();

		try {
			if (this.previewStream) {
				this.previewStream.getTracks().forEach((t) => t.stop());
			}

			const stream = await (navigator.mediaDevices as any).getUserMedia({
				audio: false,
				video: {
					mandatory: {
						chromeMediaSource: "desktop",
						chromeMediaSourceId: source.id,
						minWidth: quality.width,
						maxWidth: quality.width,
						minHeight: quality.height,
						maxHeight: quality.height,
						minFrameRate: Math.min(30, quality.fps),
						maxFrameRate: quality.fps,
					},
				},
			});

			this.previewStream = stream;
			this.currentVideoTrack = stream.getVideoTracks()[0];

			if (this.currentVideoTrack && "contentHint" in this.currentVideoTrack) {
				(this.currentVideoTrack as any).contentHint = "detail";
			}

			if (this.p2pManager?.getIsStreaming() && this.currentVideoTrack) {
				console.log("[App] Trocando fonte de transmissão em tempo real...");

				const audioMode = this.getSelectedAudioMode();
				if (audioMode === "process" && window.api?.startAudioCapture) {
					await window.api.startAudioCapture({
						mode: "process",
						targetPid: source.pid,
						targetProcessName: source.processName,
					});
				}

				const audioTrack = this.audioPipeline.getAudioTrack() ?? this.audioPipeline.initialize();
				const liveTracks: MediaStreamTrack[] = [this.currentVideoTrack];
				if (audioTrack) liveTracks.push(audioTrack);
				const liveStream = new MediaStream(liveTracks);

				this.p2pManager.setLocalStream(liveStream);
			}

			this.renderLiveStreamsGrid();
		} catch (err) {
			console.error("[App] Erro ao selecionar/trocar fonte:", err);
		}
	}


	private checkCanStartStream(): void {
		const btnStart = document.getElementById("btn-start-stream") as HTMLButtonElement | null;
		const selectedSource = this.leftSourcePicker?.getSelectedSource() ?? this.mainSourcePicker?.getSelectedSource();

		if (!btnStart) return;

		// Sem fonte selecionada, startStreaming usa a primeira disponível: só bloqueia se não houver nenhuma
		if (selectedSource || this.allSources.length > 0) {
			btnStart.disabled = false;
			btnStart.title = selectedSource ? "Iniciar transmissão P2P" : "Iniciar transmissão P2P (usa a primeira fonte disponível)";
		} else {
			btnStart.disabled = true;
			btnStart.title = "Nenhuma fonte de captura encontrada";
		}
	}

	private async refreshSources(): Promise<void> {
		if (!window.api?.getAvailableSources) return;
		const sources = await window.api.getAvailableSources();
		this.allSources = sources;
		this.leftSourcePicker?.setSources(sources);
		this.mainSourcePicker?.setSources(sources);

		const selected = this.leftSourcePicker?.getSelectedSource();
		if (selected) {
			this.selectedSourceIndex = sources.findIndex((s) => s.id === selected.id);
		}

		this.checkCanStartStream();
		this.refreshIcons();

		if (window.api.reportSources) {
			window.api.reportSources(
				sources.map((s) => ({
					id: s.id,
					name: s.name,
					processName: s.processName,
					sourceType: s.sourceType,
					thumbnailUrl: s.thumbnailUrl,
				})),
				this.selectedSourceIndex,
			);
		}
	}

	private setupStreamButtons(): void {
		document.getElementById("btn-start-stream")?.addEventListener("click", () => this.startStreaming());
		document.getElementById("btn-stop-stream")?.addEventListener("click", () => this.stopStreaming());
	}

	private async startStreaming(): Promise<void> {
		let selectedSource = this.leftSourcePicker?.getSelectedSource() ?? this.mainSourcePicker?.getSelectedSource();
		if (!selectedSource && this.allSources.length > 0) {
			selectedSource = this.allSources[0];
			this.leftSourcePicker?.setSelectedSource(selectedSource);
			this.mainSourcePicker?.setSelectedSource(selectedSource);
		}
		if (!selectedSource) {
			alert("Selecione uma fonte de vídeo antes de iniciar a transmissão.");
			return;
		}

		if (!this.currentVideoTrack) {
			await this.onSourceSelected(selectedSource);
		}

		if (!this.currentVideoTrack) {
			alert("Não foi possível capturar a fonte selecionada.");
			return;
		}

		console.log("[App] Iniciando transmissão...");
		let audioTrack: MediaStreamTrack | null = null;
		const audioMode = this.getSelectedAudioMode();

		if (audioMode !== "disabled") {
			const activeSource = this.leftSourcePicker?.getSelectedSource() ?? this.mainSourcePicker?.getSelectedSource();
			if (window.api?.startAudioCapture) {
				const audioStatus = await window.api.startAudioCapture({
					mode: audioMode,
					targetPid: activeSource?.pid,
					targetProcessName: activeSource?.processName,
				});
				console.log("[App] Audio status:", audioStatus);
			}

			audioTrack = this.audioPipeline.initialize();
			const analyser = this.audioPipeline.getAnalyser();
			if (analyser) {
				this.audioVisualizer.start(analyser);
				const vuStatus = document.getElementById("vu-status-text");
				if (vuStatus) {
					vuStatus.innerText = "Recebendo áudio nativo";
					vuStatus.style.color = "#10b981";
				}
			}
		}

		const tracks: MediaStreamTrack[] = [this.currentVideoTrack];
		if (audioTrack) tracks.push(audioTrack);
		const stream = new MediaStream(tracks);
		this.p2pManager?.setLocalStream(stream);
		this.p2pManager?.setIsStreaming(true);

		setStreamStatus(true, "AO VIVO");
		if (window.api) window.api.reportStreamShareState(true);

		document.getElementById("btn-start-stream")?.classList.add("hidden");
		document.getElementById("btn-stop-stream")?.classList.remove("hidden");

		this.renderLiveStreamsGrid();

		try {
			if (this.currentRoom) {
				await notifyRoomStream(this.currentRoom.roomId, "start");
			}
		} catch (err: any) {
			console.error("[App] Erro ao notificar sala:", err);
			alert(`Erro ao iniciar transmissão na sala: ${err.message}`);
			setStreamStatus(false, "Erro ao Conectar");
			this.stopStreaming();
		}
	}

	private getSavedStreamVolume(userId: string): number {
		try {
			const val = localStorage.getItem(`shiro_stream_volume_${userId}`);
			if (val !== null) {
				const parsed = parseInt(val, 10);
				if (!isNaN(parsed)) return Math.min(100, Math.max(0, parsed));
			}
		} catch {}
		return 100;
	}

	private setSavedStreamVolume(userId: string, volume: number): void {
		try {
			localStorage.setItem(`shiro_stream_volume_${userId}`, volume.toString());
		} catch {}
	}

	private async stopStreaming(): Promise<void> {
		console.log("[App] Parando transmissão...");
		this.p2pManager?.stopLocalStream();
		this.audioPipeline.stop();
		this.audioVisualizer.stop();

		if (this.currentRoom) {
			await notifyRoomStream(this.currentRoom.roomId, "stop");
		}

		if (this.previewStream) {
			this.previewStream.getTracks().forEach((t) => t.stop());
			this.previewStream = null;
			this.currentVideoTrack = null;
		}

		if (this.maximizedStreamId === "local-preview" || this.maximizedStreamId === "stream-card-local") {
			this.restoreGridMode();
		}

		const vuStatus = document.getElementById("vu-status-text");
		if (vuStatus) {
			vuStatus.innerText = "Aguardando som...";
			vuStatus.style.color = "";
		}

		if (window.api) window.api.stopAudioCapture();
		if (window.api) window.api.reportStreamShareState(false);

		const isWatchingRemote = this.remoteStreams.size > 0;
		setStreamStatus(isWatchingRemote, isWatchingRemote ? "Assistindo" : "Desconectado");

		document.getElementById("btn-start-stream")?.classList.remove("hidden");
		document.getElementById("btn-stop-stream")?.classList.add("hidden");

		this.renderLiveStreamsGrid();
	}


	private setupLogout(): void {
		document.getElementById("btn-logout")?.addEventListener("click", async () => {
			if (this.currentRoom) {
				if (this.p2pManager?.getIsStreaming()) {
					await notifyRoomStream(this.currentRoom.roomId, "stop");
				}
				await leaveRoom(this.currentRoom.roomId);
				this.currentRoom = null;
			}
			if (this.p2pManager) {
				this.p2pManager.destroy();
				this.p2pManager = null;
			}
			this.remoteStreams.clear();
			this.updateCurrentRoomBanner();
			this.audioPipeline.stop();
			this.stopPolling();
			this.serverSupportsEvents = false;
			this.serverEventsHelloCount = 0;

			this.tutorial?.stop(false);
			document.getElementById("modal-tutorial-welcome")?.classList.add("hidden");
			logout();
			this.showLoginView(checkSavedSession());
		});
	}

	private getQualityOptions(): StreamQualityOptions {
		const selectRes = (document.getElementById("select-resolution") as HTMLSelectElement)?.value || "1080p";
		const selectFps = parseInt((document.getElementById("select-fps") as HTMLSelectElement)?.value || "60", 10);

		const resMap: Record<string, { width: number; height: number }> = {
			"1080p": { width: 1920, height: 1080 },
			"720p": { width: 1280, height: 720 },
			"1440p": { width: 2560, height: 1440 },
			"4k": { width: 3840, height: 2160 },
			"480p": { width: 854, height: 480 },
		};

		const dim = resMap[selectRes] || { width: 1920, height: 1080 };

		return {
			resolution: selectRes as any,
			width: dim.width,
			height: dim.height,
			fps: selectFps,
			bitrateKbps: 4500,
			degradationPreference: "maintain-framerate",
		};
	}

	private getSelectedAudioMode(): AudioCaptureMode {
		const selected = document.querySelector('input[name="audioMode"]:checked') as HTMLInputElement | null;
		return (selected?.value as AudioCaptureMode) || "process";
	}

	private setupAudioRadioListeners(): void {
		document.querySelectorAll(".radio-card").forEach((card) => {
			card.addEventListener("click", async () => {
				document.querySelectorAll(".radio-card").forEach((c) => c.classList.remove("active"));
				card.classList.add("active");
				const input = card.querySelector('input[type="radio"]') as HTMLInputElement | null;
				if (input) input.checked = true;

				if (window.api?.reportAudioMode) {
					window.api.reportAudioMode(this.getSelectedAudioMode());
				}
			});
		});
	}

	private setupQualityChangeListeners(): void {
		const onTrackConfigChanged = async () => {
			const selected = this.leftSourcePicker?.getSelectedSource() ?? this.mainSourcePicker?.getSelectedSource();
			if (selected) await this.onSourceSelected(selected);
		};

		document.getElementById("select-resolution")?.addEventListener("change", onTrackConfigChanged);
		document.getElementById("select-fps")?.addEventListener("change", onTrackConfigChanged);
	}

	private setupPopoverToggles(): void {
		const btnSettings = document.getElementById("btn-toggle-settings");
		const btnCloseSettings = document.getElementById("btn-close-settings");
		const settingsPopover = document.getElementById("settings-popover");

		const btnAudio = document.getElementById("btn-toggle-audio");
		const btnCloseAudio = document.getElementById("btn-close-audio");
		const audioPopover = document.getElementById("audio-popover");

		/**
		 * Posiciona o popover logo acima do botão que o abriu, alinhado pela direita.
		 * A barra de controles muda de lugar (rodapé normal × pílula flutuante na tela
		 * maximizada), então a posição fixa no CSS deixava o popover longe do botão.
		 */
		const positionPopover = (popover: HTMLElement | null, button: HTMLElement | null) => {
			if (!popover || !button || popover.classList.contains("hidden")) return;
			const container = popover.offsetParent as HTMLElement | null;
			if (!container) return;
			const cr = container.getBoundingClientRect();
			const br = button.getBoundingClientRect();
			// A distância vertical conta a partir da barra (a pílula tem padding em volta dos botões)
			const barTop = (button.closest(".bottom-controls-bar") ?? button).getBoundingClientRect().top;
			const GAP = 10;
			const MARGIN = 8;
			const maxRight = Math.max(MARGIN, cr.width - popover.offsetWidth - MARGIN);
			const right = Math.min(Math.max(MARGIN, cr.right - br.right), maxRight);
			popover.style.right = `${Math.round(right)}px`;
			popover.style.bottom = `${Math.round(cr.bottom - barTop + GAP)}px`;
		};
		const repositionOpenPopovers = () => {
			positionPopover(settingsPopover, btnSettings);
			positionPopover(audioPopover, btnAudio);
		};
		window.addEventListener("resize", repositionOpenPopovers);
		// Maximizar/restaurar a transmissão move a barra de controles
		const rightSection = document.querySelector(".right-section");
		if (rightSection) {
			new MutationObserver(() => {
				repositionOpenPopovers();
				// A pílula flutuante anima (transition 0.25s): reposiciona de novo ao fim
				setTimeout(repositionOpenPopovers, 300);
			}).observe(rightSection, { attributes: true, attributeFilter: ["class"] });
		}

		btnSettings?.addEventListener("click", (e) => {
			e.stopPropagation();
			audioPopover?.classList.add("hidden");
			btnAudio?.classList.remove("active");
			const hidden = settingsPopover?.classList.toggle("hidden");
			btnSettings.classList.toggle("active", !hidden);
			positionPopover(settingsPopover, btnSettings);
		});

		btnCloseSettings?.addEventListener("click", () => {
			settingsPopover?.classList.add("hidden");
			btnSettings?.classList.remove("active");
		});

		btnAudio?.addEventListener("click", (e) => {
			e.stopPropagation();
			settingsPopover?.classList.add("hidden");
			btnSettings?.classList.remove("active");
			const hidden = audioPopover?.classList.toggle("hidden");
			btnAudio.classList.toggle("active", !hidden);
			positionPopover(audioPopover, btnAudio);
		});

		btnCloseAudio?.addEventListener("click", () => {
			audioPopover?.classList.add("hidden");
			btnAudio?.classList.remove("active");
		});

		document.addEventListener("click", () => {
			settingsPopover?.classList.add("hidden");
			audioPopover?.classList.add("hidden");
			btnSettings?.classList.remove("active");
			btnAudio?.classList.remove("active");
		});

		settingsPopover?.addEventListener("click", (e) => e.stopPropagation());
		audioPopover?.addEventListener("click", (e) => e.stopPropagation());
	}

	private setupCustomSelects(): void {
		document.querySelectorAll<HTMLElement>(".custom-select").forEach((container) => {
			const nativeSelect = container.querySelector("select") as HTMLSelectElement;
			const trigger = container.querySelector(".select-trigger") as HTMLButtonElement;
			const options = container.querySelectorAll(".select-dropdown li");

			if (!nativeSelect || !trigger || !options.length) return;

			trigger.addEventListener("click", (e) => {
				e.stopPropagation();
				const wasOpen = container.classList.contains("open");
				document.querySelectorAll(".custom-select.open").forEach((el) => el.classList.remove("open"));
				if (!wasOpen) container.classList.add("open");
			});

			options.forEach((option) => {
				option.addEventListener("click", () => {
					const value = option.getAttribute("data-value")!;
					nativeSelect.value = value;
					trigger.textContent = option.textContent;
					container.querySelectorAll(".select-dropdown li").forEach((li) => li.classList.remove("selected"));
					option.classList.add("selected");
					container.classList.remove("open");
					nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
				});
			});
		});

		document.addEventListener("click", () => {
			document.querySelectorAll(".custom-select.open").forEach((el) => el.classList.remove("open"));
		});
	}

	private async setupAppSettings(): Promise<void> {
		const chkOpenAtLogin = document.getElementById("chk-open-at-login") as HTMLInputElement;
		const chkAutoUpdate = document.getElementById("chk-auto-update") as HTMLInputElement;

		if (window.api?.getAppSettings) {
			try {
				const settings = await window.api.getAppSettings();
				if (chkOpenAtLogin) chkOpenAtLogin.checked = settings.openAtLogin;
				if (chkAutoUpdate) chkAutoUpdate.checked = settings.autoUpdate;
			} catch (err) {
				console.warn("[App] Não foi possível carregar as configurações:", err);
			}
		}

		chkOpenAtLogin?.addEventListener("change", async () => {
			if (window.api?.setOpenAtLogin) {
				const val = await window.api.setOpenAtLogin(chkOpenAtLogin.checked);
				chkOpenAtLogin.checked = val;
			}
		});

		this.setupAutoUpdateSystem(chkAutoUpdate);
	}

	private setupAutoUpdateSystem(chkAutoUpdate: HTMLInputElement | null): void {
		const modal = document.getElementById("modal-confirm-auto-update");
		const btnConfirm = document.getElementById("btn-confirm-auto-update-modal");
		const btnCancel = document.getElementById("btn-cancel-auto-update-modal");
		const btnClose = document.getElementById("btn-close-auto-update-modal");
		const modalDesc = document.getElementById("auto-update-modal-desc");
		const btnConfirmText = document.getElementById("btn-confirm-auto-update-text");

		let targetState = true;

		const closeModal = () => {
			if (modal) modal.classList.add("hidden");
		};

		const openModal = (enabling: boolean) => {
			targetState = enabling;
			if (modalDesc) {
				modalDesc.textContent = enabling
					? "Ao ativar as atualizações automáticas, o Shiro Screen Share baixará novas versões do GitHub em segundo plano. Quando um update estiver pronto, você receberá um aviso para reiniciar agora ou o app atualizará automaticamente ao ser fechado e reaberto."
					: "Deseja desativar as atualizações automáticas? O app não baixará novos recursos e melhorias automaticamente.";
			}
			if (btnConfirmText) {
				btnConfirmText.textContent = enabling ? "Confirmar e Ativar" : "Desativar Atualizações";
			}
			// Fecha o popover de configurações para focar no modal de confirmação
			document.getElementById("settings-popover")?.classList.add("hidden");
			modal?.classList.remove("hidden");
			this.refreshIcons();
		};

		chkAutoUpdate?.addEventListener("change", () => {
			const desiredState = chkAutoUpdate.checked;
			// Mantém o estado anterior visualmente até o usuário confirmar no modal
			chkAutoUpdate.checked = !desiredState;
			openModal(desiredState);
		});

		btnConfirm?.addEventListener("click", async () => {
			closeModal();
			if (window.api?.setAutoUpdate) {
				const val = await window.api.setAutoUpdate(targetState);
				if (chkAutoUpdate) chkAutoUpdate.checked = val;
			}
		});

		btnCancel?.addEventListener("click", closeModal);
		btnClose?.addEventListener("click", closeModal);

		// Toast de notificação de atualização baixada
		const toast = document.getElementById("toast-update-notification");
		const toastVersion = document.getElementById("toast-update-version");
		const btnApply = document.getElementById("btn-apply-update-now");
		const btnDismiss = document.getElementById("btn-dismiss-update-toast");

		if (window.api?.onUpdateDownloaded) {
			window.api.onUpdateDownloaded((info) => {
				console.log("[App] Atualização baixada com sucesso:", info);
				if (toast && toastVersion) {
					toastVersion.textContent = `v${info.version || ""}`;
					toast.classList.remove("hidden");
					this.refreshIcons();
				}
			});
		}

		btnApply?.addEventListener("click", async () => {
			if (btnApply) {
				btnApply.setAttribute("disabled", "true");
				btnApply.innerHTML = `<i data-lucide="loader-2" class="spin"></i> <span>Reiniciando...</span>`;
				this.refreshIcons();
			}
			if (window.api?.installUpdate) {
				await window.api.installUpdate();
			}
		});

		btnDismiss?.addEventListener("click", () => {
			if (toast) toast.classList.add("hidden");
		});
	}

	private setupShiroPromo(): void {
		const openSite = () => {
			window.api?.openExternal?.("https://shirobot.xyz");
		};
		document.getElementById("btn-shiro-promo")?.addEventListener("click", openSite);
		document.getElementById("btn-shiro-promo-visit")?.addEventListener("click", openSite);
	}

	private setupThemeToggle(): void {
		const btnToggle = document.getElementById("btn-theme-toggle");
		const savedTheme = localStorage.getItem("shiro-theme") || "dark";
		this.applyTheme(savedTheme);

		btnToggle?.addEventListener("click", () => {
			const current = document.documentElement.getAttribute("data-theme") || "dark";
			const next = current === "dark" ? "light" : "dark";
			this.applyTheme(next);
			localStorage.setItem("shiro-theme", next);
		});
	}

	private applyTheme(theme: string): void {
		document.documentElement.setAttribute("data-theme", theme);
		const btnToggle = document.getElementById("btn-theme-toggle");
		if (btnToggle) {
			btnToggle.innerHTML = theme === "dark"
				? '<i data-lucide="sun"></i>'
				: '<i data-lucide="moon"></i>';
			btnToggle.title = theme === "dark" ? "Alternar para Claro" : "Alternar para Escuro";
			this.refreshIcons();
		}
	}


	// ------------------------------------------------------------------------------------------------------------------------------
	//  SISTEMA DE AMIGOS & CONVITES
	// ------------------------------------------------------------------------------------------------------------------------------
	private setupFriendsSystem(): void {
		// Abrir modal de adicionar amigo
		document.getElementById("btn-open-add-friend")?.addEventListener("click", () => {
			const modal = document.getElementById("modal-add-friend");
			if (modal) modal.classList.remove("hidden");
			(document.getElementById("input-add-friend-target") as HTMLInputElement)?.focus();
			this.refreshIcons();
		});

		const closeAddModal = () => {
			document.getElementById("modal-add-friend")?.classList.add("hidden");
			const err = document.getElementById("add-friend-error");
			const succ = document.getElementById("add-friend-success");
			if (err) err.textContent = "";
			if (succ) {
				succ.textContent = "";
				succ.classList.add("hidden");
			}
		};

		document.getElementById("btn-close-add-friend")?.addEventListener("click", closeAddModal);
		document.getElementById("btn-cancel-add-friend")?.addEventListener("click", closeAddModal);

		// Submeter pedido de amizade
		document.getElementById("form-add-friend")?.addEventListener("submit", async (e) => {
			e.preventDefault();
			const targetInput = document.getElementById("input-add-friend-target") as HTMLInputElement | null;
			const target = targetInput?.value.trim();
			const errorEl = document.getElementById("add-friend-error");
			const successEl = document.getElementById("add-friend-success");

			if (!target) {
				if (errorEl) errorEl.textContent = "Digite o nome de usuário ou ID.";
				return;
			}

			if (errorEl) errorEl.textContent = "";
			if (successEl) {
				successEl.textContent = "";
				successEl.classList.add("hidden");
			}

			this.setAuthLoading("btn-submit-add-friend", true);
			const res = await sendFriendRequest(target);
			this.setAuthLoading("btn-submit-add-friend", false);

			if (!res.ok) {
				if (errorEl) errorEl.textContent = res.error ?? "Erro ao enviar pedido de amizade.";
				return;
			}

			if (successEl) {
				successEl.textContent = res.message || "Pedido de amizade enviado com sucesso!";
				successEl.classList.remove("hidden");
			}

			if (targetInput) targetInput.value = "";
			await this.refreshFriends();

			setTimeout(() => {
				closeAddModal();
			}, 1200);
		});

		// Botão de atualizar lista de amigos
		document.getElementById("btn-refresh-friends")?.addEventListener("click", () => this.refreshFriends());
	}

	private async refreshFriends(): Promise<boolean> {
		try {
			const res = await getFriends();
			// Falha na API: mantém amigos/pedidos/convites anteriores
			if (!res.ok) return false;
			this.friends = res.friends;
			this.friendRequests = res.friendRequests;
			this.roomInvites = res.roomInvites;

			if (this.roomInvites.length > 0) {
				console.log(`[App] 📬 ${this.roomInvites.length} convite(s) de sala encontrado(s):`, this.roomInvites);
			}

			// Atualiza ponto de notificação na aba
			const dot = document.getElementById("friends-badge-dot");
			const hasNotif = this.friendRequests.length > 0 || this.roomInvites.length > 0;
			if (dot) {
				if (hasNotif) dot.classList.remove("hidden");
				else dot.classList.add("hidden");
			}

			// Renderiza pedidos pendentes
			this.renderFriendRequests();

			// Renderiza lista de amigos
			this.renderFriendsList();

			// Atualiza notificações na Central de Notificações
			this.renderNotifications();

			// Verifica se há convite de sala para exibir toast
			this.checkRoomInvites();

			// Verifica se há pedidos de amizade para exibir toast
			this.checkFriendRequestsToast();
			return true;
		} catch (err) {
			console.warn("[App] Erro ao carregar amigos:", err);
			return false;
		}
	}

	private renderFriendRequests(): void {
		const section = document.getElementById("friend-requests-section");
		const countEl = document.getElementById("friend-requests-count");
		const listEl = document.getElementById("friend-requests-list");

		if (!section || !listEl) return;

		if (this.friendRequests.length === 0) {
			section.classList.add("hidden");
			return;
		}

		section.classList.remove("hidden");
		if (countEl) countEl.textContent = this.friendRequests.length.toString();

		listEl.innerHTML = this.friendRequests
			.map((req: FriendRequest) => {
				const initial = (req.fromUsername || "?")[0].toUpperCase();
				return `
				<div class="friend-request-card" data-user-id="${this.escapeHtml(req.fromUserId)}" data-username="${this.escapeHtml(req.fromUsername)}" title="Clique para ver o perfil do usuário">
					<div class="friend-card-avatar">${initial}</div>
					<div class="friend-card-details">
						<span class="friend-card-name">@${this.escapeHtml(req.fromUsername)}</span>
						<span class="friend-card-sub">Quer ser seu amigo</span>
					</div>
					<div class="friend-card-actions">
						<button class="btn btn-primary btn-xs btn-accept-friend" data-user-id="${this.escapeHtml(req.fromUserId)}" title="Aceitar pedido">
							<i data-lucide="check"></i>
						</button>
						<button class="btn btn-danger-ghost btn-xs btn-reject-friend" data-user-id="${this.escapeHtml(req.fromUserId)}" title="Recusar">
							<i data-lucide="x"></i>
						</button>
					</div>
				</div>`;
			})
			.join("");

		listEl.querySelectorAll<HTMLElement>(".friend-request-card").forEach((card) => {
			card.addEventListener("click", () => {
				const userId = card.dataset.userId!;
				const username = card.dataset.username!;
				listEl.querySelectorAll(".friend-request-card").forEach((c) => c.classList.remove("selected"));
				card.classList.add("selected");
				const userObj = this.onlineUsers.find((u) => u.id === userId || u.username === username) || {
					id: userId,
					username: username,
					nickname: username,
					isOnline: true,
				};
				this.showUserMiniProfile(userObj, card);
			});
		});

		listEl.querySelectorAll<HTMLButtonElement>(".btn-accept-friend").forEach((btn) => {
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const userId = btn.dataset.userId!;
				btn.disabled = true;
				await acceptFriendRequest(userId);
				await this.refreshFriends();
			});
		});

		listEl.querySelectorAll<HTMLButtonElement>(".btn-reject-friend").forEach((btn) => {
			btn.addEventListener("click", async (e) => {
				e.stopPropagation();
				const userId = btn.dataset.userId!;
				btn.disabled = true;
				await rejectFriend(userId);
				await this.refreshFriends();
			});
		});

		this.refreshIcons();
	}

	private renderFriendsList(): void {
		const listEl = document.getElementById("friends-list");
		if (!listEl) return;

		if (this.friends.length === 0) {
			listEl.innerHTML = `
				<div class="users-empty">
					<i data-lucide="user-plus"></i>
					<span>Nenhum amigo adicionado ainda. Clique em <b>+ Adicionar</b> acima!</span>
				</div>`;
			this.refreshIcons();
			return;
		}

		const inCurrentRoom = !!this.currentRoom;

		listEl.innerHTML = this.friends
			.map((f: FriendInfo) => {
				const displayName = f.nickname ? this.escapeHtml(f.nickname) : this.escapeHtml(f.username);
				const initial = (displayName && displayName.length > 0) ? displayName[0].toUpperCase() : "?";
				const avatarHtml = f.avatar && f.avatar.trim().startsWith("http")
					? `<img src="${this.escapeHtml(f.avatar.trim())}" alt="${displayName}" onerror="this.remove(); this.parentElement.textContent='${initial}';" />`
					: initial;

				const roomStatus = f.currentRoom
					? `<span class="friend-card-room-badge"><i data-lucide="radio"></i>${this.escapeHtml(f.currentRoom.name)}</span>`
					: (f.isOnline ? '<span class="friend-online-text">Disponível</span>' : '<span class="friend-offline-text">Offline</span>');

				return `
				<div class="friend-card" data-friend-id="${f.id}">
					<div class="user-card-avatar-wrapper">
						<div class="user-card-avatar">${avatarHtml}</div>
						<div class="user-card-status-dot ${f.isOnline ? "" : "offline"}" title="${f.isOnline ? "Online" : "Offline"}"></div>
					</div>
					<div class="friend-card-info">
						<span class="friend-card-name">${displayName}</span>
						<div class="friend-card-sub">@${this.escapeHtml(f.username)} • ${roomStatus}</div>
					</div>
					<div class="friend-card-actions">
						${
							inCurrentRoom && f.isOnline
								? `<button class="btn-friend-invite btn-invite-friend-room" data-friend-id="${f.id}" title="Convidar para sua sala ativa">
									<i data-lucide="radio"></i>
									<span>Convidar</span>
								</button>`
								: ""
						}
						<button class="btn-friend-remove btn-remove-friend" data-friend-id="${f.id}" title="Desfazer amizade">
							<i data-lucide="trash-2"></i>
						</button>
					</div>
				</div>`;
			})
			.join("");

		listEl.querySelectorAll<HTMLButtonElement>(".btn-invite-friend-room").forEach((btn) => {
			btn.addEventListener("click", async () => {
				if (!this.currentRoom) return;
				const friendId = btn.dataset.friendId!;
				btn.disabled = true;
				btn.innerHTML = `<i data-lucide="loader-2" class="spin"></i>`;
				this.refreshIcons();

				const res = await inviteFriendToRoom(friendId, this.currentRoom.roomId);
				if (res.ok) {
					btn.innerHTML = `<i data-lucide="check"></i> <span>Enviado!</span>`;
					this.refreshIcons();
					setTimeout(() => {
						btn.disabled = false;
						btn.innerHTML = `<i data-lucide="radio"></i> <span>Convidar</span>`;
						this.refreshIcons();
					}, 2000);
				} else {
					btn.disabled = false;
					btn.innerHTML = `<i data-lucide="radio"></i> <span>Convidar</span>`;
					this.refreshIcons();
					alert(res.error || "Erro ao convidar amigo.");
				}
			});
		});

		listEl.querySelectorAll<HTMLButtonElement>(".btn-remove-friend").forEach((btn) => {
			btn.addEventListener("click", async () => {
				const friendId = btn.dataset.friendId!;
				if (!confirm("Deseja realmente desfazer a amizade com este usuário?")) return;
				btn.disabled = true;
				await rejectFriend(friendId);
				await this.refreshFriends();
			});
		});

		listEl.querySelectorAll<HTMLElement>(".friend-card").forEach((card) => {
			card.addEventListener("click", (e) => {
				if ((e.target as HTMLElement).closest("button")) return;
				const friendId = card.dataset.friendId;
				if (this.activeMiniProfileUserId === friendId) {
					this.hideUserMiniProfile();
					return;
				}
				listEl.querySelectorAll(".friend-card").forEach((c) => c.classList.remove("selected"));
				card.classList.add("selected");
				const friendObj = this.friends.find((f: FriendInfo) => f.id === friendId);
				if (friendObj) {
					this.showUserMiniProfile(friendObj, card);
				}
			});
		});

		this.refreshIcons();
	}

	// ------------------------------------------------------------------------------------------------------------------------------
	//  MODAL: GERENCIAR SALA (DONO / PROPRIETÁRIO)
	// ------------------------------------------------------------------------------------------------------------------------------
	private setupRoomSettingsModal(): void {
		const modal = document.getElementById("modal-room-settings");
		const btnOpen = document.getElementById("btn-room-settings");
		const btnClose = document.getElementById("btn-close-room-settings");
		const btnCancel = document.getElementById("btn-cancel-room-settings");
		const form = document.getElementById("form-room-settings");

		const inputName = document.getElementById("room-settings-name") as HTMLInputElement | null;
		const inputPass = document.getElementById("room-settings-password") as HTMLInputElement | null;
		const inputMax = document.getElementById("room-settings-max-members") as HTMLInputElement | null;
		const privacyBadge = document.getElementById("room-settings-privacy-badge");
		const passHint = document.getElementById("room-settings-password-hint");
		const removePassWrap = document.getElementById("room-settings-remove-password-wrap");
		const removePassCheckbox = document.getElementById("room-settings-remove-password") as HTMLInputElement | null;
		const btnGenPass = document.getElementById("btn-generate-room-settings-password");

		const codeText = document.getElementById("room-settings-invite-code-text");
		const btnCopyCode = document.getElementById("btn-copy-settings-invite-code");
		const btnRegenCode = document.getElementById("btn-regenerate-invite-code");

		const errorEl = document.getElementById("room-settings-error");
		const successEl = document.getElementById("room-settings-success");

		const openModal = () => {
			if (!this.currentRoom) return;
			const user = getUser();
			const isOwner = !!(user && this.currentRoom && (this.currentRoom.ownerId === user.id || this.currentRoom.createdBy === user.username));
			if (!isOwner) return;

			if (errorEl) errorEl.textContent = "";
			if (successEl) {
				successEl.textContent = "";
				successEl.classList.add("hidden");
			}

			if (inputName) inputName.value = this.currentRoom.name;
			if (inputPass) {
				inputPass.value = "";
				inputPass.disabled = false;
			}
			if (inputMax) inputMax.value = (this.currentRoom.maxMembers || 15).toString();
			if (codeText) codeText.textContent = this.currentRoom.inviteCode || "INV-XXXXXX";

			if (removePassCheckbox) removePassCheckbox.checked = false;

			if (this.currentRoom.isPrivate) {
				if (privacyBadge) {
					privacyBadge.className = "badge badge-private";
					privacyBadge.textContent = "Privada";
				}
				if (passHint) {
					passHint.textContent = "Deixe em branco para manter a senha atual, digite 8 dígitos para alterar, ou marque abaixo para remover.";
				}
				if (inputPass) inputPass.placeholder = "Nova senha de 8 dígitos (ou deixe em branco)";
				removePassWrap?.classList.remove("hidden");
			} else {
				if (privacyBadge) {
					privacyBadge.className = "badge badge-public";
					privacyBadge.textContent = "Pública";
				}
				if (passHint) {
					passHint.textContent = "Digite 8 dígitos para definir uma senha e tornar a sala privada.";
				}
				if (inputPass) inputPass.placeholder = "8 dígitos numéricos";
				removePassWrap?.classList.add("hidden");
			}

			modal?.classList.remove("hidden");
			this.refreshIcons();
			inputName?.focus();
		};

		const closeModal = () => {
			modal?.classList.add("hidden");
			if (errorEl) errorEl.textContent = "";
			if (successEl) {
				successEl.textContent = "";
				successEl.classList.add("hidden");
			}
		};

		btnOpen?.addEventListener("click", openModal);
		btnClose?.addEventListener("click", closeModal);
		btnCancel?.addEventListener("click", closeModal);

		btnGenPass?.addEventListener("click", () => {
			const randomPass = Math.floor(10000000 + Math.random() * 90000000).toString();
			if (inputPass) {
				inputPass.disabled = false;
				inputPass.value = randomPass;
			}
			if (removePassCheckbox) removePassCheckbox.checked = false;
		});

		removePassCheckbox?.addEventListener("change", () => {
			if (!inputPass) return;
			if (removePassCheckbox.checked) {
				inputPass.value = "";
				inputPass.disabled = true;
			} else {
				inputPass.disabled = false;
			}
		});

		btnCopyCode?.addEventListener("click", () => {
			if (!this.currentRoom?.inviteCode) return;
			navigator.clipboard.writeText(this.currentRoom.inviteCode);
			if (btnCopyCode) {
				btnCopyCode.innerHTML = `<i data-lucide="check"></i> <span>Copiado!</span>`;
				this.refreshIcons();
				setTimeout(() => {
					btnCopyCode.innerHTML = `<i data-lucide="copy"></i> <span>Copiar</span>`;
					this.refreshIcons();
				}, 1500);
			}
		});

		btnRegenCode?.addEventListener("click", async () => {
			if (!this.currentRoom) return;
			if (btnRegenCode) {
				btnRegenCode.setAttribute("disabled", "true");
				btnRegenCode.innerHTML = `<i data-lucide="loader-2" class="spin"></i>`;
				this.refreshIcons();
			}

			const res = await updateRoomSettings(this.currentRoom.roomId, { regenerateInviteCode: true });
			if (btnRegenCode) {
				btnRegenCode.removeAttribute("disabled");
				btnRegenCode.innerHTML = `<i data-lucide="rotate-cw"></i> <span>Regenerar</span>`;
				this.refreshIcons();
			}

			if (res.ok && res.room) {
				this.currentRoom = res.room;
				if (codeText) codeText.textContent = res.room.inviteCode || "";
				this.updateCurrentRoomBanner();
			} else {
				if (errorEl) errorEl.textContent = res.error || "Erro ao regenerar código de convite.";
			}
		});

		form?.addEventListener("submit", async (e) => {
			e.preventDefault();
			if (!this.currentRoom) return;

			const name = inputName?.value.trim();
			const pass = inputPass?.value.trim();
			const maxMembers = inputMax ? parseInt(inputMax.value, 10) : undefined;
			const shouldRemovePassword = removePassCheckbox?.checked;

			if (!name) {
				if (errorEl) errorEl.textContent = "O nome da sala não pode estar vazio.";
				return;
			}

			if (pass && !shouldRemovePassword && !/^\d{8}$/.test(pass)) {
				if (errorEl) errorEl.textContent = "A senha deve conter exatamente 8 dígitos numéricos.";
				return;
			}

			if (errorEl) errorEl.textContent = "";
			if (successEl) {
				successEl.textContent = "";
				successEl.classList.add("hidden");
			}

			this.setAuthLoading("btn-save-room-settings", true);

			const updatePayload: any = { name };
			if (shouldRemovePassword) {
				updatePayload.password = "";
			} else if (pass) {
				updatePayload.password = pass;
			}

			if (maxMembers && !isNaN(maxMembers)) {
				updatePayload.maxMembers = maxMembers;
			}

			const res = await updateRoomSettings(this.currentRoom.roomId, updatePayload);
			this.setAuthLoading("btn-save-room-settings", false);

			if (!res.ok || !res.room) {
				if (errorEl) errorEl.textContent = res.error || "Erro ao atualizar configurações da sala.";
				return;
			}

			this.currentRoom = res.room;
			this.updateCurrentRoomBanner();
			await this.refreshRooms();

			if (successEl) {
				successEl.textContent = "Configurações da sala salvas com sucesso!";
				successEl.classList.remove("hidden");
			}

			setTimeout(() => {
				closeModal();
			}, 900);
		});
	}

	// ------------------------------------------------------------------------------------------------------------------------------
	//  MODAL: ENTRAR POR CÓDIGO DE CONVITE / ID
	// ------------------------------------------------------------------------------------------------------------------------------
	private setupJoinByInviteModal(): void {
		const tabId = document.getElementById("tab-join-mode-id");
		const tabInvite = document.getElementById("tab-join-mode-invite");
		const formId = document.getElementById("form-join-by-id");
		const formInvite = document.getElementById("form-join-by-invite-code");
		const indicator = document.getElementById("join-tab-indicator");

		tabId?.addEventListener("click", () => {
			tabId.classList.add("active");
			tabInvite?.classList.remove("active");
			indicator?.classList.remove("on-register");
			formId?.classList.remove("hidden");
			formInvite?.classList.add("hidden");
			(document.getElementById("join-by-id-room-id") as HTMLInputElement)?.focus();
		});

		tabInvite?.addEventListener("click", () => {
			tabInvite.classList.add("active");
			tabId?.classList.remove("active");
			indicator?.classList.add("on-register");
			formInvite?.classList.remove("hidden");
			formId?.classList.add("hidden");
			(document.getElementById("join-invite-code-input") as HTMLInputElement)?.focus();
		});

		const closeJoinModal = () => {
			document.getElementById("modal-join-by-id")?.classList.add("hidden");
			const err1 = document.getElementById("join-by-id-error");
			const err2 = document.getElementById("join-by-invite-error");
			if (err1) err1.textContent = "";
			if (err2) err2.textContent = "";
		};

		document.getElementById("btn-cancel-join-by-invite")?.addEventListener("click", closeJoinModal);

		// Submissão por Código de Convite Direto
		formInvite?.addEventListener("submit", async (e) => {
			e.preventDefault();
			const codeInput = document.getElementById("join-invite-code-input") as HTMLInputElement | null;
			const code = codeInput?.value.trim().toUpperCase();
			const errorEl = document.getElementById("join-by-invite-error");

			if (!code) {
				if (errorEl) errorEl.textContent = "Digite o código de convite.";
				return;
			}

			if (errorEl) errorEl.textContent = "";
			this.setAuthLoading("btn-submit-join-by-invite", true);
			const res = await joinRoomByInvite(code);
			this.setAuthLoading("btn-submit-join-by-invite", false);

			if (!res.ok || !res.room) {
				if (errorEl) errorEl.textContent = res.error || "Código de convite inválido ou expirado.";
				return;
			}

			closeJoinModal();
			await this.onRoomSelected(res.room);
		});
	}

	// ------------------------------------------------------------------------------------------------------------------------------
	//  TOAST: CONVITES DE SALA EM TEMPO REAL
	// ------------------------------------------------------------------------------------------------------------------------------
	private setupRoomInvitesToast(): void {
		const toast = document.getElementById("toast-room-invite");
		const btnAccept = document.getElementById("btn-accept-room-invite");
		const btnDismiss = document.getElementById("btn-dismiss-room-invite");

		btnAccept?.addEventListener("click", async () => {
			if (!this.activeRoomInvite) return;
			const invite = this.activeRoomInvite;
			if (toast) toast.classList.add("hidden");

			await dismissRoomInvite(invite.id);
			this.activeRoomInvite = null;

			// Entra direto usando o código de convite da sala
			const res = await joinRoomByInvite(invite.inviteCode);
			if (res.ok && res.room) {
				await this.onRoomSelected(res.room);
			} else {
				// Fallback caso a sala seja pública
				const resJoin = await joinRoom(invite.roomId);
				if (resJoin.ok && resJoin.room) {
					await this.onRoomSelected(resJoin.room);
				} else {
					alert(res.error || "Não foi possível entrar na sala convidada.");
				}
			}
		});

		btnDismiss?.addEventListener("click", async () => {
			if (!this.activeRoomInvite) return;
			const invite = this.activeRoomInvite;
			if (toast) toast.classList.add("hidden");
			await dismissRoomInvite(invite.id);
			this.activeRoomInvite = null;
		});
	}

	private checkRoomInvites(): void {
		const toast = document.getElementById("toast-room-invite");
		const senderEl = document.getElementById("toast-invite-sender");
		const roomNameEl = document.getElementById("toast-invite-room-name");

		if (!toast || !senderEl || !roomNameEl) return;

		// Se já estiver na sala do convite, não exibe
		const validInvites = this.roomInvites.filter(
			(inv: RoomInvite) => !this.currentRoom || this.currentRoom.roomId !== inv.roomId,
		);

		if (validInvites.length === 0) {
			if (this.roomInvites.length > 0) {
				console.log("[App] Convite(s) recebido(s), mas ignorado(s) pois você já está na sala:", this.roomInvites);
			}
			if (this.activeRoomInvite) {
				toast.classList.add("hidden");
				this.activeRoomInvite = null;
			}
			return;
		}

		const latestInvite = validInvites[0];
		if (this.activeRoomInvite?.id !== latestInvite.id) {
			this.activeRoomInvite = latestInvite;
			const senderName = latestInvite.fromNickname || latestInvite.fromUsername;
			senderEl.textContent = senderName;
			roomNameEl.textContent = latestInvite.roomName;
			console.log(`[App] 🔔 Exibindo toast de convite para sala '${latestInvite.roomName}' de ${senderName}`);
			toast.classList.remove("hidden");
			this.refreshIcons();
		}
	}

	private setupFriendRequestToast(): void {
		const toast = document.getElementById("toast-friend-request");
		const contentEl = document.getElementById("toast-friend-req-content");
		const btnAccept = document.getElementById("btn-accept-toast-friend");
		const btnDismiss = document.getElementById("btn-dismiss-toast-friend");

		// Clicar no corpo do toast abre o mini perfil da pessoa para visualizá-la
		contentEl?.addEventListener("click", () => {
			if (!this.activeFriendRequest) return;
			const req = this.activeFriendRequest;
			if (toast) toast.classList.add("hidden");

			const userObj = this.onlineUsers.find((u) => u.id === req.fromUserId || u.username === req.fromUsername) || {
				id: req.fromUserId,
				username: req.fromUsername,
				nickname: req.fromUsername,
				isOnline: true,
			};
			if (toast) {
				this.showUserMiniProfile(userObj, toast);
			}
		});

		btnAccept?.addEventListener("click", async (e) => {
			e.stopPropagation();
			if (!this.activeFriendRequest) return;
			const req = this.activeFriendRequest;
			if (toast) toast.classList.add("hidden");

			await acceptFriendRequest(req.fromUserId);
			this.activeFriendRequest = null;
			await this.refreshFriends();
		});

		btnDismiss?.addEventListener("click", async (e) => {
			e.stopPropagation();
			if (!this.activeFriendRequest) return;
			const req = this.activeFriendRequest;
			if (toast) toast.classList.add("hidden");

			await rejectFriend(req.fromUserId);
			this.activeFriendRequest = null;
			await this.refreshFriends();
		});
	}

	private checkFriendRequestsToast(): void {
		const toast = document.getElementById("toast-friend-request");
		const senderEl = document.getElementById("toast-friend-req-sender");
		if (!toast || !senderEl) return;

		if (this.friendRequests.length === 0) {
			if (this.activeFriendRequest) {
				toast.classList.add("hidden");
				this.activeFriendRequest = null;
			}
			return;
		}

		const latestReq = this.friendRequests[0];
		if (this.activeFriendRequest?.fromUserId !== latestReq.fromUserId) {
			this.activeFriendRequest = latestReq;
			senderEl.textContent = `@${latestReq.fromUsername}`;
			console.log(`[App] 🔔 Exibindo toast de pedido de amizade de @${latestReq.fromUsername}`);
			toast.classList.remove("hidden");
			this.refreshIcons();
		}
	}

	private setupNotificationsPopover(): void {
		const btnToggle = document.getElementById("btn-notifications-toggle");
		const popover = document.getElementById("notifications-popover");
		const btnClose = document.getElementById("btn-close-notifs");
		const btnClear = document.getElementById("btn-clear-notifs");
		const btnCreateNotice = document.getElementById("btn-open-create-notice");

		const updateDevBtn = () => {
			const currentUser = getUser();
			if (btnCreateNotice) {
				if (currentUser && currentUser.id === DEV_ADMIN_ID) {
					btnCreateNotice.classList.remove("hidden");
				} else {
					btnCreateNotice.classList.add("hidden");
				}
			}
		};
		updateDevBtn();

		btnToggle?.addEventListener("click", (e) => {
			e.stopPropagation();
			if (!popover) return;
			updateDevBtn();
			const isHidden = popover.classList.contains("hidden");
			if (isHidden) {
				popover.classList.remove("hidden");
				this.renderNotifications();
			} else {
				popover.classList.add("hidden");
			}
		});

		btnClose?.addEventListener("click", () => {
			popover?.classList.add("hidden");
		});

		popover?.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;

			// Dispensar aviso do sistema via delegação
			const btnDismissSys = target.closest<HTMLButtonElement>(".btn-notif-dismiss-sys");
			if (btnDismissSys) {
				e.preventDefault();
				e.stopPropagation();
				const id = btnDismissSys.getAttribute("data-notice-id") || btnDismissSys.dataset.noticeId;
				if (id) {
					this.dismissSystemNotice(id);
				}
				return;
			}
		});

		btnClear?.addEventListener("click", (e) => {
			e.stopPropagation();
			for (const sys of this.systemNotices) {
				this.dismissSystemNotice(sys.id);
			}
			this.systemNotices = [];
			this.renderNotifications();
		});

		// Filtros por abas
		const filterTabs = document.querySelectorAll<HTMLButtonElement>(".notif-filter-tab");
		filterTabs.forEach((tab) => {
			tab.addEventListener("click", () => {
				const filter = tab.dataset.filter as "all" | "friends" | "invites" | "system" | undefined;
				if (!filter) return;
				this.activeNotifFilter = filter;
				filterTabs.forEach((t) => t.classList.toggle("active", t.dataset.filter === filter));
				this.renderNotifications();
			});
		});

		document.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			if (popover && !popover.classList.contains("hidden")) {
				if (!popover.contains(target) && !btnToggle?.contains(target)) {
					popover.classList.add("hidden");
				}
			}
		});

		window.addEventListener("keydown", (e) => {
			if (e.key === "Escape" && popover && !popover.classList.contains("hidden")) {
				popover.classList.add("hidden");
			}
		});

		this.renderNotifications();
	}

	private isNoticeDismissed(id: string): boolean {
		try {
			const dismissed: string[] = JSON.parse(localStorage.getItem("shiro_dismissed_notices") || "[]");
			return Array.isArray(dismissed) && dismissed.includes(id);
		} catch {
			return false;
		}
	}

	public dismissSystemNotice(id: string): void {
		try {
			const dismissed: string[] = JSON.parse(localStorage.getItem("shiro_dismissed_notices") || "[]");
			if (!dismissed.includes(id)) {
				dismissed.push(id);
				localStorage.setItem("shiro_dismissed_notices", JSON.stringify(dismissed));
			}
		} catch (err) {
			console.warn("[App] Erro ao persistir aviso dispensado:", err);
		}
		this.systemNotices = this.systemNotices.filter((s) => s.id !== id);
		this.renderNotifications();
	}

	private renderNotifications(): void {
		const listEl = document.getElementById("notifications-list");
		const emptyEl = document.getElementById("notifications-empty-state");
		const badgeEl = document.getElementById("header-notif-badge");
		const totalBadge = document.getElementById("notif-total-badge");

		const countAllEl = document.getElementById("count-notif-all");
		const countFriendsEl = document.getElementById("count-notif-friends");
		const countInvitesEl = document.getElementById("count-notif-invites");
		const countSystemEl = document.getElementById("count-notif-system");

		const friendsCount = this.friendRequests.length;
		const invitesCount = this.roomInvites.length;
		const activeSystemNotices = this.systemNotices.filter((s) => !this.isNoticeDismissed(s.id));
		const systemCount = activeSystemNotices.length;
		const totalCount = friendsCount + invitesCount + systemCount;

		if (countAllEl) countAllEl.textContent = totalCount.toString();
		if (countFriendsEl) countFriendsEl.textContent = friendsCount.toString();
		if (countInvitesEl) countInvitesEl.textContent = invitesCount.toString();
		if (countSystemEl) countSystemEl.textContent = systemCount.toString();
		if (totalBadge) totalBadge.textContent = totalCount.toString();

		if (badgeEl) {
			if (totalCount > 0) {
				badgeEl.textContent = totalCount > 99 ? "99+" : totalCount.toString();
				badgeEl.classList.remove("hidden");
			} else {
				badgeEl.classList.add("hidden");
			}
		}

		if (!listEl) return;

		let itemsHtml = "";
		let visibleCount = 0;

		// 1. Pedidos de Amizade
		if (this.activeNotifFilter === "all" || this.activeNotifFilter === "friends") {
			for (const req of this.friendRequests) {
				visibleCount++;
				itemsHtml += `
					<div class="notif-item" data-type="friend">
						<div class="notif-item-header">
							<div class="notif-item-icon friend">
								<i data-lucide="user-plus"></i>
							</div>
							<div class="notif-item-body">
								<div class="notif-item-title">
									<strong>@${this.escapeHtml(req.fromUsername)}</strong> quer ser seu amigo
								</div>
								<div class="notif-item-sub">Pedido de amizade pendente</div>
							</div>
						</div>
						<div class="notif-item-actions">
							<button type="button" class="btn btn-ghost btn-xs btn-notif-profile" data-user-id="${this.escapeHtml(req.fromUserId)}" data-username="${this.escapeHtml(req.fromUsername)}" title="Ver Perfil">
								<i data-lucide="user"></i> <span>Ver Perfil</span>
							</button>
							<button type="button" class="btn btn-primary btn-xs btn-notif-accept-friend" data-user-id="${this.escapeHtml(req.fromUserId)}">
								<i data-lucide="check"></i> <span>Aceitar</span>
							</button>
							<button type="button" class="btn btn-danger-ghost btn-xs btn-notif-reject-friend" data-user-id="${this.escapeHtml(req.fromUserId)}" title="Recusar">
								<i data-lucide="x"></i> <span>Recusar</span>
							</button>
						</div>
					</div>
				`;
			}
		}

		// 2. Convites de Sala
		if (this.activeNotifFilter === "all" || this.activeNotifFilter === "invites") {
			for (const inv of this.roomInvites) {
				visibleCount++;
				const sender = inv.fromNickname || inv.fromUsername;
				itemsHtml += `
					<div class="notif-item" data-type="invite">
						<div class="notif-item-header">
							<div class="notif-item-icon invite">
								<i data-lucide="radio"></i>
							</div>
							<div class="notif-item-body">
								<div class="notif-item-title">
									<strong>${this.escapeHtml(sender)}</strong> convidou você para a sala
								</div>
								<div class="notif-item-sub">Sala: <strong style="color: #c4b5fd;">${this.escapeHtml(inv.roomName)}</strong></div>
							</div>
						</div>
						<div class="notif-item-actions">
							<button type="button" class="btn btn-primary btn-xs btn-notif-join-room" data-invite-id="${this.escapeHtml(inv.id)}" data-invite-code="${this.escapeHtml(inv.inviteCode)}" data-room-id="${this.escapeHtml(inv.roomId)}">
								<i data-lucide="log-in"></i> <span>Entrar na Sala</span>
							</button>
							<button type="button" class="btn btn-ghost btn-xs btn-notif-dismiss-invite" data-invite-id="${this.escapeHtml(inv.id)}" title="Recusar">
								<span>Recusar</span>
							</button>
						</div>
					</div>
				`;
			}
		}

		// 3. Avisos do Sistema
		if (this.activeNotifFilter === "all" || this.activeNotifFilter === "system") {
			for (const sys of activeSystemNotices) {
				visibleCount++;
				itemsHtml += `
					<div class="notif-item" data-type="system">
						<div class="notif-item-header">
							<div class="notif-item-icon system">
								<i data-lucide="info"></i>
							</div>
							<div class="notif-item-body">
								<div class="notif-item-title">${this.escapeHtml(sys.title)}</div>
								<div class="notif-item-sub">${this.escapeHtml(sys.message)}</div>
							</div>
						</div>
						<div class="notif-item-actions">
							<button type="button" class="btn btn-ghost btn-xs btn-notif-dismiss-sys" data-notice-id="${this.escapeHtml(sys.id)}" title="Dispensar aviso">
								<i data-lucide="check"></i> <span>Dispensar</span>
							</button>
						</div>
					</div>
				`;
			}
		}

		listEl.innerHTML = itemsHtml;

		if (emptyEl) {
			if (visibleCount === 0) emptyEl.classList.remove("hidden");
			else emptyEl.classList.add("hidden");
		}

		// Ações dos botões nas notificações:
		listEl.querySelectorAll<HTMLButtonElement>(".btn-notif-profile").forEach((btn) => {
			btn.addEventListener("click", () => {
				const userId = btn.dataset.userId!;
				const username = btn.dataset.username!;
				const userObj = this.onlineUsers.find((u) => u.id === userId || u.username === username) || {
					id: userId,
					username: username,
					nickname: username,
					isOnline: true,
				};
				const popover = document.getElementById("notifications-popover");
				if (popover) popover.classList.add("hidden");
				this.showUserMiniProfile(userObj, btn);
			});
		});

		listEl.querySelectorAll<HTMLButtonElement>(".btn-notif-accept-friend").forEach((btn) => {
			btn.addEventListener("click", async () => {
				const userId = btn.dataset.userId!;
				btn.disabled = true;
				await acceptFriendRequest(userId);
				await this.refreshFriends();
			});
		});

		listEl.querySelectorAll<HTMLButtonElement>(".btn-notif-reject-friend").forEach((btn) => {
			btn.addEventListener("click", async () => {
				const userId = btn.dataset.userId!;
				btn.disabled = true;
				await rejectFriend(userId);
				await this.refreshFriends();
			});
		});

		listEl.querySelectorAll<HTMLButtonElement>(".btn-notif-join-room").forEach((btn) => {
			btn.addEventListener("click", async () => {
				const inviteId = btn.dataset.inviteId!;
				const inviteCode = btn.dataset.inviteCode!;
				const roomId = btn.dataset.roomId!;
				btn.disabled = true;
				await dismissRoomInvite(inviteId);

				const popover = document.getElementById("notifications-popover");
				if (popover) popover.classList.add("hidden");

				const res = await joinRoomByInvite(inviteCode);
				if (res.ok && res.room) {
					await this.onRoomSelected(res.room);
				} else {
					const resJoin = await joinRoom(roomId);
					if (resJoin.ok && resJoin.room) {
						await this.onRoomSelected(resJoin.room);
					} else {
						alert(res.error || "Não foi possível entrar na sala.");
					}
				}
				await this.refreshFriends();
			});
		});

		listEl.querySelectorAll<HTMLButtonElement>(".btn-notif-dismiss-invite").forEach((btn) => {
			btn.addEventListener("click", async () => {
				const inviteId = btn.dataset.inviteId!;
				btn.disabled = true;
				await dismissRoomInvite(inviteId);
				await this.refreshFriends();
			});
		});

		listEl.querySelectorAll<HTMLButtonElement>(".btn-notif-dismiss-sys").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				const id = btn.getAttribute("data-notice-id") || btn.dataset.noticeId;
				if (id) {
					this.dismissSystemNotice(id);
				}
			});
		});

		this.refreshIcons();
	}

	private setupStreamDeckBridge(): void {
		if (!window.api || this.streamDeckBridgeInitialized) return;
		this.streamDeckBridgeInitialized = true;

		// 1. Toggle stream (iniciar / parar transmissão)
		window.api.onStreamDeckToggle(() => {
			if (this.p2pManager?.getIsStreaming()) {
				this.stopStreaming();
			} else {
				this.startStreaming();
			}
		});

		// 2. Consulta de estado de transmissão
		window.api.onStreamDeckGetState(() => {
			window.api.reportStreamShareState(this.p2pManager?.getIsStreaming() ?? false);
		});

		// 3. Consulta de lista de fontes de captura
		window.api.onStreamDeckGetSources(() => {
			window.api.respondSources(
				this.allSources.map((s) => ({
					id: s.id,
					name: s.name,
					processName: s.processName,
					sourceType: s.sourceType,
					thumbnailUrl: s.thumbnailUrl,
				})),
				this.selectedSourceIndex,
			);
		});

		// 4. Seleção direta de fonte por índice
		window.api.onStreamDeckSelectSource((index: number) => {
			if (index >= 0 && index < this.allSources.length) {
				const source = this.allSources[index];
				this.leftSourcePicker?.setSelectedSource(source);
				this.onSourceSelected(source);
			}
		});

		// 5. Alternância sequencial de fontes (Cycle Source)
		window.api.onStreamDeckCycleSource?.(() => {
			if (this.allSources.length > 0) {
				const nextIndex = (this.selectedSourceIndex + 1) % this.allSources.length;
				const source = this.allSources[nextIndex];
				this.leftSourcePicker?.setSelectedSource(source);
				this.onSourceSelected(source);
				if (window.api.reportSources) {
					window.api.reportSources(
						this.allSources.map((s) => ({
							id: s.id,
							name: s.name,
							processName: s.processName,
							sourceType: s.sourceType,
							thumbnailUrl: s.thumbnailUrl,
						})),
						nextIndex,
					);
				}
			}
		});

		// 6. Consulta de modo de áudio
		window.api.onStreamDeckGetAudioMode?.(() => {
			const mode = this.getSelectedAudioMode();
			window.api.respondAudioMode(mode);
		});

		// 7. Configuração direta de modo de áudio
		window.api.onStreamDeckSetAudioMode?.((mode: AudioCaptureMode) => {
			const radio = document.querySelector(`input[name="audioMode"][value="${mode}"]`) as HTMLInputElement | null;
			if (radio) {
				radio.checked = true;
				document.querySelectorAll(".radio-card").forEach((c) => {
					const r = c.querySelector('input[type="radio"]') as HTMLInputElement | null;
					c.classList.toggle("active", r?.value === mode);
				});
				if (this.p2pManager?.getIsStreaming()) {
					const source = this.leftSourcePicker?.getSelectedSource() ?? this.mainSourcePicker?.getSelectedSource();
					if (source) this.onSourceSelected(source);
				}
				window.api.reportAudioMode(mode);
			}
		});

		// 8. Alternância sequencial de modo de áudio (Cycle Audio Mode)
		window.api.onStreamDeckCycleAudioMode?.(() => {
			const modes: AudioCaptureMode[] = ["process", "system", "disabled"];
			const current = this.getSelectedAudioMode();
			const next = modes[(modes.indexOf(current) + 1) % modes.length];
			const radio = document.querySelector(`input[name="audioMode"][value="${next}"]`) as HTMLInputElement | null;
			if (radio) {
				radio.checked = true;
				document.querySelectorAll(".radio-card").forEach((c) => {
					const r = c.querySelector('input[type="radio"]') as HTMLInputElement | null;
					c.classList.toggle("active", r?.value === next);
				});
				if (this.p2pManager?.getIsStreaming()) {
					const source = this.leftSourcePicker?.getSelectedSource() ?? this.mainSourcePicker?.getSelectedSource();
					if (source) this.onSourceSelected(source);
				}
				window.api.reportAudioMode(next);
			}
		});

		// 9. Trazer o app para o primeiro plano (Launch Activity)
		window.api.onStreamDeckLaunchActivity?.(() => {
			window.api?.maximizeWindow?.();
		});
	}


	private updateHeaderUserInfo(): void {
		const user = getUser();
		if (!user) return;
		const headerUsername = document.getElementById("header-username");
		const headerAvatar = document.getElementById("header-user-avatar");
		const displayName = user.nickname || user.username;

		if (headerUsername) {
			headerUsername.textContent = displayName;
			headerUsername.title = user.nickname
				? `${user.nickname} (@${user.username}) ・ Clique para editar perfil`
				: `@${user.username} ・ Clique para editar perfil`;
		}
		if (headerAvatar) {
			this.renderUserAvatar(headerAvatar, user);
		}
	}

	private renderUserAvatar(
		container: HTMLElement,
		user: { username: string; nickname?: string; avatar?: string },
	): void {
		const displayName = user.nickname || user.username;
		const initial = (displayName && displayName.trim().length > 0) ? displayName.trim()[0].toUpperCase() : "?";

		container.innerHTML = "";
		if (user.avatar && user.avatar.trim().startsWith("http")) {
			const img = document.createElement("img");
			img.src = user.avatar.trim();
			img.alt = displayName;
			img.onerror = () => {
				img.remove();
				container.textContent = initial;
			};
			container.appendChild(img);
		} else {
			container.textContent = initial;
		}
	}


	private setupProfileSettings(): void {
		const headerInfo = document.getElementById("header-user-info");
		const modal = document.getElementById("modal-profile-settings");
		const btnClose = document.getElementById("btn-close-profile-modal");
		const btnCancel = document.getElementById("btn-cancel-profile-settings");
		const form = document.getElementById("form-profile-settings");
		const inputNick = document.getElementById("input-profile-nickname") as HTMLInputElement | null;
		const inputAvatar = document.getElementById("input-profile-avatar") as HTMLInputElement | null;
		const inputBanner = document.getElementById("input-profile-banner") as HTMLInputElement | null;
		const btnClearAvatar = document.getElementById("btn-clear-profile-avatar");
		const btnClearBanner = document.getElementById("btn-clear-profile-banner");
		const previewDisplayName = document.getElementById("profile-preview-display-name");
		const previewUsername = document.getElementById("profile-preview-username");
		const previewFallback = document.getElementById("profile-avatar-preview-fallback");
		const previewImg = document.getElementById("profile-avatar-preview-img") as HTMLImageElement | null;
		const previewBanner = document.getElementById("profile-banner-preview");
		const rateBadge = document.getElementById("nickname-rate-badge");
		const rateText = document.getElementById("nickname-rate-text");
		const errorEl = document.getElementById("profile-settings-error");
		const successEl = document.getElementById("profile-settings-success");

		let remainingChanges = 6;
		let maxChanges = 6;

		const updateRateBadge = (remaining: number, max = 6) => {
			remainingChanges = remaining;
			maxChanges = max;
			if (rateText) {
				rateText.textContent = `${remaining}/${max} trocas restantes`;
			}
			if (rateBadge) {
				rateBadge.classList.remove("warning", "danger");
				if (remaining === 0) {
					rateBadge.classList.add("danger");
				} else if (remaining <= 2) {
					rateBadge.classList.add("warning");
				}
			}
		};

		const updateLivePreview = () => {
			const user = getUser();
			if (!user) return;

			const nickVal = inputNick?.value.trim() || "";
			const avatarVal = inputAvatar?.value.trim() || "";
			const bannerVal = inputBanner?.value.trim() || "";

			const displayName = nickVal.length > 0 ? nickVal : user.username;
			if (previewDisplayName) previewDisplayName.textContent = displayName;
			if (previewUsername) previewUsername.textContent = `@${user.username}`;

			if (previewFallback) {
				previewFallback.textContent = displayName[0]?.toUpperCase() || "?";
			}

			if (avatarVal.startsWith("http")) {
				if (previewImg) {
					previewImg.src = avatarVal;
					previewImg.classList.remove("hidden");
					if (previewFallback) previewFallback.classList.add("hidden");
					previewImg.onerror = () => {
						previewImg.classList.add("hidden");
						if (previewFallback) previewFallback.classList.remove("hidden");
					};
					previewImg.onload = () => {
						previewImg.classList.remove("hidden");
						if (previewFallback) previewFallback.classList.add("hidden");
					};
				}
				if (btnClearAvatar) btnClearAvatar.classList.remove("hidden");
			} else {
				if (previewImg) {
					previewImg.classList.add("hidden");
					previewImg.src = "";
				}
				if (previewFallback) previewFallback.classList.remove("hidden");
				if (btnClearAvatar) btnClearAvatar.classList.add("hidden");
			}

			if (bannerVal.startsWith("http")) {
				if (previewBanner) {
					previewBanner.style.backgroundImage = `url("${bannerVal}")`;
				}
				if (btnClearBanner) btnClearBanner.classList.remove("hidden");
			} else {
				if (previewBanner) {
					previewBanner.style.backgroundImage = "";
				}
				if (btnClearBanner) btnClearBanner.classList.add("hidden");
			}
		};

		const openModal = async () => {
			const user = getUser();
			if (!user) return;

			if (errorEl) errorEl.textContent = "";
			if (successEl) {
				successEl.textContent = "";
				successEl.classList.add("hidden");
			}

			if (inputNick) inputNick.value = user.nickname || "";
			if (inputAvatar) inputAvatar.value = user.avatar || "";
			if (inputBanner) inputBanner.value = user.banner || "";

			updateLivePreview();
			modal?.classList.remove("hidden");
			this.refreshIcons();

			// Carrega limites reais do backend
			try {
				const profileData = await getProfile();
				if (profileData.ok && profileData.user) {
					if (profileData.remainingNicknameChanges !== undefined) {
						updateRateBadge(profileData.remainingNicknameChanges, profileData.maxNicknameChangesPerHour || 6);
					}
				}
			} catch (err) {
				console.warn("[App] Erro ao obter perfil atualizado:", err);
			}

			inputNick?.focus();
		};

		const closeModal = () => {
			modal?.classList.add("hidden");
			if (errorEl) errorEl.textContent = "";
			if (successEl) {
				successEl.textContent = "";
				successEl.classList.add("hidden");
			}
		};

		headerInfo?.addEventListener("click", openModal);
		btnClose?.addEventListener("click", closeModal);
		btnCancel?.addEventListener("click", closeModal);

		inputNick?.addEventListener("input", updateLivePreview);
		inputAvatar?.addEventListener("input", updateLivePreview);
		inputBanner?.addEventListener("input", updateLivePreview);

		btnClearAvatar?.addEventListener("click", () => {
			if (inputAvatar) inputAvatar.value = "";
			updateLivePreview();
		});

		btnClearBanner?.addEventListener("click", () => {
			if (inputBanner) inputBanner.value = "";
			updateLivePreview();
		});

		form?.addEventListener("submit", async (e) => {
			e.preventDefault();
			const nickname = inputNick?.value.trim();
			const avatar = inputAvatar?.value.trim();
			const banner = inputBanner?.value.trim();

			if (errorEl) errorEl.textContent = "";
			if (successEl) {
				successEl.textContent = "";
				successEl.classList.add("hidden");
			}

			this.setAuthLoading("btn-save-profile-settings", true);

			const result = await updateProfile({
				nickname: nickname !== undefined ? nickname : undefined,
				avatar: avatar !== undefined ? avatar : undefined,
				banner: banner !== undefined ? banner : undefined,
			});

			this.setAuthLoading("btn-save-profile-settings", false);

			if (!result.ok) {
				if (errorEl) errorEl.textContent = result.error ?? "Erro ao salvar perfil.";
				return;
			}

			if (result.remainingNicknameChanges !== undefined) {
				updateRateBadge(result.remainingNicknameChanges, result.maxNicknameChangesPerHour || 6);
			}

			if (successEl) {
				successEl.textContent = "Perfil atualizado com sucesso!";
				successEl.classList.remove("hidden");
			}

			this.updateHeaderUserInfo();
			this.refreshUsersList();

			setTimeout(() => {
				closeModal();
			}, 900);
		});
	}

	// ------------------------------------------------------------------------------------------------------------------------------
	//  MINI PERFIL FLUTUANTE (POPOVER LATERAL DIREITO)
	// ------------------------------------------------------------------------------------------------------------------------------
	private setupMiniProfilePopover(): void {
		const popover = document.getElementById("user-mini-profile-popover");
		const btnClose = document.getElementById("btn-close-mini-profile");

		btnClose?.addEventListener("click", () => {
			this.hideUserMiniProfile();
		});

		document.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			if (popover && !popover.classList.contains("hidden")) {
				if (!popover.contains(target) && !target.closest(".user-card") && !target.closest(".friend-card")) {
					this.hideUserMiniProfile();
				}
			}
		});

		window.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				this.hideUserMiniProfile();
			}
		});
	}

	private showUserMiniProfile(
		userData: {
			id: string;
			username: string;
			nickname?: string;
			avatar?: string;
			banner?: string;
			isOnline?: boolean;
			badges?: BadgeId[];
			badgeStats?: BadgeStats;
		},
		targetEl: HTMLElement,
	): void {
		const popover = document.getElementById("user-mini-profile-popover");
		if (!popover) return;

		this.activeMiniProfileUserId = userData.id;

		const currentUser = getUser();
		const isSelf = userData.id === currentUser?.id || userData.username === currentUser?.username;
		const displayName = userData.nickname ? userData.nickname : userData.username;
		const initial = (displayName && displayName.length > 0) ? displayName[0].toUpperCase() : "?";

		const bannerEl = document.getElementById("user-mini-banner");
		if (bannerEl) {
			if (userData.banner && userData.banner.trim().startsWith("http")) {
				bannerEl.style.backgroundImage = `url("${this.escapeHtml(userData.banner.trim())}")`;
			} else {
				bannerEl.style.backgroundImage = "";
			}
		}

		const avatarEl = document.getElementById("user-mini-avatar");
		if (avatarEl) {
			if (userData.avatar && userData.avatar.trim().startsWith("http")) {
				avatarEl.innerHTML = `<img src="${this.escapeHtml(userData.avatar.trim())}" alt="${this.escapeHtml(displayName)}" onerror="this.remove(); this.parentElement.textContent='${initial}';" />`;
			} else {
				avatarEl.textContent = initial;
			}
		}

		const statusDot = document.getElementById("user-mini-status-dot");
		if (statusDot) {
			if (userData.isOnline === false) {
				statusDot.className = "user-mini-status-dot offline";
				statusDot.title = "Offline";
			} else {
				statusDot.className = "user-mini-status-dot online";
				statusDot.title = "Online";
			}
		}

		const badgesEl = document.getElementById("user-mini-badges");
		if (badgesEl) {
			badgesEl.innerHTML =
				this.renderProfileBadges(userData.badges, userData.badgeStats) +
				(isSelf ? `<span class="badge badge-purple" style="font-size: 10px; padding: 2px 7px;">Você</span>` : "");
		}

		const nameEl = document.getElementById("user-mini-display-name");
		if (nameEl) nameEl.textContent = displayName;

		const userEl = document.getElementById("user-mini-username");
		if (userEl) userEl.textContent = `@${userData.username}`;

		const nickValEl = document.getElementById("user-mini-nick-val");
		if (nickValEl) nickValEl.textContent = `${userData.username}`;

		const idValEl = document.getElementById("user-mini-id-val");
		if (idValEl) idValEl.textContent = userData.id;

		const btnCopyNick = document.getElementById("btn-copy-mini-nick");
		if (btnCopyNick) {
			btnCopyNick.onclick = () => {
				navigator.clipboard.writeText(userData.username);
				btnCopyNick.classList.add("copied");
				btnCopyNick.innerHTML = `<i data-lucide="check"></i> <span>Copiado!</span>`;
				this.refreshIcons();
				setTimeout(() => {
					btnCopyNick.classList.remove("copied");
					btnCopyNick.innerHTML = `<i data-lucide="copy"></i> <span>Copiar</span>`;
					this.refreshIcons();
				}, 1500);
			};
		}

		const btnCopyId = document.getElementById("btn-copy-mini-id");
		if (btnCopyId) {
			btnCopyId.onclick = () => {
				navigator.clipboard.writeText(userData.id);
				btnCopyId.classList.add("copied");
				btnCopyId.innerHTML = `<i data-lucide="check"></i> <span>Copiado!</span>`;
				this.refreshIcons();
				setTimeout(() => {
					btnCopyId.classList.remove("copied");
					btnCopyId.innerHTML = `<i data-lucide="copy"></i> <span>Copiar</span>`;
					this.refreshIcons();
				}, 1500);
			};
		}

		const actionsEl = document.getElementById("user-mini-actions");
		if (actionsEl) {
			if (isSelf) {
				actionsEl.innerHTML = `
					<button type="button" id="btn-mini-edit-profile" class="btn btn-secondary btn-sm">
						<i data-lucide="user-cog"></i>
						<span>Editar Meu Perfil</span>
					</button>
				`;
				document.getElementById("btn-mini-edit-profile")?.addEventListener("click", () => {
					this.hideUserMiniProfile();
					document.getElementById("header-user-info")?.click();
				});
			} else {
				const isFriend = this.friends.some((f) => f.id === userData.id || f.username === userData.username);
				const incomingReq = this.friendRequests.find((r) => r.fromUserId === userData.id || r.fromUsername === userData.username);
				const requestSent = this.sentFriendRequestUserIds.has(userData.id);

				let actionButtons = "";

				if (incomingReq) {
					actionButtons += `
						<div class="user-mini-actions-row">
							<button type="button" id="btn-mini-accept-friend" class="btn btn-primary btn-sm">
								<i data-lucide="user-check"></i>
								<span>Aceitar Pedido</span>
							</button>
							<button type="button" id="btn-mini-reject-friend" class="btn btn-danger-ghost btn-sm" title="Recusar pedido">
								<i data-lucide="x"></i>
								<span>Recusar</span>
							</button>
						</div>
					`;
				} else if (isFriend) {
					actionButtons += `
						<div class="user-mini-friend-badge">
							<i data-lucide="user-check"></i>
							<span>Vocês são amigos</span>
						</div>
					`;
				} else {
					actionButtons += `
						<button type="button" id="btn-mini-add-friend" class="btn ${this.currentRoom ? "btn-secondary" : "btn-primary"} btn-sm" ${requestSent ? "disabled" : ""}>
							<i data-lucide="${requestSent ? "check" : "user-plus"}"></i>
							<span>${requestSent ? "Pedido Enviado" : "Adicionar Amigo"}</span>
						</button>
					`;
				}

				if (this.currentRoom) {
					actionButtons += `
						<button type="button" id="btn-mini-invite-room" class="btn btn-primary btn-sm">
							<i data-lucide="radio"></i>
							<span>Convidar para Sala</span>
						</button>
					`;
				}

				actionsEl.innerHTML = actionButtons;

				// 1. Ação de Aceitar Pedido no perfil
				document.getElementById("btn-mini-accept-friend")?.addEventListener("click", async () => {
					const btnAccept = document.getElementById("btn-mini-accept-friend") as HTMLButtonElement | null;
					const btnReject = document.getElementById("btn-mini-reject-friend") as HTMLButtonElement | null;
					if (btnAccept) {
						btnAccept.disabled = true;
						btnAccept.innerHTML = `<i data-lucide="loader-2" class="spin"></i>`;
						this.refreshIcons();
					}
					if (btnReject) btnReject.disabled = true;

					const reqUserId = incomingReq?.fromUserId || userData.id;
					const res = await acceptFriendRequest(reqUserId);
					if (res.ok) {
						await this.refreshFriends();
						this.showUserMiniProfile(userData, targetEl);
					} else {
						if (btnAccept) {
							btnAccept.disabled = false;
							btnAccept.innerHTML = `<span>Erro ao aceitar</span>`;
						}
						if (btnReject) btnReject.disabled = false;
					}
				});

				// 2. Ação de Recusar Pedido no perfil
				document.getElementById("btn-mini-reject-friend")?.addEventListener("click", async () => {
					const btnAccept = document.getElementById("btn-mini-accept-friend") as HTMLButtonElement | null;
					const btnReject = document.getElementById("btn-mini-reject-friend") as HTMLButtonElement | null;
					if (btnReject) {
						btnReject.disabled = true;
						btnReject.innerHTML = `<i data-lucide="loader-2" class="spin"></i>`;
						this.refreshIcons();
					}
					if (btnAccept) btnAccept.disabled = true;

					const reqUserId = incomingReq?.fromUserId || userData.id;
					await rejectFriend(reqUserId);
					await this.refreshFriends();
					this.hideUserMiniProfile();
				});

				// 3. Ação de Enviar Pedido de Amizade no perfil
				document.getElementById("btn-mini-add-friend")?.addEventListener("click", async () => {
					const btn = document.getElementById("btn-mini-add-friend") as HTMLButtonElement | null;
					if (!btn || btn.disabled) return;
					btn.disabled = true;
					btn.innerHTML = `<i data-lucide="loader-2" class="spin"></i> <span>Enviando...</span>`;
					this.refreshIcons();

					const res = await sendFriendRequest(userData.username || userData.id);
					if (res.ok) {
						btn.innerHTML = `<i data-lucide="check"></i> <span>Pedido Enviado!</span>`;
						this.sentFriendRequestUserIds.add(userData.id);
						this.refreshIcons();
						await this.refreshFriends();
					} else {
						btn.innerHTML = `<span>${this.escapeHtml(res.error || "Erro ao adicionar")}</span>`;
						setTimeout(() => {
							if (btn && !this.sentFriendRequestUserIds.has(userData.id)) {
								btn.disabled = false;
								btn.innerHTML = `<i data-lucide="user-plus"></i> <span>Adicionar Amigo</span>`;
								this.refreshIcons();
							}
						}, 2500);
					}
				});

				// 4. Ação de Convidar para Sala
				if (this.currentRoom) {
					document.getElementById("btn-mini-invite-room")?.addEventListener("click", async () => {
						const btn = document.getElementById("btn-mini-invite-room") as HTMLButtonElement | null;
						if (btn) {
							btn.disabled = true;
							btn.innerHTML = `<i data-lucide="loader-2" class="spin"></i>`;
							this.refreshIcons();
						}
						const res = await inviteFriendToRoom(userData.id, this.currentRoom!.roomId);
						if (btn) {
							if (res.ok) {
								btn.innerHTML = `<i data-lucide="check"></i> <span>Convite Enviado!</span>`;
							} else {
								btn.innerHTML = `<span>${this.escapeHtml(res.error || "Erro ao convidar")}</span>`;
							}
							this.refreshIcons();
							setTimeout(() => {
								if (btn) {
									btn.disabled = false;
									btn.innerHTML = `<i data-lucide="radio"></i> <span>Convidar para Sala</span>`;
									this.refreshIcons();
								}
							}, 2000);
						}
					});
				}
			}
		}

		this.appendDevBadgeActions(userData, targetEl);

		popover.classList.remove("hidden");
		this.refreshIcons();

		// Posiciona à direita do targetEl, flutuando sem colisão com o que está atrás
		const targetRect = targetEl.getBoundingClientRect();
		const popoverRect = popover.getBoundingClientRect();
		const popoverWidth = popoverRect.width || 290;
		const popoverHeight = popoverRect.height || 300;

		let left = targetRect.right + 12;
		if (left + popoverWidth > window.innerWidth - 12) {
			left = Math.max(12, targetRect.left - popoverWidth - 12);
		}

		let top = targetRect.top - 16;
		if (top + popoverHeight > window.innerHeight - 16) {
			top = window.innerHeight - popoverHeight - 16;
		}
		if (top < 16) top = 16;

		popover.style.left = `${left}px`;
		popover.style.top = `${top}px`;
	}

	private isViewerDeveloper(): boolean {
		const me = getUser();
		return !!me && DEVELOPER_IDS.includes(me.id);
	}

	/** HTML das insígnias de um perfil (tooltip mostra a última contagem das estatísticas) */
	private renderProfileBadges(badges: BadgeId[] | undefined, stats: BadgeStats | undefined): string {
		if (!badges?.length) return "";
		const viewerIsDev = this.isViewerDeveloper();
		return (Object.keys(BADGE_DEFS) as BadgeId[])
			.filter((id) => badges.includes(id))
			.map((id) => {
				const def = BADGE_DEFS[id];
				const tooltip = this.escapeHtml(`${def.name} — ${def.describe(stats, viewerIsDev)}`);
				return `<span class="profile-badge profile-badge-${id}" data-tooltip="${tooltip}" data-tooltip-pos="bottom" aria-label="${tooltip}">
					<i data-lucide="${def.icon}"></i>
				</span>`;
			})
			.join("");
	}

	/** Desenvolvedores veem no mini perfil o botão para dar/remover a insígnia Beta Tester */
	private appendDevBadgeActions(
		userData: { id: string; username: string; badges?: BadgeId[]; badgeStats?: BadgeStats },
		targetEl: HTMLElement,
	): void {
		const actionsEl = document.getElementById("user-mini-actions");
		if (!actionsEl || !this.isViewerDeveloper()) return;

		const hasBeta = userData.badges?.includes("beta-tester") ?? false;
		const row = document.createElement("div");
		row.className = "user-mini-dev-actions";
		row.innerHTML = `
			<button type="button" class="btn btn-ghost btn-sm btn-dev-badge">
				<i data-lucide="flask-conical"></i>
				<span>${hasBeta ? "Remover Beta Tester" : "Dar insígnia Beta Tester"}</span>
			</button>`;
		actionsEl.appendChild(row);

		const btn = row.querySelector<HTMLButtonElement>(".btn-dev-badge")!;
		btn.addEventListener("click", async () => {
			btn.disabled = true;
			const res = await setUserBadge(userData.id, "beta-tester", !hasBeta);
			if (!res.ok) {
				btn.disabled = false;
				alert(res.error || "Erro ao atualizar insígnia.");
				return;
			}

			// Atualiza as cópias locais do usuário e reabre o mini perfil com as insígnias novas
			const apply = (u: { id: string; badges?: BadgeId[]; badgeStats?: BadgeStats }) => {
				if (u.id !== userData.id) return;
				u.badges = res.badges;
				u.badgeStats = res.badgeStats ?? u.badgeStats;
			};
			this.onlineUsers.forEach(apply);
			this.friends.forEach(apply);
			const updated = { ...userData, badges: res.badges, badgeStats: res.badgeStats ?? userData.badgeStats };
			if (targetEl.isConnected) this.showUserMiniProfile(updated, targetEl);
		});
	}

	private hideUserMiniProfile(): void {
		const popover = document.getElementById("user-mini-profile-popover");
		if (popover) popover.classList.add("hidden");
		this.activeMiniProfileUserId = null;
		document.querySelectorAll(".user-card.selected, .friend-card.selected").forEach((c) => c.classList.remove("selected"));
	}

	public addSystemNotice(notice: { title: string; message: string; type?: "info" | "warning" | "update"; date?: string }): void {
		const newNotice: SystemNotice = {
			id: `sys-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
			title: notice.title,
			message: notice.message,
			type: notice.type || "info",
			date: notice.date || "Agora",
		};
		this.systemNotices.unshift(newNotice);
		this.renderNotifications();
	}

	private setupSystemNoticeToast(): void {
		const btnDismiss = document.getElementById("btn-dismiss-system-toast");
		const toast = document.getElementById("toast-system-notice");
		const toastContent = document.getElementById("toast-system-notice-content");

		btnDismiss?.addEventListener("click", (e) => {
			e.stopPropagation();
			toast?.classList.add("hidden");
		});

		toastContent?.addEventListener("click", () => {
			toast?.classList.add("hidden");
			const popover = document.getElementById("notifications-popover");
			if (popover) {
				popover.classList.remove("hidden");
				const systemTab = document.querySelector<HTMLButtonElement>('.notif-filter-tab[data-filter="system"]');
				if (systemTab) systemTab.click();
			}
		});
	}

	public showSystemNoticeToast(notice: SystemNotice): void {
		const toast = document.getElementById("toast-system-notice");
		const titleEl = document.getElementById("toast-system-title");
		const msgEl = document.getElementById("toast-system-msg");
		const badgeEl = document.getElementById("toast-system-badge");
		const iconEl = document.getElementById("toast-system-notice-icon");

		if (!toast || !titleEl || !msgEl) return;

		titleEl.textContent = notice.title;
		msgEl.textContent = notice.message;

		if (badgeEl && iconEl) {
			if (notice.type === "warning") {
				badgeEl.textContent = "ALERTA";
				badgeEl.style.background = "linear-gradient(135deg, #f59e0b, #d97706)";
				iconEl.style.background = "linear-gradient(135deg, #f59e0b, #d97706)";
				iconEl.innerHTML = `<i data-lucide="alert-triangle"></i>`;
			} else if (notice.type === "update") {
				badgeEl.textContent = "NOVIDADE";
				badgeEl.style.background = "linear-gradient(135deg, #a855f7, #7c3aed)";
				iconEl.style.background = "linear-gradient(135deg, #a855f7, #7c3aed)";
				iconEl.innerHTML = `<i data-lucide="sparkles"></i>`;
			} else {
				badgeEl.textContent = "COMUNICADO";
				badgeEl.style.background = "linear-gradient(135deg, #3b82f6, #1d4ed8)";
				iconEl.style.background = "linear-gradient(135deg, #3b82f6, #1d4ed8)";
				iconEl.innerHTML = `<i data-lucide="info"></i>`;
			}
		}

		toast.classList.remove("hidden");
		this.refreshIcons();

		setTimeout(() => {
			if (titleEl.textContent === notice.title) {
				toast.classList.add("hidden");
			}
		}, 12000);
	}

	private setupCreateNoticeModal(): void {
		const modal = document.getElementById("modal-create-notice");
		const btnOpen = document.getElementById("btn-open-create-notice");
		const btnClose = document.getElementById("btn-close-create-notice-modal");
		const btnCancel = document.getElementById("btn-cancel-create-notice");
		const form = document.getElementById("form-create-notice") as HTMLFormElement | null;
		const inputTitle = document.getElementById("input-notice-title") as HTMLInputElement | null;
		const inputMessage = document.getElementById("input-notice-message") as HTMLTextAreaElement | null;
		const checkPopup = document.getElementById("check-notice-popup") as HTMLInputElement | null;
		const checkOS = document.getElementById("check-notice-os") as HTMLInputElement | null;

		const closeModal = () => {
			modal?.classList.add("hidden");
			form?.reset();
		};

		btnOpen?.addEventListener("click", () => {
			const currentUser = getUser();
			if (!currentUser || currentUser.id !== DEV_ADMIN_ID) {
				alert("Acesso exclusivo do Desenvolvedor.");
				return;
			}
			document.getElementById("notifications-popover")?.classList.add("hidden");
			modal?.classList.remove("hidden");
			inputTitle?.focus();
			this.refreshIcons();
		});

		btnClose?.addEventListener("click", closeModal);
		btnCancel?.addEventListener("click", closeModal);

		form?.addEventListener("submit", async (e) => {
			e.preventDefault();
			const currentUser = getUser();
			if (!currentUser || currentUser.id !== DEV_ADMIN_ID) {
				alert("Ação não autorizada. Apenas o desenvolvedor pode lançar comunicados.");
				return;
			}

			const title = inputTitle?.value.trim() || "";
			const message = inputMessage?.value.trim() || "";
			const typeEl = form.querySelector<HTMLInputElement>('input[name="noticeType"]:checked');
			const type = (typeEl?.value as "info" | "warning" | "update") || "info";

			if (!title || !message) return;

			const notice: SystemNotice = {
				id: `sys-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
				title,
				message,
				type,
				date: "Agora",
			};

			// 1. Registra localmente no aplicativo
			this.addSystemNotice(notice);

			// 2. Se habilitado, dispara toast popup imediato na tela
			if (checkPopup?.checked) {
				this.showSystemNoticeToast(notice);
			}

			// 3. Se habilitado, dispara notificação nativa do Windows
			if (checkOS?.checked && "Notification" in window) {
				try {
					if (Notification.permission === "granted") {
						new Notification(title, {
							body: message,
						});
					} else if (Notification.permission !== "denied") {
						Notification.requestPermission().then((perm) => {
							if (perm === "granted") {
								new Notification(title, {
									body: message,
								});
							}
						});
					}
				} catch (err) {
					console.warn("[App] Notificação nativa não suportada ou bloqueada:", err);
				}
			}

			// 4. Propagação via WebRTC P2P DataChannel para todos os peers conectados
			this.p2pManager?.broadcastNotice(notice);

			// 5. Tenta enviar para o backend API para persistência global
			const token = getToken();
			if (window.api && token) {
				window.api.apiRequest?.({
					endpoint: "/api/system/notice",
					method: "POST",
					token,
					body: notice,
				}).catch(() => {
					// Fallback silencioso se a rota no backend não estiver criada ainda
				});
			}

			closeModal();
		});
	}

	/**
	 * Renderiza os ícones lucide pendentes. O createIcons padrão recria TODOS os ícones
	 * do documento a cada chamada (os SVGs mantêm data-lucide), o que trocava elementos
	 * no meio de cliques e fazia botões "não responderem". Aqui só são processados os
	 * <i data-lucide> novos e os SVGs cujo data-lucide mudou (ex.: ícone da sala no header).
	 */
	private refreshIcons(): void {
		const PENDING = "data-lucide-pending";
		const RENDERED = "data-lucide-rendered";
		let pendingCount = 0;
		document.querySelectorAll<Element>("[data-lucide]").forEach((el) => {
			const name = el.getAttribute("data-lucide");
			if (!name) return;
			const isSvg = el.tagName.toLowerCase() === "svg";
			if (!isSvg || el.getAttribute(RENDERED) !== name) {
				el.setAttribute(PENDING, name);
				pendingCount++;
			}
		});
		if (pendingCount === 0) return;

		try {
			createIcons({
				nameAttr: PENDING,
				icons: {
					Sun, Moon, Monitor, Zap, Wifi, WifiOff, Target, RefreshCw,
					AppWindow, ScreenShare, Video, PlayCircle, Volume1, Volume2, ShieldCheck,
					VolumeX, MicOff, Radio, CheckCircle2, Play, Square, Loader2,
					Settings, X, Power, User, Users, Lock, Eye, EyeOff, LogOut, Search,
					ChevronLeft, ChevronRight, Check, Copy, RotateCw, Sparkles, Globe,
					UserCog, BadgeCheck, Camera, Image, Trash2, Clock,
					UserCheck, UserPlus, Bell, BellOff, LogIn, KeyRound, Hash, CheckCheck,
					Megaphone, AlertTriangle, Send, Info, Cat, ExternalLink, CircleHelp, GraduationCap,
					CodeXml, FlaskConical, Hammer, House, Timer,
				},
			});
		} catch (err) {
			console.warn("[App] Icon creation warning:", err);
		}

		// Marca os SVGs gerados como renderizados (e limpa pendências de ícones desconhecidos)
		document.querySelectorAll<Element>(`[${PENDING}]`).forEach((el) => {
			const name = el.getAttribute(PENDING);
			el.removeAttribute(PENDING);
			if (el.tagName.toLowerCase() === "svg" && name) el.setAttribute(RENDERED, name);
		});
	}
}

const app = new ShiroApp();
(window as any).shiroApp = app;
app.initialize().catch((err) => console.error("[App] Init error:", err));