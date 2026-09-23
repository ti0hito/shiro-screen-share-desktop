import {
	AppWindow,
	Check,
	CheckCircle2,
	ChevronLeft,
	ChevronRight,
	Copy,
	createIcons,
	Eye,
	EyeOff,
	Loader2,
	Lock,
	LogOut,
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
	Settings,
	ShieldCheck,
	Sparkles,
	Square,
	Sun,
	Target,
	User,
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
	checkSavedSession,
	createRoom,
	getOnlineUsers,
	getRooms,
	getToken,
	getUser,
	isAuthenticated,
	joinRoom,
	leaveRoom,
	login,
	logout,
	notifyRoomStream,
	register,
	RoomInfo,
	SavedSessionResult,
	saveRememberSession,
	sendHeartbeat,
	ShiroUser,
} from "./authManager";
import { P2PManager } from "./p2pManager";
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

class ShiroApp {
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
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private usersRefreshInterval: ReturnType<typeof setInterval> | null = null;
	private roomsRefreshInterval: ReturnType<typeof setInterval> | null = null;
	private thumbnailInterval: ReturnType<typeof setInterval> | null = null;

	private rooms: RoomInfo[] = [];
	private onlineUsers: ShiroUser[] = [];
	private currentRoom: RoomInfo | null = null;
	private targetJoinRoomId: string | null = null;
	private remoteStreams = new Map<string, { stream: MediaStream; username: string }>();
	private maximizedStreamId: string | null = null;
	private streamDeckBridgeInitialized = false;

	public async initialize(): Promise<void> {
		console.log("[App] Initializing Shiro Screen Share...");
		this.refreshIcons();
		this.setupLoginWindowControls();
		this.setupStreamDeckBridge();

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

		this.setupAuthTabs();
		this.setupAuthForms();

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
			const headerUsername = document.getElementById("header-username");
			const headerAvatar = document.getElementById("header-user-avatar");
			if (headerUsername) headerUsername.textContent = user.username;
			if (headerAvatar) headerAvatar.textContent = user.username[0].toUpperCase();
		}

		if (user) {
			this.p2pManager = new P2PManager(user.id, {
				onConnected: (peerId) => {
					console.log(`[App] P2P conectado com sucesso a ${peerId}`);
					if (this.p2pManager?.getIsStreaming()) {
						setStreamStatus(true, "🔴 AO VIVO");
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
					const activeStreamer = this.currentRoom?.activeStreams?.find((s) => s.userId === peerId);
					const onlineUser = this.onlineUsers.find((u) => u.id === peerId);
					const username = activeStreamer?.username ?? onlineUser?.username ?? peerId;
					this.remoteStreams.set(peerId, { stream, username });
					this.renderLiveStreamsGrid();
				},
			});
			this.p2pManager.startSignaling();
		}

		setupWindowControls();
		this.setupThemeToggle();
		this.setupPanelTabs();
		this.setupRoomListeners();
		this.setupSourcePicker();
		this.setupSubTabs();
		this.setupStreamButtons();
		this.setupPopoverToggles();
		this.setupAudioRadioListeners();
		this.setupQualityChangeListeners();
		this.setupCustomSelects();
		this.setupAppSettings();
		this.setupLogout();
		this.setupStreamDeckBridge();

		this.audioVisualizer.mount("vu-canvas");
		this.refreshIcons();

		await this.refreshRooms();
		await this.refreshSources();
		await this.refreshUsersList();

		this.heartbeatInterval = setInterval(() => sendHeartbeat(), 60_000);
		sendHeartbeat();

		this.usersRefreshInterval = setInterval(() => this.refreshUsersList(), 20_000);
		this.roomsRefreshInterval = setInterval(() => this.refreshRooms(), 2_500);
		this.thumbnailInterval = setInterval(() => this.updateAllThumbnails(), 120_000); // Atualiza preview estática a cada 2 minutos

		window.addEventListener("keydown", (e) => {
			if (e.key === "Escape") this.restoreGridMode();
		});
	}

	private setupPanelTabs(): void {
		const tabRooms = document.getElementById("panel-tab-rooms");
		const tabSources = document.getElementById("panel-tab-sources");
		const tabUsers = document.getElementById("panel-tab-users");
		const btnToggleSidebar = document.getElementById("btn-toggle-sidebar");

		const panelRooms = document.getElementById("panel-rooms");
		const panelSources = document.getElementById("panel-sources");
		const panelUsers = document.getElementById("panel-users");

		const activate = (activeTab: HTMLElement | null, activePanel: HTMLElement | null) => {
			[tabRooms, tabSources, tabUsers].forEach((t) => t?.classList.remove("active"));
			[panelRooms, panelSources, panelUsers].forEach((p) => p?.classList.add("hidden"));

			activeTab?.classList.add("active");
			activePanel?.classList.remove("hidden");
			this.refreshIcons();
		};

		tabRooms?.addEventListener("click", () => activate(tabRooms, panelRooms));
		tabSources?.addEventListener("click", () => {
			if (!this.currentRoom) return; // O botão fica disabled via atributos HTML/CSS com tooltip no hover
			activate(tabSources, panelSources);
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

	// ══════════════════════════════════════════
	//  ROOMS, MODALS & SEARCH
	// ══════════════════════════════════════════
	private setupRoomListeners(): void {
		// Abrir modal de criação de sala
		document.getElementById("btn-open-create-room")?.addEventListener("click", () => {
			const modal = document.getElementById("modal-create-room");
			if (modal) modal.classList.remove("hidden");
			(document.getElementById("create-room-name") as HTMLInputElement)?.focus();
			this.refreshIcons();
		});

		const closeCreateModal = () => {
			document.getElementById("modal-create-room")?.classList.add("hidden");
			const err = document.getElementById("create-room-error");
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

			if (errorEl) errorEl.textContent = "";
			const res = await createRoom({ name, roomId: customId || undefined, password: password || undefined });

			if (!res.ok || !res.room) {
				if (errorEl) errorEl.textContent = res.error ?? "Erro ao criar sala.";
				return;
			}

			closeCreateModal();
			await this.refreshRooms();
			await this.onRoomSelected(res.room);
		});

		// Abrir modal de Buscar / Entrar em Sala por ID
		document.getElementById("btn-open-join-by-id")?.addEventListener("click", () => {
			const modal = document.getElementById("modal-join-by-id");
			if (modal) modal.classList.remove("hidden");
			(document.getElementById("join-by-id-room-id") as HTMLInputElement)?.focus();
			this.refreshIcons();
		});

		const closeJoinByIdModal = () => {
			document.getElementById("modal-join-by-id")?.classList.add("hidden");
			const err = document.getElementById("join-by-id-error");
			if (err) err.textContent = "";
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
			const err = document.getElementById("join-room-error");
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
				sourcesTab.title = "Entre em uma sala para liberar as fontes";
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
	}

	private getRoomMembersCount(room?: any): number {
		if (!room) return 1;
		if (typeof room.membersCount === "number" && !isNaN(room.membersCount)) return room.membersCount;
		if (typeof room.memberCount === "number" && !isNaN(room.memberCount)) return room.memberCount;
		if (Array.isArray(room.members)) return room.members.length;
		if (typeof room.members === "number" && !isNaN(room.members)) return room.members;
		if (Array.isArray(room.users)) return room.users.length;
		return 1;
	}

	private updateCurrentRoomBanner(): void {
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
				if (this.currentRoom.isPrivate) {
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

			const members = this.getRoomMembersCount(this.currentRoom);
			const streams = Array.isArray(this.currentRoom.activeStreams) ? this.currentRoom.activeStreams.length : 0;

			const membersEl = document.getElementById("current-room-members-count");
			if (membersEl) membersEl.innerHTML = `<i data-lucide="users"></i> ${members} membro(s)`;

			const streamsEl = document.getElementById("current-room-streams-count");
			if (streamsEl) streamsEl.innerHTML = `<i data-lucide="radio"></i> ${streams} ao vivo`;

			const copyBtn = document.getElementById("btn-copy-current-room-id");
			if (copyBtn && !copyBtn.querySelector("svg")) {
				copyBtn.innerHTML = `<i data-lucide="copy"></i>`;
			}
		}

		if (headerPill && headerRoomName) {
			headerPill.classList.remove("hidden");
			headerRoomName.textContent = this.currentRoom.name;
			if (this.currentRoom.isPrivate) {
				headerPill.classList.add("is-private");
				if (headerRoomIcon) headerRoomIcon.setAttribute("data-lucide", "lock");
			} else {
				headerPill.classList.remove("is-private");
				if (headerRoomIcon) headerRoomIcon.setAttribute("data-lucide", "radio");
			}
		}

		this.refreshIcons();
	}

	private async refreshRooms(): Promise<void> {
		this.rooms = await getRooms();
		const searchInput = document.getElementById("input-search-rooms") as HTMLInputElement | null;
		const query = searchInput?.value.toLowerCase() ?? "";
		this.renderRoomsList(query);

		// Atualiza o estado da sala ativa e auto-conecta a transmissões ativas
		if (this.currentRoom) {
			const updated = this.rooms.find((r) => r.roomId === this.currentRoom!.roomId);
			if (updated) {
				this.currentRoom = updated;
				this.autoConnectRoomStreams();
			}
		}
		this.updateCurrentRoomBanner();
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
				this.remoteStreams.delete(peerId);
				if (this.maximizedStreamId === `stream-card-${peerId}`) {
					this.restoreGridMode();
				} else {
					this.renderLiveStreamsGrid();
				}
			}
		}

		// 2. Conecta a qualquer transmissão ativa na sala que ainda não esteja visível
		for (const streamInfo of activeStreams) {
			if (streamInfo.userId && streamInfo.userId !== currentUser?.id) {
				const hasStream = this.remoteStreams.has(streamInfo.userId);
				if (!hasStream) {
					console.log(`[App] Detectada stream ativa de ${streamInfo.username} (${streamInfo.userId}) fora do grid. Re-negociando P2P...`);
					const hasConn = this.p2pManager?.hasPeerConnection(streamInfo.userId);
					await this.p2pManager?.renegotiate(streamInfo.userId, !hasConn);
				}
			}
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

				return `
				<div class="room-item ${isActive ? "active" : ""}" data-room-id="${r.roomId}">
					<div class="room-item-left">
						<i data-lucide="radio" class="room-item-icon"></i>
						<div class="room-item-details">
							<span class="room-item-name">${this.escapeHtml(r.name)}</span>
							<span class="room-item-sub">ID: ${r.roomId} • ${membersCount} membro(s)</span>
						</div>
					</div>
					<div class="room-item-right">
						${r.isPrivate ? '<span class="room-lock-badge" title="Sala Privada (Protegida por senha)"><i data-lucide="lock"></i></span>' : ""}
						${streamCount > 0 ? `<span class="room-streams-badge">🔴 ${streamCount}</span>` : ""}
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
					(document.getElementById("join-room-password") as HTMLInputElement)?.focus();
					this.refreshIcons();
				} else {
					const res = await joinRoom(targetRoom.roomId);
					if (res.ok && res.room) {
						await this.onRoomSelected(res.room);
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
			sourcesTab.title = "Fontes de captura";
		}

		// Ativa a aba de fontes para o usuário selecionar o que transmitir
		[tabRooms, sourcesTab, tabUsers].forEach((t) => t?.classList.remove("active"));
		[panelRooms, panelSources, panelUsers].forEach((p) => p?.classList.add("hidden"));
		sourcesTab?.classList.add("active");
		panelSources?.classList.remove("hidden");

		// Auto-conecta a transmissões ativas já em andamento na sala
		await this.autoConnectRoomStreams();
		await this.refreshRooms();
	}

	// ══════════════════════════════════════════
	//  LIVE MULTI-STREAM GRID & MAXIMIZE
	// ══════════════════════════════════════════
	private renderLiveStreamsGrid(): void {
		const gridEl = document.getElementById("live-streams-grid");
		if (!gridEl) return;

		const isLocalStreaming = this.p2pManager?.getIsStreaming() && this.previewStream;

		if (this.remoteStreams.size === 0 && !isLocalStreaming) {
			gridEl.innerHTML = `
				<div id="main-grid-placeholder" class="main-grid-placeholder">
					<i data-lucide="radio" class="placeholder-lucide-icon"></i>
					<h3>Grid de Transmissões ao Vivo</h3>
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
					<span class="badge badge-live">🔴 AO VIVO</span>
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
						<span class="badge badge-live">🔴 AO VIVO</span>
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
				// Se a transmissão estiver aberta (maximizada), toca no volume desejado; senão mantém mudo na preview
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
		const indicator = document.querySelector(".sub-tabs-indicator") as HTMLElement | null;

		const moveIndicator = (tab: HTMLElement) => {
			if (!indicator) return;
			indicator.style.width = `${tab.offsetWidth}px`;
			indicator.style.left = `${tab.offsetLeft}px`;
		};

		if (tabWindows && tabScreens) {
			moveIndicator(tabWindows);

			tabWindows.addEventListener("click", () => {
				tabWindows.classList.add("active");
				tabScreens.classList.remove("active");
				moveIndicator(tabWindows);
				this.leftSourcePicker?.setFilter("window");
				this.mainSourcePicker?.setFilter("window");
				this.refreshIcons();
			});

			tabScreens.addEventListener("click", () => {
				tabScreens.classList.add("active");
				tabWindows.classList.remove("active");
				moveIndicator(tabScreens);
				this.leftSourcePicker?.setFilter("screen");
				this.mainSourcePicker?.setFilter("screen");
				this.refreshIcons();
			});

			window.addEventListener("resize", () => {
				const activeTab = document.querySelector(".sub-tab-btn.active") as HTMLElement | null;
				if (activeTab) moveIndicator(activeTab);
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
		setInterval(() => this.refreshSources(), 15_000);
	}

	// ══════════════════════════════════════════
	//  USERS PANEL (Exibe todos, inclusive Você)
	// ══════════════════════════════════════════
	private async refreshUsersList(): Promise<void> {
		const listEl = document.getElementById("users-list");
		if (!listEl) return;

		const users = await getOnlineUsers();
		this.onlineUsers = users;
		const currentUser = getUser();

		if (users.length === 0) {
			listEl.innerHTML = `
				<div class="users-empty">
					<i data-lucide="wifi-off"></i>
					<span>Nenhum usuário online</span>
				</div>`;
			this.refreshIcons();
			return;
		}

		listEl.innerHTML = users
			.map((u) => {
				const isSelf = u.id === currentUser?.id;
				const isSelected = this.selectedTargetUserId === u.id;

				return `
			<div class="user-card ${isSelected ? "selected" : ""} ${isSelf ? "self-user" : ""}" data-user-id="${u.id}" data-username="${u.username}">
				<div class="user-card-avatar">
					${u.username[0].toUpperCase()}
					<div class="user-card-status-dot"></div>
				</div>
				<div class="user-card-info">
					<span class="user-card-name">${this.escapeHtml(u.username)} ${isSelf ? '<span class="user-self-tag">você</span>' : ""}</span>
					<span class="user-card-id">ID: ${u.id}</span>
				</div>
			</div>`;
			})
			.join("");

		listEl.querySelectorAll<HTMLElement>(".user-card").forEach((card) => {
			card.addEventListener("click", () => {
				listEl.querySelectorAll(".user-card").forEach((c) => c.classList.remove("selected"));
				card.classList.add("selected");
			});
		});

		document.getElementById("btn-refresh-users")?.addEventListener("click", () => {
			this.refreshUsersList();
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

		if (selectedSource) {
			btnStart.disabled = false;
			btnStart.title = "Iniciar transmissão P2P";
		} else {
			btnStart.disabled = true;
			btnStart.title = "Selecione uma fonte antes de transmitir";
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

		setStreamStatus(true, "🔴 AO VIVO");
		if (window.api) window.api.reportStreamShareState(true);

		document.getElementById("btn-start-stream")?.classList.add("hidden");
		document.getElementById("btn-stop-stream")?.classList.remove("hidden");

		this.renderLiveStreamsGrid();

		try {
			if (this.currentRoom) {
				await notifyRoomStream(this.currentRoom.roomId, "start");
			}

			if (this.selectedTargetUserId) {
				await this.p2pManager?.renegotiate(this.selectedTargetUserId);
			} else {
				const onlineUsers = await getOnlineUsers();
				this.onlineUsers = onlineUsers;
				const currentUser = getUser();
				for (const u of onlineUsers) {
					if (u.id !== currentUser?.id) {
						await this.p2pManager?.renegotiate(u.id);
					}
				}
			}
		} catch (err: any) {
			console.error("[App] Erro P2P:", err);
			alert(`Erro ao conectar P2P: ${err.message}`);
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
			if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
			if (this.usersRefreshInterval) clearInterval(this.usersRefreshInterval);
			if (this.roomsRefreshInterval) clearInterval(this.roomsRefreshInterval);
			if (this.thumbnailInterval) clearInterval(this.thumbnailInterval);

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

		btnSettings?.addEventListener("click", (e) => {
			e.stopPropagation();
			audioPopover?.classList.add("hidden");
			btnAudio?.classList.remove("active");
			const hidden = settingsPopover?.classList.toggle("hidden");
			btnSettings.classList.toggle("active", !hidden);
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


	private refreshIcons(): void {
		try {
			createIcons({
				icons: {
					Sun, Moon, Monitor, Zap, Wifi, WifiOff, Target, RefreshCw,
					AppWindow, ScreenShare, Video, PlayCircle, Volume1, Volume2, ShieldCheck,
					VolumeX, MicOff, Radio, CheckCircle2, Play, Square, Loader2,
					Settings, X, Power, User, Users, Lock, Eye, EyeOff, LogOut, Search,
					ChevronLeft, ChevronRight, Check, Copy, RotateCw, Sparkles,
				},
			});
		} catch (err) {
			console.warn("[App] Icon creation warning:", err);
		}
	}
}

const app = new ShiroApp();
app.initialize().catch((err) => console.error("[App] Init error:", err));
