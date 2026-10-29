/**
 * p2pManager.ts
 * Gerencia conexões WebRTC P2P puras entre clientes Shiro.
 * Sinalização (SDP + ICE) via SSE + HTTP POST para a API Vercel.
 *
 * Inclui servidores STUN + TURN (OpenRelay) para garantir conectividade
 * através de NATs simétricos, CGNAT e firewalls de diferentes operadoras.
 */

import { getToken } from "./authManager";

export interface P2PCallbacks {
	onConnected: (peerId: string) => void;
	onDisconnected: (peerId: string) => void;
	onError: (err: string) => void;
	onRemoteStream?: (stream: MediaStream, peerId: string) => void;
	isPeerAllowed?: (peerId: string) => boolean;
	onSystemNotice?: (notice: any) => void;
}

const ICE_SERVERS: RTCIceServer[] = [
	{ urls: "stun:stun.l.google.com:19302" },
	{ urls: "stun:stun1.l.google.com:19302" },
	{ urls: "stun:stun2.l.google.com:19302" },
	{ urls: "stun:stun3.l.google.com:19302" },
	{ urls: "stun:stun4.l.google.com:19302" },
	{ urls: "stun:global.stun.twilio.com:3478" },
	{ urls: "stun:stun.relay.metered.ca:80" },
	{
		urls: "turn:openrelay.metered.ca:80",
		username: "openrelay",
		credential: "openrelay",
	},
	{
		urls: "turn:openrelay.metered.ca:443",
		username: "openrelay",
		credential: "openrelay",
	},
	{
		urls: "turn:openrelay.metered.ca:443?transport=tcp",
		username: "openrelay",
		credential: "openrelay",
	},
];

/**
 * Otimiza o SDP para melhorar a qualidade de áudio (Opus com FEC e estéreo)
 * e limitar o bitrate do vídeo para evitar picos brutos não comprimidos.
 */
function optimizeSdp(sdp: string): string {
	const lines = sdp.split("\r\n");
	const opusPayloads = new Set(
		lines.map((l) => /^a=rtpmap:(\d+) opus\/48000/i.exec(l)?.[1]).filter((p): p is string => !!p),
	);
	const resultLines: string[] = [];
	let inVideo = false;
	for (const line of lines) {
		if (line.startsWith("m=")) inVideo = line.startsWith("m=video");
		if (inVideo && line.startsWith("b=")) continue;
		const fmtp = /^a=fmtp:(\d+) /.exec(line);
		if (fmtp && opusPayloads.has(fmtp[1]) && !line.includes("stereo=1")) {
			resultLines.push(`${line};stereo=1;sprop-stereo=1;maxaveragebitrate=128000;useinbandfec=1;cbr=1`);
			continue;
		}
		resultLines.push(line);
		if (inVideo && line.startsWith("c=")) {
			resultLines.push(`b=AS:${MAX_VIDEO_BITRATE_KBPS}`);
			resultLines.push(`b=TIAS:${MAX_VIDEO_BITRATE_KBPS * 1000}`);
		}
	}

	return resultLines.join("\r\n");
}

/**
 * Configura parâmetros de codificação de vídeo nos senders WebRTC
 */
/** Tempo de tolerância para uma conexão "disconnected" se recuperar antes de ser fechada */
const DISCONNECT_GRACE_MS = 8000;

/** Maior bitrate de vídeo oferecido nos presets (teto anunciado no SDP) */
const MAX_VIDEO_BITRATE_KBPS = 15000;
/** Bitrate padrão enquanto o usuário não escolhe outro */
const DEFAULT_VIDEO_BITRATE_KBPS = 4500;

function configureSenderParameters(pc: RTCPeerConnection, bitrateKbps: number): void {
	try {
		for (const sender of pc.getSenders()) {
			if (sender.track?.kind === "video") {
				const params = sender.getParameters();
				if (params.encodings && params.encodings.length > 0) {
					params.encodings[0].maxBitrate = bitrateKbps * 1000;
					params.encodings[0].networkPriority = "high";
					params.encodings[0].priority = "high";
					params.degradationPreference = "maintain-resolution";
					sender.setParameters(params).catch(() => {});
				}
			}
		}
	} catch {}
}

/**
 * Prioriza codec H.264 acelerado por hardware se disponível
 */
function prioritizeH264(pc: RTCPeerConnection): void {
	try {
		// Não modifica codecs em transceivers de resposta se a descrição remota já foi aplicada
		if (pc.remoteDescription && pc.signalingState !== "stable") return;
		const transceivers = pc.getTransceivers();
		for (const t of transceivers) {
			if (t.sender.track?.kind === "video" || t.receiver.track?.kind === "video") {
				const capabilities = RTCRtpReceiver.getCapabilities("video");
				if (capabilities?.codecs) {
					const h264 = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() === "video/h264");
					const others = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() !== "video/h264");
					t.setCodecPreferences([...h264, ...others]);
				}
			}
		}
	} catch (err) {
		console.warn("[P2P] Erro ao priorizar codec H.264:", err);
	}
}

export class P2PManager {
	private peerConnections = new Map<string, RTCPeerConnection>();
	private dataChannels = new Map<string, RTCDataChannel>();
	private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
	private remoteStreams = new Map<string, MediaStream>();
	private localStream: MediaStream | null = null;
	private callbacks: P2PCallbacks;
	private myUserId: string;
	private isStreaming = false;
	private videoBitrateKbps = DEFAULT_VIDEO_BITRATE_KBPS;
	private sseCleanup: (() => void) | null = null;
	// Fila por peer: sinais (offer/answer/ice) e renegociações do mesmo peer rodam em ordem, nunca em paralelo
	private peerQueues = new Map<string, Promise<void>>();
	// Momento em que a tentativa de conexão atual com cada peer começou
	private connectStartedAt = new Map<string, number>();
	// Momento da última oferta gerada para cada peer
	private lastOfferAt = new Map<string, number>();
	// "disconnected" costuma ser passageiro (oscilação de rede): espera antes de derrubar o vídeo
	private disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Watchdog anti-congelamento (recupera conexões presas em connecting ou sem vídeo)
	private watchdogTimer: ReturnType<typeof setInterval> | null = null;

	constructor(myUserId: string, callbacks: P2PCallbacks) {
		this.myUserId = myUserId;
		this.callbacks = callbacks;
		this.startWatchdog();
	}

	private startWatchdog(): void {
		if (this.watchdogTimer) return;
		this.watchdogTimer = setInterval(() => this.checkStuckConnections(), 3500);
	}

	private checkStuckConnections(): void {
		const now = Date.now();
		const CONNECT_STUCK_TIMEOUT_MS = 15000;
		const NO_VIDEO_RENEGOTIATE_MS = 12000;

		for (const [peerId, pc] of this.peerConnections) {
			if (pc.connectionState === "closed") continue;

			// Ignora caso este peer não seja mais permitido (ex: saiu da sala)
			if (this.callbacks.isPeerAllowed && !this.callbacks.isPeerAllowed(peerId)) {
				continue;
			}

			const startedAt = this.connectStartedAt.get(peerId) ?? 0;
			const lastOffer = this.lastOfferAt.get(peerId) ?? startedAt;
			const state = pc.connectionState;

			// 1. Preso em "new" ou "connecting" por muito tempo (sinal ou ICE perdido)
			if ((state === "new" || state === "connecting") && now - startedAt > CONNECT_STUCK_TIMEOUT_MS) {
				console.warn(`[P2P Watchdog] Peer ${peerId} preso em ${state} por mais de ${Math.round((now - startedAt) / 1000)}s. Forçando reconexão limpa...`);
				this.connectStartedAt.set(peerId, now);
				this.lastOfferAt.set(peerId, now);
				void this.renegotiate(peerId, true);
				continue;
			}

			// 2. Conectado via ICE, mas sem frames de vídeo chegando (se esperamos receber transmissão)
			const hasActiveStream = this.remoteStreams.has(peerId);
			const remoteStream = this.remoteStreams.get(peerId);
			const videoTracks = remoteStream?.getVideoTracks() ?? [];
			const hasLiveVideo = videoTracks.some((t) => t.readyState === "live" && !t.muted);

			if (
				(state === "connected" || pc.iceConnectionState === "connected") &&
				(!hasActiveStream || !hasLiveVideo) &&
				!this.isStreaming &&
				now - lastOffer > NO_VIDEO_RENEGOTIATE_MS
			) {
				console.warn(`[P2P Watchdog] Peer ${peerId} conectado mas sem vídeo ativo após ${Math.round((now - lastOffer) / 1000)}s. Renegociando...`);
				this.lastOfferAt.set(peerId, now);
				void this.renegotiate(peerId, false);
			}
		}
	}

	/** Define o bitrate máximo do vídeo transmitido e aplica na hora às conexões abertas */
	setVideoBitrate(kbps: number): void {
		this.videoBitrateKbps = Math.min(Math.max(500, kbps), MAX_VIDEO_BITRATE_KBPS);
		for (const pc of this.peerConnections.values()) {
			if (pc.connectionState !== "closed") configureSenderParameters(pc, this.videoBitrateKbps);
		}
	}

	setLocalStream(stream: MediaStream): void {
		this.localStream = stream;
		for (const [peerId, pc] of this.peerConnections) {
			if (pc.connectionState === "closed") continue;
			prioritizeH264(pc);
			let needsRenegotiation = false;
			for (const track of stream.getTracks()) {
				const transceivers = pc.getTransceivers();
				const matching = transceivers.find((t) => t.receiver.track?.kind === track.kind && t.direction !== "stopped");
				if (matching && matching.sender.track) {
					matching.sender.replaceTrack(track).then(() => {
						try { matching.sender.setStreams(stream); } catch {}
						console.log(`[P2P] Faixa ${track.kind} substituída em tempo real para ${peerId}`);
						configureSenderParameters(pc, this.videoBitrateKbps);
					}).catch((err) => console.warn(`[P2P] Erro replaceTrack para ${peerId}:`, err));
					if (matching.direction !== "sendrecv" && matching.direction !== "sendonly") {
						matching.direction = "sendrecv";
						needsRenegotiation = true;
					}
				} else {
					needsRenegotiation = true;
				}
			}
			if (needsRenegotiation) {
				void this.renegotiate(peerId, false);
			}
		}
	}

	startSignaling(): void {
		const token = getToken();
		if (!token || !(window.api as any)?.startSseSignaling) {
			console.warn("[P2P] startSseSignaling não disponível ou sem token.");
			return;
		}

		(window.api as any).startSseSignaling(token);

		const unsubscribe = (window.api as any).onSseSignal(async (event: string, data: any) => {
			console.log(`[P2P] Evento SSE recebido: ${event}`, data);
			switch (event) {
				case "offer":
					await this.enqueue(data.fromUserId, () => this.handleOffer(data.fromUserId, data.sdp, data.sessionId));
					break;
				case "answer":
					await this.enqueue(data.fromUserId, () => this.handleAnswer(data.fromUserId, data.sdp));
					break;
				case "ice-candidate":
					await this.enqueue(data.fromUserId, () => this.handleIceCandidate(data.fromUserId, data.candidate));
					break;
				case "peer-left":
					await this.enqueue(data.userId, async () => this.closePeer(data.userId));
					break;
			}
		});

		this.sseCleanup = () => {
			unsubscribe?.();
			(window.api as any)?.stopSseSignaling?.();
		};

		console.log("[P2P] Sinalização SSE iniciada.");
	}

	async callUser(targetUserId: string, forceRestart = false): Promise<void> {
		await this.renegotiate(targetUserId, forceRestart);
	}

	async renegotiate(targetUserId: string, forceRestart = false): Promise<void> {
		await this.enqueue(targetUserId, () => this.doRenegotiate(targetUserId, forceRestart));
	}

	/** Executa tarefas do mesmo peer em sequência (evita ofertas/respostas concorrentes) */
	private enqueue(peerId: string, task: () => Promise<void>): Promise<void> {
		const previous = this.peerQueues.get(peerId) ?? Promise.resolve();
		const run = previous.then(task);
		const tail = run.catch((err) => console.warn(`[P2P] Erro em tarefa da fila de ${peerId}:`, err));
		this.peerQueues.set(peerId, tail);
		tail.then(() => {
			if (this.peerQueues.get(peerId) === tail) this.peerQueues.delete(peerId);
		});
		return tail;
	}

	/** Há uma tentativa de conexão com o peer em andamento ou já conectado com sucesso */
	isConnecting(peerId: string, withinMs: number): boolean {
		const pc = this.peerConnections.get(peerId);
		if (!pc) return false;
		if (pc.connectionState === "connected") return true;
		if (pc.connectionState !== "new" && pc.connectionState !== "connecting") return false;
		const startedAt = this.connectStartedAt.get(peerId) ?? 0;
		return Date.now() - startedAt < withinMs;
	}

	isConnected(peerId: string): boolean {
		return this.peerConnections.get(peerId)?.connectionState === "connected";
	}

	private async addLocalTracks(pc: RTCPeerConnection, peerId: string): Promise<void> {
		if (!this.localStream) return;
		for (const track of this.localStream.getTracks()) {
			const transceivers = pc.getTransceivers();
			const matching = transceivers.find((t) => t.receiver.track?.kind === track.kind && t.direction !== "stopped");
			if (matching) {
				try {
					if (matching.sender.track !== track) {
						await matching.sender.replaceTrack(track);
					}
					matching.direction = "sendrecv";
					try {
						matching.sender.setStreams(this.localStream);
					} catch {}
				} catch (err) {
					console.warn(`[P2P] Erro replaceTrack para ${peerId}:`, err);
				}
			} else {
				const senders = pc.getSenders();
				const sender = senders.find((s) => s.track?.kind === track.kind);
				if (sender) {
					try {
						await sender.replaceTrack(track);
						sender.setStreams?.(this.localStream);
					} catch (err) {
						console.warn(`[P2P] Erro replaceTrack para ${peerId}:`, err);
					}
				} else {
					try {
						pc.addTrack(track, this.localStream);
					} catch (err) {
						console.warn(`[P2P] Erro ao adicionar track local para ${peerId}:`, err);
					}
				}
			}
		}
		configureSenderParameters(pc, this.videoBitrateKbps);
	}

	private async doRenegotiate(targetUserId: string, forceRestart: boolean): Promise<void> {
		let pc = this.peerConnections.get(targetUserId);

		if (pc) {
			const isBroken = pc.connectionState === "failed" || pc.connectionState === "closed";
			if (isBroken || forceRestart) {
				console.log(`[P2P] Reiniciando conexão com ${targetUserId} (estado: ${pc.connectionState})...`);
				this.closePeer(targetUserId);
				pc = undefined;
			}
		}

		if (!pc) {
			console.log(`[P2P] Criando nova conexão e oferta para ${targetUserId}...`);
			pc = this.createPeerConnection(targetUserId);
		}

		// Garante transceivers com direction adequada (Unified Plan)
		for (const kind of ["video", "audio"] as const) {
			const has = pc.getTransceivers().some((t) => t.receiver.track?.kind === kind && t.direction !== "stopped");
			if (!has) {
				const localTrack = this.localStream?.getTracks().find((t) => t.kind === kind);
				if (localTrack && this.localStream) {
					pc.addTrack(localTrack, this.localStream);
				} else {
					pc.addTransceiver(kind, { direction: "recvonly" });
				}
			}
		}

		await this.addLocalTracks(pc, targetUserId);
		for (const t of pc.getTransceivers()) {
			const kind = t.receiver.track?.kind;
			if (kind !== "audio" && kind !== "video") continue;
			const hasLocal = !!this.localStream?.getTracks().some((tr) => tr.kind === kind);
			t.direction = hasLocal ? "sendrecv" : "recvonly";
		}
		prioritizeH264(pc);

		try {
			const offer = await pc.createOffer();
			const optimizedSdp = optimizeSdp(offer.sdp || "");
			await pc.setLocalDescription({ type: "offer", sdp: optimizedSdp });
			this.lastOfferAt.set(targetUserId, Date.now());
			console.log(`[P2P] Oferta criada e enviada para ${targetUserId}`);

			await this.sendSignal("/api/signal/offer", {
				targetUserId,
				sdp: optimizedSdp,
				sessionId: "p2p",
			});
		} catch (err) {
			console.error(`[P2P] Falha ao criar/enviar oferta para ${targetUserId}:`, err);
			this.callbacks.onError(`Erro ao chamar usuário ${targetUserId}`);
		}
	}

	hasPeerConnection(peerId: string): boolean {
		const pc = this.peerConnections.get(peerId);
		return !!pc && pc.connectionState !== "closed" && pc.connectionState !== "failed";
	}

	hangupUser(targetUserId: string): void {
		this.closePeer(targetUserId);
	}

	stopLocalStream(): void {
		if (this.localStream) {
			this.localStream.getTracks().forEach((t) => t.stop());
			this.localStream = null;
		}
		this.isStreaming = false;

		for (const [peerId, pc] of this.peerConnections) {
			if (pc.connectionState === "closed") continue;
			const senders = pc.getSenders();
			for (const sender of senders) {
				try {
					pc.removeTrack(sender);
				} catch (err) {
					console.warn(`[P2P] Erro ao remover track para ${peerId}:`, err);
				}
			}
		}
	}

	hangupAll(): void {
		for (const [peerId] of this.peerConnections) {
			this.closePeer(peerId);
		}
		this.pendingCandidates.clear();
		this.localStream?.getTracks().forEach((t) => t.stop());
		this.localStream = null;
		this.isStreaming = false;
	}

	destroy(): void {
		if (this.watchdogTimer) {
			clearInterval(this.watchdogTimer);
			this.watchdogTimer = null;
		}
		this.hangupAll();
		this.sseCleanup?.();
		this.sseCleanup = null;
	}

	stopSignaling(): void {
		this.sseCleanup?.();
		this.sseCleanup = null;
	}

	getIsStreaming(): boolean {
		return this.isStreaming;
	}

	setIsStreaming(streaming: boolean): void {
		this.isStreaming = streaming;
	}

	getConnectedPeers(): string[] {
		return Array.from(this.peerConnections.keys());
	}

	private createPeerConnection(peerId: string): RTCPeerConnection {
		const pc = new RTCPeerConnection({
			iceServers: ICE_SERVERS,
			iceCandidatePoolSize: 2,
		});

		try {
			const dc = pc.createDataChannel("shiro-notices", { negotiated: true, id: 10 });
			this.setupDataChannel(peerId, dc);
		} catch (err) {
			console.warn("[P2P] Erro ao criar DataChannel:", err);
		}

		pc.ondatachannel = (e) => {
			this.setupDataChannel(peerId, e.channel);
		};

		// Eventos de uma conexão já substituída/fechada são ignorados
		const isCurrent = () => this.peerConnections.get(peerId) === pc;

		pc.onicecandidate = async (e) => {
			if (e.candidate && isCurrent()) {
				console.log(`[P2P] Novo ICE candidate gerado para ${peerId}:`, e.candidate.type, e.candidate.protocol);
				await this.sendSignal("/api/signal/ice", {
					targetUserId: peerId,
					candidate: e.candidate.toJSON(),
				});
			}
		};

		pc.oniceconnectionstatechange = () => {
			if (!isCurrent()) return;
			console.log(`[P2P] ${peerId} iceConnectionState: ${pc.iceConnectionState}`);
			if (pc.iceConnectionState === "failed") {
				console.warn(`[P2P] ICE failed para ${peerId}. Tentando reiniciar ICE se possível...`);
				try {
					pc.restartIce();
				} catch {}
			}
		};

		pc.onconnectionstatechange = () => {
			if (!isCurrent()) return;
			const state = pc.connectionState;
			console.log(`[P2P] ${peerId} connectionState: ${state}`);
			if (state === "connected") {
				this.clearDisconnectTimer(peerId);
				this.callbacks.onConnected(peerId);
			} else if (state === "disconnected") {
				// O WebRTC geralmente se recupera sozinho em poucos segundos: só fecha se não voltar
				if (!this.disconnectTimers.has(peerId)) {
					this.disconnectTimers.set(
						peerId,
						setTimeout(() => {
							this.disconnectTimers.delete(peerId);
							if (isCurrent() && pc.connectionState !== "connected") {
								console.warn(`[P2P] ${peerId} não se recuperou da desconexão. Encerrando para reconectar...`);
								this.closePeer(peerId);
							}
						}, DISCONNECT_GRACE_MS),
					);
				}
			} else if (state === "failed" || state === "closed") {
				this.closePeer(peerId);
			}
		};

		pc.ontrack = (e) => {
			if (!isCurrent()) return;
			console.log(`[P2P] ontrack de ${peerId}: kind=${e.track.kind}, id=${e.track.id}, streams=${e.streams.length}`);
			const emitUpdatedStream = () => {
				if (!isCurrent()) return;
				const prev = this.remoteStreams.get(peerId);
				const tracks = new Map<string, MediaStreamTrack>();
				if (prev) {
					for (const t of prev.getTracks()) {
						if (t.readyState !== "ended") tracks.set(t.kind, t);
					}
				}
				if (e.streams?.[0]) {
					for (const t of e.streams[0].getTracks()) {
						if (t.readyState !== "ended") tracks.set(t.kind, t);
					}
				}
				if (e.track.readyState !== "ended") {
					tracks.set(e.track.kind, e.track);
				}
				const stream = new MediaStream(Array.from(tracks.values()));
				this.remoteStreams.set(peerId, stream);
				this.callbacks.onRemoteStream?.(stream, peerId);
			};

			emitUpdatedStream();
			e.track.onunmute = () => {
				console.log(`[P2P] Faixa ${e.track.kind} de ${peerId} desmutou (recebendo pacotes).`);
				emitUpdatedStream();
			};
		};

		this.peerConnections.set(peerId, pc);
		this.connectStartedAt.set(peerId, Date.now());
		return pc;
	}

	private async drainPendingCandidates(peerId: string, pc: RTCPeerConnection): Promise<void> {
		const pending = this.pendingCandidates.get(peerId);
		if (pending && pending.length > 0) {
			console.log(`[P2P] Aplicando ${pending.length} ICE candidates enfileirados para ${peerId}...`);
			for (const cand of pending) {
				try {
					await pc.addIceCandidate(new RTCIceCandidate(cand));
				} catch (err) {
					console.warn(`[P2P] Erro ao aplicar candidate enfileirado para ${peerId}:`, err);
				}
			}
			this.pendingCandidates.delete(peerId);
		}
	}

	private async handleOffer(fromUserId: string, sdp: string, _sessionId: string): Promise<void> {
		if (this.callbacks.isPeerAllowed && !this.callbacks.isPeerAllowed(fromUserId)) {
			console.warn(`[P2P] Oferta de ${fromUserId} rejeitada: usuário não está na mesma sala.`);
			return;
		}

		console.log(`[P2P] Recebida oferta de ${fromUserId}`);
		let pc = this.peerConnections.get(fromUserId);
		let isFreshPc = false;
		if (!pc || pc.connectionState === "closed" || pc.connectionState === "failed") {
			if (pc) this.closePeer(fromUserId);
			pc = this.createPeerConnection(fromUserId);
			isFreshPc = true;
		}

		// Glare: os dois lados ofertaram ao mesmo tempo. O lado "polite" (menor ID) desfaz a
		// própria oferta e responde; o "impolite" ignora a oferta recebida e aguarda a resposta.
		if (pc.signalingState === "have-local-offer") {
			const polite = this.myUserId < fromUserId;
			if (!polite) {
				console.log(`[P2P] Glare com ${fromUserId}: mantendo a própria oferta (impolite).`);
				return;
			}
			console.log(`[P2P] Glare com ${fromUserId}: desfazendo a própria oferta (polite).`);
			try {
				await pc.setLocalDescription({ type: "rollback" });
			} catch (err) {
				console.warn(`[P2P] Rollback falhou com ${fromUserId}. Recriando conexão...`, err);
				this.closePeer(fromUserId);
				pc = this.createPeerConnection(fromUserId);
				isFreshPc = true;
			}
		} else if (pc.signalingState !== "stable") {
			console.warn(`[P2P] Estado de sinalização instável (${pc.signalingState}) com ${fromUserId}. Recriando conexão limpa para responder oferta...`);
			this.closePeer(fromUserId);
			pc = this.createPeerConnection(fromUserId);
			isFreshPc = true;
		}

		try {
			await this.answerOffer(pc, fromUserId, sdp);
		} catch (err) {
			if (isFreshPc) {
				console.error(`[P2P] Erro ao processar oferta de ${fromUserId}:`, err);
				if (this.peerConnections.get(fromUserId) === pc) this.closePeer(fromUserId);
				return;
			}
			// A oferta pertence a uma sessão nova do outro lado (ex.: ele recriou a conexão).
			// A conexão antiga não aceita as novas credenciais: recria do zero e responde de novo.
			console.warn(`[P2P] Oferta de ${fromUserId} incompatível com a conexão atual. Recriando conexão...`, err);
			this.closePeer(fromUserId);
			const freshPc = this.createPeerConnection(fromUserId);
			try {
				await this.answerOffer(freshPc, fromUserId, sdp);
			} catch (retryErr) {
				console.error(`[P2P] Erro ao processar oferta de ${fromUserId}:`, retryErr);
				if (this.peerConnections.get(fromUserId) === freshPc) this.closePeer(fromUserId);
			}
		}
	}

	private async answerOffer(pc: RTCPeerConnection, fromUserId: string, sdp: string): Promise<void> {
		// 1. Aplica a descrição remota PRIMEIRO para alinhar os transceivers da oferta
		await pc.setRemoteDescription({ type: "offer", sdp });
		await this.drainPendingCandidates(fromUserId, pc);

		// 2. Anexa faixas locais nos transceivers alinhados (se estiver transmitindo)
		await this.addLocalTracks(pc, fromUserId);
		for (const t of pc.getTransceivers()) {
			const kind = t.receiver.track?.kind;
			if (kind !== "audio" && kind !== "video") continue;
			const hasLocal = !!this.localStream?.getTracks().some((tr) => tr.kind === kind);
			t.direction = hasLocal ? "sendrecv" : "recvonly";
		}
		prioritizeH264(pc);

		// 3. Gera e envia a resposta
		const answer = await pc.createAnswer();
		const optimizedAnswerSdp = optimizeSdp(answer.sdp || "");
		await pc.setLocalDescription({ type: "answer", sdp: optimizedAnswerSdp });
		configureSenderParameters(pc, this.videoBitrateKbps);

		await this.sendSignal("/api/signal/answer", {
			targetUserId: fromUserId,
			sdp: optimizedAnswerSdp,
		});
		console.log(`[P2P] Resposta (Answer) enviada para ${fromUserId}`);
	}

	private async handleAnswer(fromUserId: string, sdp: string): Promise<void> {
		if (this.callbacks.isPeerAllowed && !this.callbacks.isPeerAllowed(fromUserId)) {
			console.warn(`[P2P] Resposta de ${fromUserId} ignorada: usuário não está na mesma sala.`);
			this.closePeer(fromUserId);
			return;
		}

		console.log(`[P2P] Recebida resposta (Answer) de ${fromUserId}`);
		const pc = this.peerConnections.get(fromUserId);
		if (!pc) {
			console.warn(`[P2P] PeerConnection não encontrada para resposta de ${fromUserId}`);
			return;
		}

		if (pc.signalingState !== "have-local-offer") {
			console.warn(`[P2P] Resposta de ${fromUserId} ignorada: nenhuma oferta pendente (estado: ${pc.signalingState}).`);
			return;
		}

		try {
			await pc.setRemoteDescription({ type: "answer", sdp });
			await this.drainPendingCandidates(fromUserId, pc);
			configureSenderParameters(pc, this.videoBitrateKbps);
			console.log(`[P2P] Remote description configurada com sucesso para ${fromUserId}`);
		} catch (err) {
			console.error(`[P2P] Erro ao definir remoteDescription de ${fromUserId}:`, err);
		}
	}

	private async handleIceCandidate(fromUserId: string, candidate: RTCIceCandidateInit): Promise<void> {
		if (this.callbacks.isPeerAllowed && !this.callbacks.isPeerAllowed(fromUserId)) {
			return;
		}

		const pc = this.peerConnections.get(fromUserId);
		if (!pc || !pc.remoteDescription) {
			if (!this.pendingCandidates.has(fromUserId)) {
				this.pendingCandidates.set(fromUserId, []);
			}
			this.pendingCandidates.get(fromUserId)!.push(candidate);
			console.log(`[P2P] ICE candidate de ${fromUserId} enfileirado (aguardando remoteDescription).`);
			return;
		}

		try {
			await pc.addIceCandidate(new RTCIceCandidate(candidate));
			console.log(`[P2P] ICE candidate de ${fromUserId} adicionado com sucesso.`);
		} catch (err) {
			console.warn(`[P2P] Erro ao adicionar ICE candidate de ${fromUserId}:`, err);
		}
	}

	private clearDisconnectTimer(peerId: string): void {
		const timer = this.disconnectTimers.get(peerId);
		if (timer) {
			clearTimeout(timer);
			this.disconnectTimers.delete(peerId);
		}
	}

	closePeer(peerId: string): void {
		this.clearDisconnectTimer(peerId);
		const dc = this.dataChannels.get(peerId);
		if (dc) {
			try { dc.close(); } catch {}
			this.dataChannels.delete(peerId);
		}

		const pc = this.peerConnections.get(peerId);
		if (pc) {
			try {
				pc.close();
			} catch {}
			this.peerConnections.delete(peerId);
			this.remoteStreams.delete(peerId);
			this.pendingCandidates.delete(peerId);
			this.connectStartedAt.delete(peerId);
			this.lastOfferAt.delete(peerId);
			this.callbacks.onDisconnected(peerId);
			console.log(`[P2P] PeerConnection com ${peerId} encerrada.`);
		}
	}

	private setupDataChannel(peerId: string, dc: RTCDataChannel): void {
		dc.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				if (data.type === "system-notice" && data.notice) {
					console.log(`[P2P] Aviso recebido via DataChannel de ${peerId}:`, data.notice);
					this.callbacks.onSystemNotice?.(data.notice);
				}
			} catch (err) {
				console.warn("[P2P] Erro ao parsear mensagem DataChannel:", err);
			}
		};
		dc.onclose = () => {
			this.dataChannels.delete(peerId);
		};
		this.dataChannels.set(peerId, dc);
	}

	broadcastNotice(notice: any): void {
		const payload = JSON.stringify({ type: "system-notice", notice });
		for (const [peerId, dc] of this.dataChannels) {
			if (dc.readyState === "open") {
				try {
					dc.send(payload);
					console.log(`[P2P] Aviso transmitido via DataChannel para ${peerId}`);
				} catch (err) {
					console.warn(`[P2P] Falha ao enviar aviso para ${peerId}:`, err);
				}
			}
		}
	}

	private async sendSignal(endpoint: string, body: Record<string, unknown>, retries = 2): Promise<void> {
		const token = getToken();
		if (!token || !window.api?.apiRequest) return;

		for (let attempt = 0; attempt <= retries; attempt++) {
			const result = await window.api.apiRequest({
				endpoint,
				method: "POST",
				body: { ...body, fromUserId: this.myUserId },
				token,
			});

			if (result.ok) return;

			if (result.status && result.status >= 400 && result.status < 500 && result.status !== 429) {
				console.error(`[P2P] Falha cliente ao enviar sinal ${endpoint}:`, result.data);
				return;
			}

			if (attempt < retries) {
				const delay = result.status === 429 ? 1000 : (attempt + 1) * 250;
				await new Promise((r) => setTimeout(r, delay));
			} else {
				console.error(`[P2P] Falha ao enviar sinal ${endpoint}:`, result.data);
				this.callbacks.onError(`Falha na sinalização: ${endpoint}`);
			}
		}
	}
}
