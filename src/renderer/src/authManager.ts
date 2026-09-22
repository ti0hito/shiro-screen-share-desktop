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

export interface ShiroUser {
	id: string;
	username: string;
	createdAt: string;
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

/** Busca lista de usuários online */
export async function getOnlineUsers(): Promise<ShiroUser[]> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return [];

	const result = await window.api.apiRequest({
		endpoint: "/api/users/online",
		method: "GET",
		token,
	});

	if (!result.ok) return [];
	return (result.data as any).users ?? [];
}

/** Envia heartbeat para manter usuário como "online" (chama a cada 60s) */
export async function sendHeartbeat(): Promise<void> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return;

	await window.api.apiRequest({
		endpoint: "/api/users/heartbeat",
		method: "POST",
		token,
	});
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
	membersCount: number;
	activeStreams: ActiveStreamInfo[];
	createdAt?: string;
}

export async function getRooms(): Promise<RoomInfo[]> {
	const token = getToken();
	if (!token || !window.api?.apiRequest) return [];

	const result = await window.api.apiRequest({
		endpoint: "/api/rooms/list",
		method: "GET",
		token,
	});

	if (!result.ok) return [];
	return (result.data as any).rooms ?? [];
}

export async function createRoom(data: {
	name: string;
	roomId?: string;
	password?: string;
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

