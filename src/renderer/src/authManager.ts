/**
 * authManager.ts
 * Gerencia autenticação do usuário com a API Vercel via IPC seguro.
 * JWT fica em sessionStorage (limpo ao fechar o app).
 * A API Key NUNCA passa por aqui — fica no processo main.
 */

const SESSION_KEY = "shiro_jwt";
const USER_KEY = "shiro_user";

const REMEMBER_KEY = "shiro_remember_me";
const REMEMBER_JWT = "shiro_remember_jwt";
const REMEMBER_USER = "shiro_remember_user";
const REMEMBER_TIME = "shiro_remember_time";
const REMEMBER_USERNAME = "shiro_remember_username";
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000; // 14 dias

/** Insígnias de perfil (definidas e concedidas pela API — ver lib/badges.ts no servidor) */
export type BadgeId = "developer" | "early-user" | "beta-tester" | "stream-24-7" | "builder" | "neighbor";

/** Última contagem das estatísticas das insígnias (não é em tempo real) */
export interface BadgeStats {
	streamSeconds: number;
	roomsCreated: number;
	friendsCount: number;
}

export interface ShiroUser {
	id: string;
	username: string;
	nickname?: string;
	avatar?: string;
	banner?: string;
	createdAt: string;
	badges?: BadgeId[];
	badgeStats?: BadgeStats;
}

export interface AuthResult {
	ok: boolean;
	error?: string;
	user?: ShiroUser;
}

export interface SavedSessionResult {
	autoLogin: boolean;
	username?: string;
	expired?: boolean;
}

/** Retorna o token JWT salvo na sessão, ou null */
export function getToken(): string | null {
	return sessionStorage.getItem(SESSION_KEY);
}

/** Retorna o usuário logado, ou null */
export function getUser(): ShiroUser | null {
	const raw = sessionStorage.getItem(USER_KEY);
	if (!raw) return null;
	try {
		return JSON.parse(raw) as ShiroUser;
	} catch {
		return null;
	}
}

/** Atualiza a sessão local com novos dados do usuário */
export function updateUserSession(user: ShiroUser): void {
	sessionStorage.setItem(USER_KEY, JSON.stringify(user));
	const rememberMe = localStorage.getItem(REMEMBER_KEY) === "true";
	if (rememberMe) {
		localStorage.setItem(REMEMBER_USER, JSON.stringify(user));
		if (user.username) {
			localStorage.setItem(REMEMBER_USERNAME, user.username);
		}
	}
}

/** Remove sessão e redireciona para login */
export function logout(): void {
	sessionStorage.removeItem(SESSION_KEY);
	sessionStorage.removeItem(USER_KEY);
	clearRememberSession(false);
}

/** Salva ou limpa os dados de 'Lembrar Login' */
export function saveRememberSession(token: string, user: ShiroUser, rememberMe: boolean): void {
	if (rememberMe) {
		localStorage.setItem(REMEMBER_KEY, "true");
		localStorage.setItem(REMEMBER_JWT, token);
		localStorage.setItem(REMEMBER_USER, JSON.stringify(user));
		localStorage.setItem(REMEMBER_TIME, Date.now().toString());
		localStorage.setItem(REMEMBER_USERNAME, user.username);
	} else {
		clearRememberSession(false);
	}
}

/** Limpa dados de 'Lembrar Login' do localStorage */
export function clearRememberSession(clearUsername = true): void {
	localStorage.removeItem(REMEMBER_KEY);
	localStorage.removeItem(REMEMBER_JWT);
	localStorage.removeItem(REMEMBER_USER);
	localStorage.removeItem(REMEMBER_TIME);
	if (clearUsername) {
		localStorage.removeItem(REMEMBER_USERNAME);
	}
}

/** Verifica se há uma sessão salva no localStorage e valida o tempo de 2 semanas (14 dias) */
export function checkSavedSession(): SavedSessionResult {
	const rememberMe = localStorage.getItem(REMEMBER_KEY) === "true";
	const savedTimeStr = localStorage.getItem(REMEMBER_TIME);
	const savedUsername = localStorage.getItem(REMEMBER_USERNAME);
	const savedJwt = localStorage.getItem(REMEMBER_JWT);
	const savedUserRaw = localStorage.getItem(REMEMBER_USER);

	if (!rememberMe || !savedJwt || !savedUserRaw || !savedTimeStr) {
		return {
			autoLogin: false,
			username: savedUsername ?? undefined,
		};
	}

	const loginTime = parseInt(savedTimeStr, 10);
	const isExpired = Date.now() - loginTime >= FOURTEEN_DAYS_MS;

	if (isExpired) {
		// Limpa os tokens de auto-login pois passou de 2 semanas, mas mantém o username preenchido
		clearRememberSession(false);
		return {
			autoLogin: false,
			username: savedUsername ?? undefined,
			expired: true,
		};
	}

	// Sessão dentro de 14 dias: injeta no sessionStorage para logar direto
	sessionStorage.setItem(SESSION_KEY, savedJwt);
	sessionStorage.setItem(USER_KEY, savedUserRaw);

	return {
		autoLogin: true,
		username: savedUsername ?? undefined,
	};
}

/** Verifica se há sessão válida */
export function isAuthenticated(): boolean {
	return !!getToken();
}

/** Registra um novo usuário */
export async function register(username: string, password: string): Promise<AuthResult> {
	if (!window.api?.apiRequest) {
		return { ok: false, error: "API bridge não disponível." };
	}

	const result = await window.api.apiRequest({
		endpoint: "/api/auth/register",
		method: "POST",
		body: { username, password },
	});

	if (!result.ok) {
		const data = result.data as any;
		return { ok: false, error: data?.error ?? `Erro ${result.status}` };
	}

	const data = result.data as any;
	return { ok: true, user: data.user };
}

/** Faz login e salva JWT + dados do usuário na sessão */
export async function login(username: string, password: string): Promise<AuthResult> {
	if (!window.api?.apiRequest) {
		return { ok: false, error: "API bridge não disponível." };
	}

	const result = await window.api.apiRequest({
		endpoint: "/api/auth/login",
		method: "POST",
		body: { username, password },
	});

	if (!result.ok) {
		const data = result.data as any;
		return { ok: false, error: data?.error ?? `Erro ${result.status}` };
	}

	const data = result.data as any;

	if (!data.token || !data.user) {
		return { ok: false, error: "Resposta inválida da API." };
	}

	sessionStorage.setItem(SESSION_KEY, data.token);
	sessionStorage.setItem(USER_KEY, JSON.stringify(data.user));

	return { ok: true, user: data.user };
}

/** Busca lista de usuários online. Retorna null se a requisição falhar. */
export async function getOnlineUsers(): Promise<ShiroUser[] | null> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return null;

	const result = await window.api.apiRequest({
		endpoint: "/api/users/online",
		method: "GET",
		token,
	});

	if (!result.ok) return null;
	return (result.data as any).users ?? [];
}

/** Envia heartbeat para manter usuário como "online" (chama a cada 60s) */
export async function sendHeartbeat(): Promise<boolean> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return false;

	const result = await window.api.apiRequest({
		endpoint: "/api/users/heartbeat",
		method: "POST",
		token,
	});
	return result.ok;
}

// ══════════════════════════════════════════
//  PROFILE API (Apelido & Foto de Perfil)
// ══════════════════════════════════════════

export interface ProfileResponse {
	ok: boolean;
	error?: string;
	user?: ShiroUser;
	remainingNicknameChanges?: number;
	maxNicknameChangesPerHour?: number;
}

/** Obtém os dados de perfil e limites de troca */
export async function getProfile(): Promise<ProfileResponse> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, error: "Não autenticado." };

	const result = await window.api.apiRequest({
		endpoint: "/api/users/profile",
		method: "GET",
		token,
	});

	if (!result.ok) {
		const data = result.data as any;
		return { ok: false, error: data?.error ?? "Erro ao carregar perfil." };
	}

	const data = result.data as any;
	if (data.user) {
		updateUserSession(data.user);
	}
	return {
		ok: true,
		user: data.user,
		remainingNicknameChanges: data.remainingNicknameChanges,
		maxNicknameChangesPerHour: data.maxNicknameChangesPerHour,
	};
}

/** Atualiza apelido e/ou foto/banner de perfil */
export async function updateProfile(body: {
	nickname?: string;
	avatar?: string;
	banner?: string;
}): Promise<ProfileResponse> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, error: "Não autenticado." };

	const result = await window.api.apiRequest({
		endpoint: "/api/users/profile",
		method: "PATCH",
		token,
		body,
	});

	if (!result.ok) {
		const data = result.data as any;
		return { ok: false, error: data?.error ?? `Erro ${result.status}` };
	}

	const data = result.data as any;
	if (data.user) {
		updateUserSession(data.user);
	}
	return {
		ok: true,
		user: data.user,
		remainingNicknameChanges: data.remainingNicknameChanges,
		maxNicknameChangesPerHour: data.maxNicknameChangesPerHour,
	};
}

// ══════════════════════════════════════════
//  ROOMS API
// ══════════════════════════════════════════

export interface ActiveStreamInfo {
	userId: string;
	username: string;
	streamTitle?: string;
	startedAt: string;
}

export interface RoomInfo {
	id: string;
	roomId: string;
	name: string;
	isPrivate: boolean;
	createdBy: string;
	ownerId?: string;
	inviteCode?: string;
	maxMembers?: number;
	membersCount: number;
	members?: string[];
	activeStreams: ActiveStreamInfo[];
	createdAt?: string;
}

export async function getRooms(): Promise<{ ok: boolean; rooms: RoomInfo[] }> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, rooms: [] };

	const result = await window.api.apiRequest({
		endpoint: "/api/rooms/list",
		method: "GET",
		token,
	});

	if (!result.ok) return { ok: false, rooms: [] };
	return { ok: true, rooms: (result.data as any).rooms ?? [] };
}

/**
 * Transmissões ativas de uma sala (consulta leve, feita com frequência enquanto o usuário está na sala).
 * Retorna null se a requisição falhar.
 */
export async function getRoomStreams(roomId: string): Promise<ActiveStreamInfo[] | null> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return null;

	const result = await window.api.apiRequest({
		endpoint: `/api/rooms/streams/${encodeURIComponent(roomId)}`,
		method: "GET",
		token,
	});

	if (!result.ok) return null;
	return (result.data as any).activeStreams ?? [];
}

export async function createRoom(data: {
	name: string;
	roomId?: string;
	password?: string;
	maxMembers?: number;
}): Promise<{ ok: boolean; error?: string; room?: RoomInfo }> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, error: "Não autenticado." };

	const result = await window.api.apiRequest({
		endpoint: "/api/rooms/create",
		method: "POST",
		token,
		body: data,
	});

	if (!result.ok) {
		const resData = result.data as any;
		return { ok: false, error: resData?.error ?? `Erro ${result.status}` };
	}

	return { ok: true, room: (result.data as any).room };
}

export async function joinRoom(
	roomId: string,
	password?: string,
): Promise<{ ok: boolean; error?: string; room?: RoomInfo }> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, error: "Não autenticado." };

	const result = await window.api.apiRequest({
		endpoint: "/api/rooms/join",
		method: "POST",
		token,
		body: { roomId, password },
	});

	if (!result.ok) {
		const resData = result.data as any;
		return { ok: false, error: resData?.error ?? `Erro ${result.status}` };
	}

	return { ok: true, room: (result.data as any).room };
}

export async function joinRoomByInvite(
	inviteCode: string,
): Promise<{ ok: boolean; error?: string; room?: RoomInfo }> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, error: "Não autenticado." };

	const result = await window.api.apiRequest({
		endpoint: "/api/rooms/join-by-invite",
		method: "POST",
		token,
		body: { inviteCode },
	});

	if (!result.ok) {
		const resData = result.data as any;
		return { ok: false, error: resData?.error ?? `Erro ${result.status}` };
	}

	return { ok: true, room: (result.data as any).room };
}

export async function updateRoomSettings(
	roomId: string,
	data: {
		name?: string;
		password?: string | null;
		maxMembers?: number;
		regenerateInviteCode?: boolean;
	},
): Promise<{ ok: boolean; error?: string; room?: RoomInfo }> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, error: "Não autenticado." };

	const result = await window.api.apiRequest({
		endpoint: `/api/rooms/settings/${encodeURIComponent(roomId)}`,
		method: "PATCH",
		token,
		body: data,
	});

	if (!result.ok) {
		const resData = result.data as any;
		return { ok: false, error: resData?.error ?? `Erro ${result.status}` };
	}

	return { ok: true, room: (result.data as any).room };
}

export async function kickUserFromRoom(
	roomId: string,
	targetUsername: string,
	targetUserId?: string,
): Promise<{ ok: boolean; error?: string }> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, error: "Não autenticado." };

	const result = await window.api.apiRequest({
		endpoint: `/api/rooms/kick/${encodeURIComponent(roomId)}`,
		method: "POST",
		token,
		body: { targetUsername, targetUserId },
	});

	if (!result.ok) {
		const resData = result.data as any;
		return { ok: false, error: resData?.error ?? `Erro ${result.status}` };
	}

	return { ok: true };
}

/** Concede ou remove uma insígnia manual (ex.: Beta Tester). Somente desenvolvedores (validado na API). */
export async function setUserBadge(
	targetUserId: string,
	badge: BadgeId,
	grant: boolean,
): Promise<{ ok: boolean; error?: string; badges?: BadgeId[]; badgeStats?: BadgeStats }> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, error: "Não autenticado." };

	const result = await window.api.apiRequest({
		endpoint: "/api/users/badges",
		method: "POST",
		token,
		body: { targetUserId, badge, grant },
	});

	const data = result.data as any;
	if (result.status === 404) {
		// Servidor ainda sem a rota de insígnias (API desatualizada)
		return { ok: false, error: "O servidor ainda não suporta insígnias. Atualize a API e tente novamente." };
	}
	if (!result.ok) return { ok: false, error: data?.error ?? `Erro ${result.status}` };
	return { ok: true, badges: data.badges ?? [], badgeStats: data.badgeStats };
}

export async function leaveRoom(roomId: string): Promise<void> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return;

	await window.api.apiRequest({
		endpoint: "/api/rooms/leave",
		method: "POST",
		token,
		body: { roomId },
	});
}

export async function notifyRoomStream(
	roomId: string,
	action: "start" | "stop",
	streamTitle?: string,
): Promise<void> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return;

	await window.api.apiRequest({
		endpoint: "/api/rooms/stream",
		method: "POST",
		token,
		body: { roomId, action, streamTitle },
	});
}

// ══════════════════════════════════════════
//  FRIENDS & INVITES API
// ══════════════════════════════════════════

export interface FriendInfo {
	id: string;
	username: string;
	nickname?: string;
	avatar?: string;
	banner?: string;
	badges?: BadgeId[];
	badgeStats?: BadgeStats;
	isOnline: boolean;
	lastSeen?: string;
	currentRoom?: { roomId: string; name: string } | null;
}

export interface FriendRequest {
	fromUserId: string;
	fromUsername: string;
	sentAt: string;
}

export interface RoomInvite {
	id: string;
	fromUserId: string;
	fromUsername: string;
	fromNickname?: string;
	fromAvatar?: string;
	roomId: string;
	roomName: string;
	inviteCode: string;
	sentAt: string;
}

export interface FriendsResponse {
	ok: boolean;
	friends: FriendInfo[];
	friendRequests: FriendRequest[];
	roomInvites: RoomInvite[];
}

export async function getFriends(): Promise<FriendsResponse> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) {
		return { ok: false, friends: [], friendRequests: [], roomInvites: [] };
	}

	const result = await window.api.apiRequest({
		endpoint: "/api/friends/list",
		method: "GET",
		token,
	});

	if (!result.ok) {
		return { ok: false, friends: [], friendRequests: [], roomInvites: [] };
	}

	const data = result.data as any;
	return {
		ok: true,
		friends: data.friends ?? [],
		friendRequests: data.friendRequests ?? [],
		roomInvites: data.roomInvites ?? [],
	};
}

export async function sendFriendRequest(target: string): Promise<{ ok: boolean; error?: string; message?: string }> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, error: "Não autenticado." };

	const result = await window.api.apiRequest({
		endpoint: "/api/friends/request",
		method: "POST",
		token,
		body: { target },
	});

	const data = result.data as any;
	if (!result.ok) {
		return { ok: false, error: data?.error ?? `Erro ${result.status}` };
	}

	return { ok: true, message: data?.message };
}

export async function acceptFriendRequest(fromUserId: string): Promise<{ ok: boolean; error?: string }> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, error: "Não autenticado." };

	const result = await window.api.apiRequest({
		endpoint: "/api/friends/accept",
		method: "POST",
		token,
		body: { fromUserId },
	});

	const data = result.data as any;
	if (!result.ok) {
		return { ok: false, error: data?.error ?? `Erro ${result.status}` };
	}

	return { ok: true };
}

export async function rejectFriend(fromUserId: string): Promise<{ ok: boolean; error?: string }> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, error: "Não autenticado." };

	const result = await window.api.apiRequest({
		endpoint: "/api/friends/reject",
		method: "POST",
		token,
		body: { fromUserId },
	});

	const data = result.data as any;
	if (!result.ok) {
		return { ok: false, error: data?.error ?? `Erro ${result.status}` };
	}

	return { ok: true };
}

export async function inviteFriendToRoom(targetUserId: string, roomId: string): Promise<{ ok: boolean; error?: string }> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return { ok: false, error: "Não autenticado." };

	const result = await window.api.apiRequest({
		endpoint: "/api/friends/invite-to-room",
		method: "POST",
		token,
		body: { targetUserId, roomId },
	});

	const data = result.data as any;
	if (!result.ok) {
		return { ok: false, error: data?.error ?? `Erro ${result.status}` };
	}

	return { ok: true };
}

export async function dismissRoomInvite(inviteId: string): Promise<void> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return;

	await window.api.apiRequest({
		endpoint: "/api/friends/dismiss-invite",
		method: "POST",
		token,
		body: { inviteId },
	});
}
