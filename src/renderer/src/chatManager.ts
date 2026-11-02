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

	// Gerenciamento de GIFs & Favoritos
	private activeGifTab: "trending" | "favorites" = "trending";
	private favoriteGifs: FavoriteGif[] = [];

	// Callbacks para sincronizar com app.ts
	public onUnreadCountChanged?: (count: number) => void;
	public onRefreshIcons?: () => void;
	public onBroadcastP2PMessage?: (msg: ChatMessage) => void;

	constructor() {
		this.loadFavoriteGifs();
		this.initElements();
		this.initSseSignalListener();
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

				this.messages.push(msg);
				this.appendMessageElement(msg);

				if (!this.isTabActive) {
					this.unreadCount++;
					this.updateUnreadBadge();
					this.onUnreadCountChanged?.(this.unreadCount);
				}
				this.scrollToBottom();
			} else if (event === "chat:request_history") {
				const req = data as { forUserId: string; roomId: string; instanceId?: string };
				if (!req || !this.sameRoom(req.roomId)) return;
				if (req.instanceId === this.instanceId) return; // meu próprio pedido
				if (this.messages.length === 0) return;
				const token = getToken();
				if (!token || !window.api?.apiRequest) return;
				window.api
					.apiRequest({
						endpoint: "/api/signal/chat/history",
						method: "POST",
						body: {
							roomId: req.roomId,
							action: "deliver",
							targetUserId: req.forUserId,
							messages: this.messages,
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
		this.messages.push(msg);
		this.appendMessageElement(msg);
		if (!this.isTabActive) {
			this.unreadCount++;
			this.updateUnreadBadge();
			this.onUnreadCountChanged?.(this.unreadCount);
		}
		this.scrollToBottom();
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
			if (this.messages.length === 0) this.requestHistory();
		}, 3000);
	}

	public leaveRoom(): void {
		if (this.historyRetryTimer) {
			clearTimeout(this.historyRetryTimer);
			this.historyRetryTimer = null;
		}
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
		const text = (content || "").trim();
		if (!text && !gifUrl) return;
		if (!this.currentRoomId) return;

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
			timestamp: Date.now(),
		};

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

		form?.addEventListener("submit", (e) => {
			e.preventDefault();
			if (!input) return;
			const text = input.value.trim();
			if (!text) return;
			this.sendMessage(text);
			input.value = "";
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
					if (q) {
						this.searchGifs(q);
					} else {
						this.loadTrendingGifs();
					}
				}
			}, 350);
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
				this.renderGifGrid((res.data as any).gifs, false);
			} else {
				grid.innerHTML = `<p class="gif-empty">Não foi possível carregar os GIFs.</p>`;
			}
		} catch {
			grid.innerHTML = `<p class="gif-empty">Erro ao carregar GIFs.</p>`;
		}
	}

	private async searchGifs(query: string): Promise<void> {
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
				this.renderGifGrid((res.data as any).gifs, false);
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
			list.appendChild(this.createMessageNode(msg));
		}
		this.onRefreshIcons?.();
		this.scrollToBottom();
	}

	private appendMessageElement(msg: ChatMessage): void {
		const list = document.getElementById("chat-messages-list");
		if (!list) return;

		const empty = document.getElementById("chat-empty-state");
		if (empty) empty.remove();

		list.appendChild(this.createMessageNode(msg));
		this.onRefreshIcons?.();
	}

	private createMessageNode(msg: ChatMessage): HTMLElement {
		const isMe = this.currentUser && (this.currentUser.id === msg.sender.id || this.currentUser.username === msg.sender.username);
		const wrapper = document.createElement("div");
		wrapper.className = `chat-message-row ${isMe ? "is-me" : "is-other"}`;
		wrapper.dataset.messageId = msg.id;

		const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		const displayName = msg.sender.nickname || msg.sender.username || "Usuário";

		let avatarHtml = `<span class="chat-avatar-placeholder">${(displayName[0] || "U").toUpperCase()}</span>`;
		if (msg.sender.avatar) {
			avatarHtml = `<img src="${this.escapeHtml(msg.sender.avatar)}" alt="${this.escapeHtml(displayName)}" class="chat-avatar-img" />`;
		}

		let contentHtml = "";
		if (msg.content) {
			contentHtml += `<div class="chat-bubble-text">${this.escapeHtml(msg.content)}</div>`;
		}
		if (msg.gifUrl) {
			const isFav = this.isGifFavorite(msg.gifUrl);
			contentHtml += `
				<div class="chat-bubble-gif">
					<img src="${this.escapeHtml(msg.gifUrl)}" alt="GIF" loading="lazy" />
					<button type="button" class="btn-msg-fav-gif ${isFav ? "is-favorite" : ""}" data-msg-gif-url="${this.escapeHtml(msg.gifUrl)}" title="${isFav ? "Remover dos favoritos" : "Favoritar GIF"}">
						<i data-lucide="star"></i>
					</button>
				</div>`;
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
				<div class="chat-msg-content">
					${contentHtml}
				</div>
			</div>
		`;

		// Listener para o botão de favoritar GIF na mensagem do chat
		if (msg.gifUrl) {
			const msgFavBtn = wrapper.querySelector<HTMLButtonElement>(".btn-msg-fav-gif");
			msgFavBtn?.addEventListener("click", (e) => {
				e.stopPropagation();
				this.toggleFavoriteGif({
					url: msg.gifUrl!,
					previewUrl: msg.gifUrl!,
					title: "GIF do Chat",
				});
			});
		}

		return wrapper;
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
