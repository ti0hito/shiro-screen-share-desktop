/**
 * chatManager.ts — Gerenciador de Chat Efêmero em Tempo Real no Cliente
 *
 * Princípios:
 * 1. ZERO PERSISTÊNCIA EM BANCO: Nenhuma mensagem é salva em banco de dados ou persistida no servidor.
 * 2. LÍDER-RÉPLICA (Cache Distribuído em Memória):
 *    - O usuário mais antigo na sala é eleito o Líder.
 *    - Todos os participantes guardam as mensagens que receberem na memória RAM durante a sessão.
 *    - Quando um novo usuário conecta, o Líder responde ao evento `chat:request_history`
 *      entregando seu histórico em memória para o novato (`chat:deliver_history`).
 *    - Se o Líder sair, o próximo usuário assume como Líder de forma transparente.
 *    - Ao sair da sala ou fechar o app, o histórico local é limpo da memória.
 * 3. FAVORITOS DE GIFS (Persistência Local no Cliente):
 *    - O usuário pode favoritar GIFs tanto na busca/em alta quanto diretamente nos balões do chat.
 *    - Aba dedicada de Favoritos no popover com visualização e remoção imediata.
 */

import { getToken } from "./authManager";
import { playUiSound } from "./soundManager";

export interface ChatUser {
	id: string;
	username: string;
	nickname?: string;
	avatar?: string | null;
}

export interface ChatMessage {
	id: string;
	roomId: string;
	sender: ChatUser;
	content: string;
	gifUrl?: string;
	replyTo?: {
		id: string;
		senderName: string;
		senderUsername?: string;
		content: string;
		gifUrl?: string;
	};
	editedAt?: number;
	timestamp: number;
}

export interface FavoriteGif {
	id: string;
	title: string;
	url: string;
	previewUrl: string;
	addedAt: number;
}

export class ChatManager {
	public static readonly MAX_MESSAGE_LENGTH = 500;
	private readonly instanceId = `app_${Math.random().toString(36).slice(2, 10)}`;
	private historyRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private currentRoomId: string | null = null;
	private currentUser: ChatUser | null = null;
	private messages: ChatMessage[] = [];
	private isLeader = false;
	private unreadCount = 0;
	private isTabActive = false;
	private apiUrl: string = "https://share.shirobot.xyz";
	private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private typingUsers = new Map<string, { name: string; timer: ReturnType<typeof setTimeout> }>();
	private lastTypingSentAt = 0;
	private localStopTypingTimer: ReturnType<typeof setTimeout> | null = null;
	private isLocalTyping = false;
	private safeImageCache = new Map<string, boolean>();
	private replyingTo: ChatMessage | null = null;

	// Gerenciamento de GIFs & Favoritos
	private activeGifTab: "trending" | "favorites" = "trending";
	private favoriteGifs: FavoriteGif[] = [];
	private cachedTrending: Array<{ id: string; title: string; url: string; previewUrl: string }> | null = null;
	private cachedSearches = new Map<string, Array<{ id: string; title: string; url: string; previewUrl: string }>>();

	// Callbacks para sincronizar com app.ts
	public onUnreadCountChanged?: (count: number) => void;
	public onRefreshIcons?: () => void;
	public onBroadcastP2PMessage?: (msg: ChatMessage) => void;
	public onBroadcastP2PTyping?: (typing: { roomId: string; user: ChatUser; isTyping: boolean }) => void;
	public onOpenUserProfile?: (user: ChatUser, anchorEl: HTMLElement) => void;

	constructor() {
		this.loadFavoriteGifs();
		this.initElements();
		this.initSseSignalListener();
		document.addEventListener("click", () => this.closeContextMenu());
		window.addEventListener("keydown", (e) => {
			if (e.key === "Escape") this.closeContextMenu();
		});
	}

	private sameRoom(id?: string): boolean {
		return !!id && !!this.currentRoomId && id.toUpperCase() === this.currentRoomId.toUpperCase();
	}

	/** Pede o histórico aos demais clientes da sala (app/web). Eles respondem via SSE. */
	private requestHistory(): void {
		const token = getToken();
		if (!token || !this.currentRoomId || !window.api?.apiRequest) return;
		window.api
			.apiRequest({
				endpoint: "/api/signal/chat/history",
				method: "POST",
				body: { roomId: this.currentRoomId, action: "request", instanceId: this.instanceId },
				token,
			})
			.catch(() => {});
	}

	private mergeMessages(incoming: ChatMessage[]): boolean {
		const seen = new Set(this.messages.map((m) => m.id));
		let added = false;
		for (const m of incoming) {
			if (m && m.id && !seen.has(m.id)) {
				this.messages.push(m);
				seen.add(m.id);
				added = true;
			}
		}
		if (added) this.messages.sort((a, b) => a.timestamp - b.timestamp);
		return added;
	}

	private initSseSignalListener(): void {
		if (!window.api?.onSseSignal) return;
		window.api.onSseSignal((event: string, data: any) => {
			if (event === "hello") {
				// SSE (re)conectou: pode ter perdido mensagens, sincroniza o histórico
				if (this.currentRoomId) this.requestHistory();
			} else if (event === "chat:new_message") {
				const msg = data as ChatMessage;
				if (!msg || !this.sameRoom(msg.roomId)) return;
				if (this.messages.some((m) => m.id === msg.id)) return;

				this.clearUserTyping(msg.sender);
				this.messages.push(msg);
				this.appendMessageElement(msg);
				if (
					!this.currentUser ||
					(this.currentUser.id !== msg.sender?.id &&
						this.currentUser.username !== msg.sender?.username)
				) {
					playUiSound("new_message");
				}

				if (!this.isTabActive) {
					this.unreadCount++;
					this.updateUnreadBadge();
					this.onUnreadCountChanged?.(this.unreadCount);
				}
				this.scrollToBottom();
			} else if (event === "chat:edit_message") {
				const edit = data as { roomId?: string; messageId?: string; userId?: string; content?: string; editedAt?: number };
				if (!edit || !this.sameRoom(edit.roomId) || !edit.messageId || typeof edit.content !== "string") return;
				const target = this.messages.find((m) => m.id === edit.messageId);
				if (target && (!edit.userId || target.sender.id === edit.userId)) {
					target.content = edit.content;
					target.editedAt = edit.editedAt || Date.now();
					this.renderMessages();
				}
			} else if (event === "chat:delete_message") {
				const del = data as { roomId?: string; messageId?: string; userId?: string };
				if (!del || !this.sameRoom(del.roomId) || !del.messageId) return;
				const idx = this.messages.findIndex(
					(m) => m.id === del.messageId && (!del.userId || m.sender.id === del.userId),
				);
				if (idx !== -1) {
					this.messages.splice(idx, 1);
					this.renderMessages();
				}
			} else if (event === "chat:typing") {
				this.handleIncomingTyping(data);
			} else if (event === "chat:request_history") {
				const req = data as { forUserId?: string; fromUserId?: string; roomId: string; instanceId?: string };
				if (!req || !this.sameRoom(req.roomId)) return;
				if (req.instanceId === this.instanceId) return; // meu próprio pedido
				if (this.messages.length === 0) return;
				const target = req.forUserId || req.fromUserId;
				if (!target) return;
				const token = getToken();
				if (!token || !window.api?.apiRequest) return;
				window.api
					.apiRequest({
						endpoint: "/api/signal/chat/history",
						method: "POST",
						body: {
							roomId: req.roomId,
							action: "deliver",
							targetUserId: target,
							forUserId: target,
							messages: this.messages.slice(-150).map((m) => ({
								...m,
								sender: { ...m.sender, avatar: null },
							})),
						},
						token,
					})
					.catch(() => {});
			} else if (event === "chat:history_received") {
				const hist = data as { roomId?: string; messages: ChatMessage[] };
				if (hist?.roomId && !this.sameRoom(hist.roomId)) return;
				if (Array.isArray(hist?.messages) && this.mergeMessages(hist.messages)) {
					this.renderMessages();
				}
			}
		});
	}

	public receiveP2PMessage(msg: ChatMessage): void {
		if (!msg || !this.currentRoomId || msg.roomId !== this.currentRoomId) return;
		if (this.messages.some((m) => m.id === msg.id)) return;
		this.clearUserTyping(msg.sender);
		this.messages.push(msg);
		this.appendMessageElement(msg);
		if (
			!this.currentUser ||
			(this.currentUser.id !== msg.sender?.id &&
				this.currentUser.username !== msg.sender?.username)
		) {
			playUiSound("new_message");
		}
		if (!this.isTabActive) {
			this.unreadCount++;
			this.updateUnreadBadge();
			this.onUnreadCountChanged?.(this.unreadCount);
		}
		this.scrollToBottom();
	}

	public receiveP2PTyping(data: { roomId?: string; user?: ChatUser; isTyping?: boolean }): void {
		this.handleIncomingTyping(data);
	}

	private handleIncomingTyping(data: { roomId?: string; user?: ChatUser; isTyping?: boolean }): void {
		if (!data || !this.sameRoom(data.roomId) || !data.user) return;
		if (
			this.currentUser &&
			(data.user.id === this.currentUser.id || data.user.username === this.currentUser.username)
		) {
			return;
		}
		const key = data.user.id || data.user.username;
		if (!key) return;

		if (!data.isTyping) {
			this.clearUserTyping(data.user);
			return;
		}

		const existing = this.typingUsers.get(key);
		if (existing) clearTimeout(existing.timer);

		const name = data.user.nickname || data.user.username || "Alguém";
		const timer = setTimeout(() => {
			this.typingUsers.delete(key);
			this.renderTypingIndicator();
		}, 4500);

		this.typingUsers.set(key, { name, timer });
		this.renderTypingIndicator();
	}

	private clearUserTyping(user?: ChatUser | null): void {
		if (!user) return;
		const keys = [user.id, user.username].filter(Boolean) as string[];
		let changed = false;
		for (const k of keys) {
			const entry = this.typingUsers.get(k);
			if (entry) {
				clearTimeout(entry.timer);
				this.typingUsers.delete(k);
				changed = true;
			}
		}
		if (changed) this.renderTypingIndicator();
	}

	private clearAllTypingUsers(): void {
		for (const entry of this.typingUsers.values()) {
			clearTimeout(entry.timer);
		}
		this.typingUsers.clear();
		this.renderTypingIndicator();
	}

	private renderTypingIndicator(): void {
		const bar = document.getElementById("chat-typing-bar");
		if (!bar) return;

		const names = Array.from(this.typingUsers.values()).map((u) => this.escapeHtml(u.name));
		if (names.length === 0) {
			bar.classList.add("hidden");
			bar.innerHTML = "";
			return;
		}

		let label = "";
		if (names.length === 1) {
			label = `<strong>${names[0]}</strong> está digitando`;
		} else if (names.length === 2) {
			label = `<strong>${names[0]}</strong> e <strong>${names[1]}</strong> estão digitando`;
		} else {
			label = `<strong>Várias pessoas</strong> estão digitando`;
		}

		bar.innerHTML = `<span>${label}<span class="typing-dots"><span>.</span><span>.</span><span>.</span></span></span>`;
		bar.classList.remove("hidden");
	}

	private emitLocalTyping(isTyping: boolean): void {
		if (!this.currentRoomId || !this.currentUser) return;
		if (!isTyping && !this.isLocalTyping) return;

		const now = Date.now();
		if (isTyping && this.isLocalTyping && now - this.lastTypingSentAt < 2500) {
			return;
		}

		this.isLocalTyping = isTyping;
		this.lastTypingSentAt = now;

		const payload = {
			roomId: this.currentRoomId,
			user: {
				id: this.currentUser.id,
				username: this.currentUser.username,
				nickname: this.currentUser.nickname || this.currentUser.username,
			},
			isTyping,
		};

		this.onBroadcastP2PTyping?.(payload);

		const token = getToken();
		if (token && window.api?.apiRequest) {
			window.api
				.apiRequest({
					endpoint: "/api/signal/chat/typing",
					method: "POST",
					body: { roomId: this.currentRoomId, isTyping },
					token,
				})
				.catch(() => {});
		}
	}

	public async init(): Promise<void> {
		if (window.api?.getApiUrl) {
			try {
				this.apiUrl = await window.api.getApiUrl();
			} catch {
				this.apiUrl = "https://share.shirobot.xyz";
			}
		}
	}

	public setTabActive(active: boolean): void {
		this.isTabActive = active;
		if (active) {
			this.unreadCount = 0;
			this.updateUnreadBadge();
			this.onUnreadCountChanged?.(0);
			this.scrollToBottom();
			if (this.messages.length === 0 && this.currentRoomId) {
				this.requestHistory();
			}
		}
	}

	private updateUnreadBadge(): void {
		const badge = document.getElementById("chat-unread-badge");
		if (!badge) return;
		badge.textContent = String(this.unreadCount);
		if (this.unreadCount > 0 && !this.isTabActive) {
			badge.classList.remove("hidden");
		} else {
			badge.classList.add("hidden");
		}
	}

	public async joinRoom(roomId: string, user: ChatUser): Promise<void> {
		if (this.currentRoomId === roomId.toUpperCase()) {
			return;
		}

		this.leaveRoom();
		this.currentRoomId = roomId.toUpperCase();
		this.currentUser = user;
		this.messages = [];
		this.isLeader = false;
		this.unreadCount = 0;
		this.updateUnreadBadge();
		this.onUnreadCountChanged?.(0);
		this.renderMessages();

		await this.init();
		this.requestHistory();
		// Se ninguém respondeu ainda (SSE conectando / ninguém com histórico), tenta de novo
		this.historyRetryTimer = setTimeout(() => {
			if (this.messages.length === 0) {
				this.requestHistory();
				this.historyRetryTimer = setTimeout(() => {
					if (this.messages.length === 0) this.requestHistory();
				}, 2000);
			}
		}, 1500);
	}

	public leaveRoom(): void {
		if (this.historyRetryTimer) {
			clearTimeout(this.historyRetryTimer);
			this.historyRetryTimer = null;
		}
		if (this.localStopTypingTimer) {
			clearTimeout(this.localStopTypingTimer);
			this.localStopTypingTimer = null;
		}
		if (this.isLocalTyping) {
			this.emitLocalTyping(false);
		}
		this.clearAllTypingUsers();
		this.replyingTo = null;
		this.renderReplyBar();
		this.closeContextMenu();
		this.currentRoomId = null;
		this.messages = [];
		this.isLeader = false;
		this.unreadCount = 0;
		this.updateUnreadBadge();
		this.onUnreadCountChanged?.(0);
		this.updateLeaderBadge();
		this.renderMessages();
	}

	public sendMessage(content: string, gifUrl?: string): void {
		const text = (content || "").trim().slice(0, ChatManager.MAX_MESSAGE_LENGTH);
		if (!text && !gifUrl) return;
		if (!this.currentRoomId) return;

		if (this.localStopTypingTimer) {
			clearTimeout(this.localStopTypingTimer);
			this.localStopTypingTimer = null;
		}
		if (this.isLocalTyping) {
			this.emitLocalTyping(false);
		}

		const replyTo = this.replyingTo
			? {
					id: this.replyingTo.id,
					senderName: this.replyingTo.sender.nickname || this.replyingTo.sender.username || "Usuário",
					senderUsername: this.replyingTo.sender.username,
					content: (this.replyingTo.content || "").slice(0, 180),
					gifUrl: this.replyingTo.gifUrl,
				}
			: undefined;

		const tempId = `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
		const message: ChatMessage = {
			id: tempId,
			roomId: this.currentRoomId,
			sender: this.currentUser || {
				id: "me",
				username: "Você",
			},
			content: text,
			gifUrl: gifUrl || undefined,
			...(replyTo ? { replyTo } : {}),
			timestamp: Date.now(),
		};

		this.replyingTo = null;
		this.renderReplyBar();

		// 1. Atualização Otimista Imediata na UI (0ms)
		this.messages.push(message);
		this.appendMessageElement(message);
		this.scrollToBottom();

		// 3. Envio via sinalização efêmera SSE/HTTP (Vercel Serverless / produção)
		const token = getToken();
		if (token && window.api?.apiRequest) {
			window.api.apiRequest({
				endpoint: "/api/signal/chat",
				method: "POST",
				body: {
					roomId: this.currentRoomId,
					content: text,
					gifUrl: gifUrl || undefined,
					tempId,
					replyTo,
				},
				token,
			}).catch((err) => console.warn("[Chat] Erro ao enviar mensagem via sinal:", err));
		}

		// 4. Dispara broadcast direto via P2P DataChannel caso haja canal aberto
		this.onBroadcastP2PMessage?.(message);
	}

	private updateLeaderBadge(): void {
		const badge = document.getElementById("chat-leader-badge");
		if (!badge) return;
		if (this.isLeader && this.currentRoomId) {
			badge.classList.remove("hidden");
		} else {
			badge.classList.add("hidden");
		}
		this.onRefreshIcons?.();
	}

	/* ══════════════════════════════════════════════════════════
	   SISTEMA DE FAVORITOS DE GIFS (LocalStorage)
	   ══════════════════════════════════════════════════════════ */

	private loadFavoriteGifs(): void {
		try {
			const saved = localStorage.getItem("shiro_favorite_gifs");
			if (saved) {
				const parsed = JSON.parse(saved);
				if (Array.isArray(parsed)) {
					this.favoriteGifs = parsed;
				}
			}
		} catch {
			this.favoriteGifs = [];
		}
		this.updateFavoritesCountBadge();
	}

	private saveFavoriteGifs(): void {
		try {
			localStorage.setItem("shiro_favorite_gifs", JSON.stringify(this.favoriteGifs));
		} catch (err) {
			console.error("[Chat] Erro ao salvar favoritos no localStorage:", err);
		}
		this.updateFavoritesCountBadge();
	}

	public isGifFavorite(urlOrId: string): boolean {
		if (!urlOrId) return false;
		return this.favoriteGifs.some((g) => g.url === urlOrId || g.id === urlOrId);
	}

	public toggleFavoriteGif(gif: { id?: string; title?: string; url: string; previewUrl?: string }): boolean {
		if (!gif.url) return false;
		const existingIndex = this.favoriteGifs.findIndex((g) => g.url === gif.url || (gif.id && g.id === gif.id));
		let isNowFavorite = false;

		if (existingIndex >= 0) {
			// Remove dos favoritos
			this.favoriteGifs.splice(existingIndex, 1);
			isNowFavorite = false;
		} else {
			// Adiciona aos favoritos no início da lista
			this.favoriteGifs.unshift({
				id: gif.id || `fav_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
				title: gif.title || "GIF Favorito",
				url: gif.url,
				previewUrl: gif.previewUrl || gif.url,
				addedAt: Date.now(),
			});
			isNowFavorite = true;
		}

		this.saveFavoriteGifs();

		// Se a aba ativa for Favoritos, atualiza o grid imediatamente
		if (this.activeGifTab === "favorites") {
			this.renderFavoritesGifs();
		} else {
			this.syncFavoriteButtonsState(gif.url, isNowFavorite);
		}

		return isNowFavorite;
	}

	private syncFavoriteButtonsState(url: string, isFav: boolean): void {
		document.querySelectorAll<HTMLElement>(`.gif-thumbnail-item[data-gif-url="${CSS.escape ? CSS.escape(url) : url}"]`).forEach((card) => {
			const btn = card.querySelector<HTMLButtonElement>(".btn-gif-fav");
			if (btn) {
				if (isFav) {
					btn.classList.add("is-favorite");
					btn.title = "Remover dos favoritos";
				} else {
					btn.classList.remove("is-favorite");
					btn.title = "Favoritar GIF";
				}
			}
		});

		document.querySelectorAll<HTMLElement>(`[data-msg-gif-url="${CSS.escape ? CSS.escape(url) : url}"]`).forEach((btn) => {
			if (isFav) {
				btn.classList.add("is-favorite");
				btn.title = "Remover dos favoritos";
			} else {
				btn.classList.remove("is-favorite");
				btn.title = "Favoritar GIF";
			}
		});
		this.onRefreshIcons?.();
	}

	private updateFavoritesCountBadge(): void {
		const badge = document.getElementById("gif-favorites-count-badge");
		if (!badge) return;
		const count = this.favoriteGifs.length;
		badge.textContent = String(count);
		if (count > 0) {
			badge.classList.remove("hidden");
		} else {
			badge.classList.add("hidden");
		}
	}

	/* ══════════════════════════════════════════════════════════
	   INICIALIZAÇÃO DE ELEMENTOS & EVENTOS DO CHAT
	   ══════════════════════════════════════════════════════════ */

	private initElements(): void {
		const form = document.getElementById("form-chat") as HTMLFormElement | null;
		const input = document.getElementById("input-chat-message") as HTMLInputElement | null;
		const btnToggleGif = document.getElementById("btn-toggle-gif-picker");
		const btnCloseGif = document.getElementById("btn-close-gif-popover");
		const gifSearchInput = document.getElementById("chat-gif-search-input") as HTMLInputElement | null;
		const btnClearChat = document.getElementById("btn-clear-chat-view");

		const tabTrending = document.getElementById("tab-gif-trending");
		const tabFavorites = document.getElementById("tab-gif-favorites");
		const charCounter = document.getElementById("chat-char-counter");

		const syncCharCounter = () => {
			if (!input || !charCounter) return;
			if (input.value.length > ChatManager.MAX_MESSAGE_LENGTH) {
				input.value = input.value.slice(0, ChatManager.MAX_MESSAGE_LENGTH);
			}
			const len = input.value.length;
			charCounter.textContent = `${len}/${ChatManager.MAX_MESSAGE_LENGTH}`;
			charCounter.classList.toggle("hidden", len === 0);
			charCounter.classList.toggle("near-limit", len >= ChatManager.MAX_MESSAGE_LENGTH - 50 && len < ChatManager.MAX_MESSAGE_LENGTH);
			charCounter.classList.toggle("at-limit", len >= ChatManager.MAX_MESSAGE_LENGTH);
		};

		input?.addEventListener("input", () => {
			syncCharCounter();
			const hasText = (input.value || "").trim().length > 0;
			if (!hasText) {
				if (this.localStopTypingTimer) {
					clearTimeout(this.localStopTypingTimer);
					this.localStopTypingTimer = null;
				}
				this.emitLocalTyping(false);
				return;
			}
			this.emitLocalTyping(true);
			if (this.localStopTypingTimer) clearTimeout(this.localStopTypingTimer);
			this.localStopTypingTimer = setTimeout(() => {
				this.emitLocalTyping(false);
			}, 3000);
		});

		form?.addEventListener("submit", (e) => {
			e.preventDefault();
			if (!input) return;
			const text = input.value.trim().slice(0, ChatManager.MAX_MESSAGE_LENGTH);
			if (!text) return;
			this.sendMessage(text);
			input.value = "";
			syncCharCounter();
		});

		
		// Fecha o popover de GIFs ao clicar em qualquer lugar fora dele
		document.addEventListener("mousedown", (e) => {
			const popover = document.getElementById("chat-gif-popover");
			const btnToggle = document.getElementById("btn-toggle-gif-picker");
			if (!popover || popover.classList.contains("hidden")) return;
			const target = e.target as Node;
			if (!popover.contains(target) && !btnToggle?.contains(target)) {
				this.closeGifPopover();
			}
		});

		btnToggleGif?.addEventListener("click", () => {
			if (btnToggleGif.classList.contains("feature-beta-locked")) return;
			this.toggleGifPopover();
		});

		btnCloseGif?.addEventListener("click", () => {
			this.closeGifPopover();
		});

		btnClearChat?.addEventListener("click", () => {
			this.messages = [];
			this.renderMessages();
		});

		tabTrending?.addEventListener("click", () => {
			this.switchGifTab("trending");
		});

		tabFavorites?.addEventListener("click", () => {
			this.switchGifTab("favorites");
		});

		gifSearchInput?.addEventListener("input", () => {
			if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
			this.searchDebounceTimer = setTimeout(() => {
				const q = gifSearchInput.value.trim();
				if (this.activeGifTab === "favorites") {
					// Filtra favoritos locais
					if (q) {
						const filtered = this.favoriteGifs.filter((g) =>
							(g.title || "").toLowerCase().includes(q.toLowerCase())
						);
						this.renderGifGrid(filtered, true);
					} else {
						this.renderFavoritesGifs();
					}
				} else {
					if (q.length >= 2) {
						this.searchGifs(q);
					} else if (!q) {
						this.loadTrendingGifs();
					}
				}
			}, 400); // Atraso de 400ms para economizar requisições na API de GIFs
		});
	}

	private switchGifTab(tab: "trending" | "favorites"): void {
		this.activeGifTab = tab;
		const tabTrending = document.getElementById("tab-gif-trending");
		const tabFavorites = document.getElementById("tab-gif-favorites");
		const gifSearchInput = document.getElementById("chat-gif-search-input") as HTMLInputElement | null;

		if (tab === "trending") {
			tabTrending?.classList.add("active");
			tabFavorites?.classList.remove("active");
			if (gifSearchInput) {
				gifSearchInput.placeholder = "Buscar GIFs...";
			}
			const q = gifSearchInput?.value.trim();
			if (q) {
				this.searchGifs(q);
			} else {
				this.loadTrendingGifs();
			}
		} else {
			tabTrending?.classList.remove("active");
			tabFavorites?.classList.add("active");
			if (gifSearchInput) {
				gifSearchInput.placeholder = "Filtrar favoritos...";
				gifSearchInput.value = "";
			}
			this.renderFavoritesGifs();
		}
		this.onRefreshIcons?.();
	}

	private toggleGifPopover(): void {
		const popover = document.getElementById("chat-gif-popover");
		if (!popover) return;
		if (popover.classList.contains("hidden")) {
			popover.classList.remove("hidden");
			this.updateFavoritesCountBadge();

			if (this.activeGifTab === "favorites") {
				this.renderFavoritesGifs();
			} else {
				this.loadTrendingGifs();
				const searchInput = document.getElementById("chat-gif-search-input") as HTMLInputElement | null;
				searchInput?.focus();
			}
		} else {
			popover.classList.add("hidden");
		}
		this.onRefreshIcons?.();
	}

	private closeGifPopover(): void {
		const popover = document.getElementById("chat-gif-popover");
		popover?.classList.add("hidden");
	}

	private renderFavoritesGifs(): void {
		const grid = document.getElementById("chat-gif-grid");
		if (!grid) return;

		if (this.favoriteGifs.length === 0) {
			grid.innerHTML = `
				<div class="gif-empty-favorites">
					<i data-lucide="star" class="gif-empty-icon"></i>
					<span class="gif-empty-title">Nenhum GIF favorito</span>
					<span class="gif-empty-desc">Passe o mouse sobre qualquer GIF e clique na estrela ⭐ para salvá-lo aqui.</span>
				</div>`;
			this.onRefreshIcons?.();
			return;
		}

		this.renderGifGrid(this.favoriteGifs, true);
	}

	private async loadTrendingGifs(): Promise<void> {
		if (this.cachedTrending && this.cachedTrending.length > 0) {
			this.renderGifGrid(this.cachedTrending, false);
			return;
		}
		const grid = document.getElementById("chat-gif-grid");
		if (!grid) return;
		grid.innerHTML = `
			<div class="loading-spinner">
				<i data-lucide="loader-2" class="spin"></i>
				<span>Carregando GIFs em alta...</span>
			</div>`;
		this.onRefreshIcons?.();

		try {
			const res = await window.api?.apiRequest({
				endpoint: "/api/gifs/trending",
				method: "GET",
				token: getToken() || "",
			});

			if (res?.ok && Array.isArray((res.data as any)?.gifs)) {
				this.cachedTrending = (res.data as any).gifs;
				this.renderGifGrid(this.cachedTrending!, false);
			} else {
				grid.innerHTML = `<p class="gif-empty">Não foi possível carregar os GIFs.</p>`;
			}
		} catch {
			grid.innerHTML = `<p class="gif-empty">Erro ao carregar GIFs.</p>`;
		}
	}

	private async searchGifs(query: string): Promise<void> {
		const norm = query.toLowerCase().trim();
		if (this.cachedSearches.has(norm)) {
			this.renderGifGrid(this.cachedSearches.get(norm)!, false);
			return;
		}
		const grid = document.getElementById("chat-gif-grid");
		if (!grid) return;
		grid.innerHTML = `
			<div class="loading-spinner">
				<i data-lucide="loader-2" class="spin"></i>
				<span>Buscando "${this.escapeHtml(query)}"...</span>
			</div>`;
		this.onRefreshIcons?.();

		try {
			const res = await window.api?.apiRequest({
				endpoint: `/api/gifs/search?q=${encodeURIComponent(query)}`,
				method: "GET",
				token: getToken() || "",
			});

			if (res?.ok && Array.isArray((res.data as any)?.gifs)) {
				const gifs = (res.data as any).gifs;
				this.cachedSearches.set(norm, gifs);
				this.renderGifGrid(gifs, false);
			} else {
				grid.innerHTML = `<p class="gif-empty">Nenhum GIF encontrado.</p>`;
			}
		} catch {
			grid.innerHTML = `<p class="gif-empty">Erro ao buscar GIFs.</p>`;
		}
	}

	private renderGifGrid(
		gifs: Array<{ id: string; title: string; url: string; previewUrl: string }>,
		isFavoritesView = false
	): void {
		const grid = document.getElementById("chat-gif-grid");
		if (!grid) return;

		if (gifs.length === 0) {
			if (isFavoritesView) {
				grid.innerHTML = `
					<div class="gif-empty-favorites">
						<i data-lucide="star" class="gif-empty-icon"></i>
						<span class="gif-empty-title">Nenhum GIF favorito</span>
						<span class="gif-empty-desc">Passe o mouse sobre qualquer GIF e clique na estrela ⭐ para salvá-lo aqui.</span>
					</div>`;
			} else {
				grid.innerHTML = `<p class="gif-empty">Nenhum GIF encontrado.</p>`;
			}
			this.onRefreshIcons?.();
			return;
		}

		grid.innerHTML = gifs
			.map((g) => {
				const isFav = this.isGifFavorite(g.url);
				return `
			<div class="gif-thumbnail-item" data-gif-url="${this.escapeHtml(g.url)}" title="${this.escapeHtml(g.title)}">
				<img src="${this.escapeHtml(g.previewUrl || g.url)}" alt="${this.escapeHtml(g.title)}" loading="lazy" />
				<button type="button" class="btn-gif-fav ${isFav ? "is-favorite" : ""}" title="${isFav ? "Remover dos favoritos" : "Favoritar GIF"}">
					<i data-lucide="star"></i>
				</button>
			</div>`;
			})
			.join("");

		this.onRefreshIcons?.();

		grid.querySelectorAll<HTMLElement>(".gif-thumbnail-item").forEach((item, index) => {
			const gifData = gifs[index];

			// Clique no botão de estrela para favoritar/desfavoritar
			const favBtn = item.querySelector<HTMLButtonElement>(".btn-gif-fav");
			favBtn?.addEventListener("click", (e) => {
				e.stopPropagation();
				this.toggleFavoriteGif(gifData);
			});

			// Clique no thumbnail para enviar o GIF no chat
			item.addEventListener("click", () => {
				const url = item.dataset.gifUrl;
				if (url) {
					this.sendMessage("", url);
					this.closeGifPopover();
				}
			});
		});
	}

	private renderMessages(): void {
		const list = document.getElementById("chat-messages-list");
		if (!list) return;

		if (this.messages.length === 0) {
			list.innerHTML = `
				<div class="chat-empty-state" id="chat-empty-state">
					<i data-lucide="sparkles" class="chat-empty-icon"></i>
					<span class="chat-empty-title">Nenhuma mensagem ainda</span>
					<span class="chat-empty-desc">Envie uma mensagem ou GIF. O histórico é efêmero e não fica salvo no banco de dados.</span>
				</div>`;
			this.onRefreshIcons?.();
			return;
		}

		list.innerHTML = "";
		for (const msg of this.messages) {
			this.appendOrGroupMessage(list, msg);
		}
		this.onRefreshIcons?.();
		this.scrollToBottom();
	}

	private appendMessageElement(msg: ChatMessage): void {
		const list = document.getElementById("chat-messages-list");
		if (!list) return;

		const empty = document.getElementById("chat-empty-state");
		if (empty) empty.remove();

		this.appendOrGroupMessage(list, msg);
		this.onRefreshIcons?.();
	}

	private getSenderKey(msg: ChatMessage): string {
		return msg.sender.id || msg.sender.username || "unknown";
	}

	private getMinuteBucket(timestamp: number): string {
		return String(Math.floor((Number.isFinite(timestamp) ? timestamp : Date.now()) / 60000));
	}

	private appendOrGroupMessage(list: HTMLElement, msg: ChatMessage): void {
		const senderKey = this.getSenderKey(msg);
		const minuteBucket = this.getMinuteBucket(msg.timestamp);
		const lastRow = list.lastElementChild as HTMLElement | null;

		if (
			lastRow &&
			lastRow.classList.contains("chat-message-row") &&
			lastRow.dataset.senderKey === senderKey &&
			lastRow.dataset.minuteBucket === minuteBucket
		) {
			const contentEl = lastRow.querySelector<HTMLElement>(".chat-msg-content");
			if (contentEl) {
				for (const node of this.createContentNodes(msg)) {
					contentEl.appendChild(node);
				}
				return;
			}
		}

		list.appendChild(this.createMessageNode(msg));
	}

	private extractCandidateImageUrls(text: string): string[] {
		if (!text) return [];
		const matches = text.match(/https:\/\/[^\s<>"']+/gi);
		if (!matches) return [];
		const urls: string[] = [];
		for (const raw of matches) {
			const clean = raw.replace(/[.,;!?)]+$/, "");
			if (clean.length > 900 || urls.includes(clean)) continue;
			try {
				const parsed = new URL(clean);
				if (parsed.protocol !== "https:") continue;
				const pathLower = parsed.pathname.toLowerCase();
				const formatParam = (parsed.searchParams.get("format") || "").toLowerCase();
				const hasSafeImageExt = /\.(png|jpe?g|gif|webp|avif)$/i.test(pathLower);
				const hasSafeFormatParam = /^(png|jpe?g|gif|webp|avif)$/i.test(formatParam);
				if (hasSafeImageExt || hasSafeFormatParam) {
					urls.push(clean);
					if (urls.length >= 2) break;
				}
			} catch {
				// ignore malformed URL
			}
		}
		return urls;
	}

	private async verifySafeImage(url: string): Promise<boolean> {
		if (this.safeImageCache.has(url)) {
			return this.safeImageCache.get(url)!;
		}
		try {
			if (window.api?.probeSafeImage) {
				const res = await window.api.probeSafeImage(url);
				const ok = Boolean(res?.safe);
				this.safeImageCache.set(url, ok);
				return ok;
			}
		} catch {
			this.safeImageCache.set(url, false);
			return false;
		}
		return false;
	}

	private createContentNodes(msg: ChatMessage): HTMLElement[] {
		const isMe = Boolean(
			this.currentUser &&
				(this.currentUser.id === msg.sender.id || this.currentUser.username === msg.sender.username),
		);
		const entry = document.createElement("div");
		entry.className = "chat-msg-entry";
		entry.dataset.messageId = msg.id;

		if (msg.replyTo) {
			const quote = document.createElement("div");
			quote.className = "chat-reply-quote";
			const preview = msg.replyTo.content || (msg.replyTo.gifUrl ? "[GIF]" : "");
			quote.innerHTML = `<span class="chat-reply-quote-author">@${this.escapeHtml(msg.replyTo.senderName)}</span> <span class="chat-reply-quote-text">${this.escapeHtml(preview)}</span>`;
			entry.appendChild(quote);
		}

		let textEl: HTMLDivElement | null = null;
		if (msg.content) {
			textEl = document.createElement("div");
			textEl.className = "chat-bubble-text";
			textEl.textContent = msg.content;
			if (msg.editedAt) {
				const editedSpan = document.createElement("span");
				editedSpan.className = "chat-msg-edited";
				editedSpan.textContent = " (editado)";
				textEl.appendChild(editedSpan);
			}
			entry.appendChild(textEl);

			const imageUrls = this.extractCandidateImageUrls(msg.content);
			if (imageUrls.length > 0) {
				const imagesContainer = document.createElement("div");
				imagesContainer.className = "chat-msg-content";
				entry.appendChild(imagesContainer);

				const isSingleUrlOnly = imageUrls.length === 1 && msg.content.trim() === imageUrls[0];
				for (const imgUrl of imageUrls) {
					void this.verifySafeImage(imgUrl).then((safe) => {
						if (!safe || !imagesContainer.isConnected) return;
						const imgWrap = document.createElement("div");
						imgWrap.className = "chat-bubble-image";
						const img = document.createElement("img");
						img.src = imgUrl;
						img.alt = "Imagem";
						img.loading = "lazy";
						img.decoding = "async";
						img.referrerPolicy = "no-referrer";
						img.addEventListener("load", () => {
							if (
								img.naturalWidth <= 0 ||
								img.naturalHeight <= 0 ||
								img.naturalWidth > 4096 ||
								img.naturalHeight > 4096 ||
								img.naturalWidth * img.naturalHeight > 4096 * 3072
							) {
								imgWrap.remove();
								return;
							}
							if (isSingleUrlOnly && textEl) {
								textEl.classList.add("hidden");
							}
							this.scrollToBottom();
						});
						img.addEventListener("error", () => {
							imgWrap.remove();
							if (isSingleUrlOnly && textEl) {
								textEl.classList.remove("hidden");
							}
						});
						imgWrap.appendChild(img);
						imagesContainer.appendChild(imgWrap);
					});
				}
			}
		}
		if (msg.gifUrl) {
			const isFav = this.isGifFavorite(msg.gifUrl);
			const gifEl = document.createElement("div");
			gifEl.className = "chat-bubble-gif";
			gifEl.innerHTML = `
				<img src="${this.escapeHtml(msg.gifUrl)}" alt="GIF" loading="lazy" />
				<button type="button" class="btn-msg-fav-gif ${isFav ? "is-favorite" : ""}" data-msg-gif-url="${this.escapeHtml(msg.gifUrl)}" title="${isFav ? "Remover dos favoritos" : "Favoritar GIF"}">
					<i data-lucide="star"></i>
				</button>`;
			const msgFavBtn = gifEl.querySelector<HTMLButtonElement>(".btn-msg-fav-gif");
			msgFavBtn?.addEventListener("click", (e) => {
				e.stopPropagation();
				this.toggleFavoriteGif({
					url: msg.gifUrl!,
					previewUrl: msg.gifUrl!,
					title: "GIF do Chat",
				});
			});
			entry.appendChild(gifEl);
		}

		entry.addEventListener("dblclick", (e) => {
			if ((e.target as HTMLElement).closest("button, input, textarea")) return;
			if (isMe) {
				if (msg.content) this.startInlineEdit(msg, entry);
			} else {
				this.startReply(msg);
			}
		});

		entry.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const imgEl = (e.target as HTMLElement)
				.closest(".chat-bubble-image, .chat-bubble-gif")
				?.querySelector("img");
			const imageUrl = imgEl?.getAttribute("src") || msg.gifUrl || undefined;
			this.openContextMenu(e, msg, entry, imageUrl);
		});

		return [entry];
	}

	private createMessageNode(msg: ChatMessage): HTMLElement {
		const isMe = this.currentUser && (this.currentUser.id === msg.sender.id || this.currentUser.username === msg.sender.username);
		const wrapper = document.createElement("div");
		wrapper.className = `chat-message-row ${isMe ? "is-me" : "is-other"}`;
		wrapper.dataset.messageId = msg.id;
		wrapper.dataset.senderKey = this.getSenderKey(msg);
		wrapper.dataset.minuteBucket = this.getMinuteBucket(msg.timestamp);

		const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		const displayName = msg.sender.nickname || msg.sender.username || "Usuário";

		let avatarHtml = `<span class="chat-avatar-placeholder">${(displayName[0] || "U").toUpperCase()}</span>`;
		if (msg.sender.avatar) {
			avatarHtml = `<img src="${this.escapeHtml(msg.sender.avatar)}" alt="${this.escapeHtml(displayName)}" class="chat-avatar-img" />`;
		}

		wrapper.innerHTML = `
			<div class="chat-msg-avatar" title="${this.escapeHtml(displayName)}">
				${avatarHtml}
			</div>
			<div class="chat-msg-body">
				<div class="chat-msg-header">
					<span class="chat-msg-sender">${this.escapeHtml(displayName)}</span>
					<span class="chat-msg-time">${time}</span>
				</div>
				<div class="chat-msg-content"></div>
			</div>
		`;

		const contentContainer = wrapper.querySelector<HTMLElement>(".chat-msg-content");
		if (contentContainer) {
			for (const node of this.createContentNodes(msg)) {
				contentContainer.appendChild(node);
			}
		}

		const avatarEl = wrapper.querySelector<HTMLElement>(".chat-msg-avatar");
		const senderEl = wrapper.querySelector<HTMLElement>(".chat-msg-sender");
		const openProfile = (e: MouseEvent) => {
			e.stopPropagation();
			this.onOpenUserProfile?.(msg.sender, (avatarEl || senderEl || wrapper) as HTMLElement);
		};
		avatarEl?.addEventListener("click", openProfile);
		senderEl?.addEventListener("click", openProfile);

		return wrapper;
	}

	private startReply(msg: ChatMessage): void {
		this.replyingTo = msg;
		this.closeContextMenu();
		this.renderReplyBar();
		const input = document.getElementById("chat-input") as HTMLInputElement | null;
		input?.focus();
	}

	private renderReplyBar(): void {
		let bar = document.getElementById("chat-reply-bar");
		const inputBar = document.querySelector<HTMLElement>(".chat-input-bar");
		if (!this.replyingTo) {
			bar?.remove();
			return;
		}
		if (!bar && inputBar?.parentElement) {
			bar = document.createElement("div");
			bar.id = "chat-reply-bar";
			bar.className = "chat-reply-bar";
			inputBar.parentElement.insertBefore(bar, inputBar);
		}
		if (!bar) return;
		const author = this.replyingTo.sender.nickname || this.replyingTo.sender.username || "Usuário";
		const preview = this.replyingTo.content || (this.replyingTo.gifUrl ? "[GIF]" : "");
		bar.innerHTML = `
			<div class="chat-reply-bar-text">
				<span>Respondendo a <strong>${this.escapeHtml(author)}</strong>${preview ? `: ${this.escapeHtml(preview)}` : ""}</span>
			</div>
			<button type="button" class="chat-reply-bar-close" title="Cancelar resposta">
				<i data-lucide="x"></i>
			</button>`;
		bar.querySelector(".chat-reply-bar-close")?.addEventListener("click", () => {
			this.replyingTo = null;
			this.renderReplyBar();
		});
		this.onRefreshIcons?.();
	}

	private startInlineEdit(msg: ChatMessage, entryEl: HTMLElement): void {
		this.closeContextMenu();
		if (!msg.content || entryEl.querySelector(".chat-inline-edit-wrap")) return;
		const textEl = entryEl.querySelector<HTMLElement>(".chat-bubble-text");
		if (!textEl) return;

		textEl.classList.add("hidden");
		const wrap = document.createElement("div");
		wrap.className = "chat-inline-edit-wrap";
		const input = document.createElement("input");
		input.type = "text";
		input.className = "chat-inline-edit-input";
		input.maxLength = ChatManager.MAX_MESSAGE_LENGTH;
		input.value = msg.content;

		const hint = document.createElement("div");
		hint.className = "chat-inline-edit-hint";
		hint.innerHTML = `<button type="button" class="chat-inline-edit-cancel">Esc cancelar</button><button type="button" class="chat-inline-edit-save">Enter salvar</button>`;

		const cancel = () => {
			wrap.remove();
			textEl.classList.remove("hidden");
		};
		const save = () => {
			const trimmed = input.value.trim().slice(0, ChatManager.MAX_MESSAGE_LENGTH);
			wrap.remove();
			textEl.classList.remove("hidden");
			if (!trimmed || trimmed === msg.content) return;
			this.commitEdit(msg, trimmed);
		};

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				save();
			} else if (e.key === "Escape") {
				e.preventDefault();
				cancel();
			}
		});
		hint.querySelector(".chat-inline-edit-cancel")?.addEventListener("click", cancel);
		hint.querySelector(".chat-inline-edit-save")?.addEventListener("click", save);

		wrap.appendChild(input);
		wrap.appendChild(hint);
		textEl.after(wrap);
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
	}

	private commitEdit(msg: ChatMessage, newContent: string): void {
		if (!this.currentRoomId) return;
		const editedAt = Date.now();
		msg.content = newContent;
		msg.editedAt = editedAt;
		this.renderMessages();

		const token = getToken();
		if (token && window.api?.apiRequest) {
			window.api
				.apiRequest({
					endpoint: "/api/signal/chat",
					method: "PATCH",
					body: { roomId: this.currentRoomId, messageId: msg.id, content: newContent },
					token,
				})
				.catch((err) => console.warn("[Chat] Erro ao editar mensagem:", err));
		}
	}

	private deleteMessage(msg: ChatMessage): void {
		this.closeContextMenu();
		if (!this.currentRoomId) return;
		this.messages = this.messages.filter((m) => m.id !== msg.id);
		this.renderMessages();

		const token = getToken();
		if (token && window.api?.apiRequest) {
			window.api
				.apiRequest({
					endpoint: "/api/signal/chat",
					method: "DELETE",
					body: { roomId: this.currentRoomId, messageId: msg.id },
					token,
				})
				.catch((err) => console.warn("[Chat] Erro ao apagar mensagem:", err));
		}
	}

	private openContextMenu(e: MouseEvent, msg: ChatMessage, entryEl: HTMLElement, imageUrl?: string): void {
		this.closeContextMenu();
		const isMe = Boolean(
			this.currentUser &&
				(this.currentUser.id === msg.sender.id || this.currentUser.username === msg.sender.username),
		);

		const menu = document.createElement("div");
		menu.id = "chat-context-menu";
		menu.className = "chat-context-menu";
		const x = Math.min(e.clientX, window.innerWidth - 210);
		const y = Math.min(e.clientY, window.innerHeight - 210);
		menu.style.left = `${x}px`;
		menu.style.top = `${y}px`;
		menu.addEventListener("click", (ev) => ev.stopPropagation());

		const addItem = (icon: string, label: string, onClick: () => void, danger = false) => {
			const btn = document.createElement("button");
			btn.type = "button";
			btn.className = `chat-context-item ${danger ? "is-danger" : ""}`;
			btn.innerHTML = `<i data-lucide="${icon}"></i><span>${this.escapeHtml(label)}</span>`;
			btn.addEventListener("click", () => {
				this.closeContextMenu();
				onClick();
			});
			menu.appendChild(btn);
		};

		if (imageUrl) {
			addItem("copy", "Copiar link da imagem", () => void this.copyImageLink(imageUrl));
			addItem("download", "Baixar imagem", () => void this.downloadImage(imageUrl));
			const sep = document.createElement("div");
			sep.className = "chat-context-sep";
			menu.appendChild(sep);
		}

		addItem("reply", "Mencionar / Responder", () => this.startReply(msg));

		if (isMe && msg.content) {
			addItem("pencil", "Editar mensagem", () => this.startInlineEdit(msg, entryEl));
		}
		if (isMe) {
			addItem("trash-2", "Apagar mensagem", () => this.deleteMessage(msg), true);
		}

		document.body.appendChild(menu);
		this.onRefreshIcons?.();
	}

	private closeContextMenu(): void {
		document.getElementById("chat-context-menu")?.remove();
	}

	private async copyImageLink(url: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(url);
		} catch {
			// ignore clipboard error
		}
	}

	private async downloadImage(url: string): Promise<void> {
		try {
			const res = await fetch(url);
			const blob = await res.blob();
			const ext = (blob.type.split("/")[1] || "png").split(";")[0];
			const objectUrl = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = objectUrl;
			a.download = `shiro-imagem-${Date.now()}.${ext}`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
		} catch {
			window.open(url, "_blank", "noopener,noreferrer");
		}
	}

	private scrollToBottom(): void {
		const list = document.getElementById("chat-messages-list");
		if (list) {
			requestAnimationFrame(() => {
				list.scrollTop = list.scrollHeight;
			});
		}
	}

	private escapeHtml(str: string): string {
		const div = document.createElement("div");
		div.innerText = str || "";
		return div.innerHTML;
	}
}
