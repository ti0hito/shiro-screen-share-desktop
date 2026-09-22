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
	let lines = sdp.split("\r\n");

	// 1. Otimização de áudio Opus (Stereo, In-Band FEC, CBR e bitrate estável)
	lines = lines.map((line) => {
		if (line.startsWith("a=fmtp:") && line.includes("opus/48000")) {
			return `${line};stereo=1;sprop-stereo=1;maxaveragebitrate=128000;useinbandfec=1;cbr=1`;
		}
		return line;
	});

	// 2. Limite de largura de banda de vídeo para evitar picos brutos (4500kbps)
	const resultLines: string[] = [];
	for (const line of lines) {
		resultLines.push(line);
		if (line.startsWith("m=video")) {
			resultLines.push("b=AS:4500");
			resultLines.push("b=TIAS:4500000");
		}
	}

	return resultLines.join("\r\n");
}

/**
 * Configura parâmetros de codificação de vídeo nos senders WebRTC
 */
function configureSenderParameters(pc: RTCPeerConnection): void {
	try {
		for (const sender of pc.getSenders()) {
			if (sender.track?.kind === "video") {
				const params = sender.getParameters();
				if (params.encodings && params.encodings.length > 0) {
					params.encodings[0].maxBitrate = 4500000; // 4.5 Mbps
					params.encodings[0].networkPriority = "high";
					params.encodings[0].priority = "high";
					params.degradationPreference = "maintain-framerate";
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
	private pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
	private localStream: MediaStream | null = null;
	private callbacks: P2PCallbacks;
	private myUserId: string;
	private isStreaming = false;
	private sseCleanup: (() => void) | null = null;

	constructor(myUserId: string, callbacks: P2PCallbacks) {
		this.myUserId = myUserId;
		this.callbacks = callbacks;
	}

	setLocalStream(stream: MediaStream): void {
		this.localStream = stream;
		for (const [peerId, pc] of this.peerConnections) {
			if (pc.connectionState === "closed") continue;
			prioritizeH264(pc);
			const senders = pc.getSenders();
			for (const track of stream.getTracks()) {
				const sender = senders.find((s) => s.track?.kind === track.kind);
				if (sender) {
					sender.replaceTrack(track).then(() => {
						console.log(`[P2P] Faixa ${track.kind} substituída em tempo real para ${peerId}`);
						configureSenderParameters(pc);
					}).catch((err) => console.warn(`[P2P] Erro replaceTrack para ${peerId}:`, err));
				} else {
					try {
						pc.addTrack(track, stream);
						console.log(`[P2P] Nova faixa ${track.kind} adicionada para ${peerId}`);
						configureSenderParameters(pc);
					} catch (err) {
						console.warn(`[P2P] Erro addTrack para ${peerId}:`, err);
					}
				}
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
					await this.handleOffer(data.fromUserId, data.sdp, data.sessionId);
					break;
				case "answer":
					await this.handleAnswer(data.fromUserId, data.sdp);
					break;
				case "ice-candidate":
					await this.handleIceCandidate(data.fromUserId, data.candidate);
					break;
				case "peer-left":
					this.closePeer(data.userId);
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

		prioritizeH264(pc);

		if (this.localStream) {
			const senders = pc.getSenders();
			for (const track of this.localStream.getTracks()) {
				const sender = senders.find((s) => s.track?.kind === track.kind);
				if (sender) {
					sender.replaceTrack(track).catch((err) => console.warn(`[P2P] Erro replaceTrack para ${targetUserId}:`, err));
				} else {
					try {
						pc.addTrack(track, this.localStream);
					} catch (err) {
						console.warn(`[P2P] Erro ao adicionar track local para ${targetUserId}:`, err);
					}
				}
			}
			configureSenderParameters(pc);
		}

		try {
			const offer = await pc.createOffer({
				offerToReceiveAudio: true,
				offerToReceiveVideo: true,
			});
			const optimizedSdp = optimizeSdp(offer.sdp || "");
			await pc.setLocalDescription({ type: "offer", sdp: optimizedSdp });
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

		pc.onicecandidate = async (e) => {
			if (e.candidate) {
				console.log(`[P2P] Novo ICE candidate gerado para ${peerId}:`, e.candidate.type, e.candidate.protocol);
				await this.sendSignal("/api/signal/ice", {
					targetUserId: peerId,
					candidate: e.candidate.toJSON(),
				});
			}
		};

		pc.oniceconnectionstatechange = () => {
			console.log(`[P2P] ${peerId} iceConnectionState: ${pc.iceConnectionState}`);
			if (pc.iceConnectionState === "failed") {
				console.warn(`[P2P] ICE failed para ${peerId}. Tentando reiniciar ICE se possível...`);
				try {
					pc.restartIce();
				} catch {}
			}
		};

		pc.onconnectionstatechange = () => {
			const state = pc.connectionState;
			console.log(`[P2P] ${peerId} connectionState: ${state}`);
			if (state === "connected") {
				this.callbacks.onConnected(peerId);
			} else if (state === "disconnected" || state === "failed" || state === "closed") {
				this.closePeer(peerId);
			}
		};

		pc.ontrack = (e) => {
			console.log(`[P2P] ontrack de ${peerId}: kind=${e.track.kind}, streams=${e.streams.length}`);
			const stream = e.streams[0] || new MediaStream([e.track]);
			if (this.callbacks.onRemoteStream) {
				this.callbacks.onRemoteStream(stream, peerId);
			}
		};

		this.peerConnections.set(peerId, pc);
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
		console.log(`[P2P] Recebida oferta de ${fromUserId}`);
		let pc = this.peerConnections.get(fromUserId);
		if (!pc || pc.connectionState === "closed" || pc.connectionState === "failed") {
			if (pc) this.closePeer(fromUserId);
			pc = this.createPeerConnection(fromUserId);
		}

		if (pc.signalingState !== "stable" && pc.signalingState !== "have-local-offer") {
			console.warn(`[P2P] Estado de sinalização instável (${pc.signalingState}) com ${fromUserId}. Recriando conexão limpa para responder oferta...`);
			this.closePeer(fromUserId);
			pc = this.createPeerConnection(fromUserId);
		}

		prioritizeH264(pc);

		if (this.localStream) {
			const senders = pc.getSenders();
			for (const track of this.localStream.getTracks()) {
				const existing = senders.find((s) => s.track?.kind === track.kind);
				if (!existing) {
					try {
						pc.addTrack(track, this.localStream);
					} catch (err) {
						console.warn(`[P2P] Erro ao adicionar track local para ${fromUserId}:`, err);
					}
				}
			}
			configureSenderParameters(pc);
		}

		try {
			await pc.setRemoteDescription({ type: "offer", sdp });
			await this.drainPendingCandidates(fromUserId, pc);

			const answer = await pc.createAnswer();
			const optimizedAnswerSdp = optimizeSdp(answer.sdp || "");
			await pc.setLocalDescription({ type: "answer", sdp: optimizedAnswerSdp });

			await this.sendSignal("/api/signal/answer", {
				targetUserId: fromUserId,
				sdp: optimizedAnswerSdp,
			});
			console.log(`[P2P] Resposta (Answer) enviada para ${fromUserId}`);
		} catch (err) {
			console.error(`[P2P] Erro ao processar oferta de ${fromUserId}:`, err);
			this.closePeer(fromUserId);
		}
	}

	private async handleAnswer(fromUserId: string, sdp: string): Promise<void> {
		console.log(`[P2P] Recebida resposta (Answer) de ${fromUserId}`);
		const pc = this.peerConnections.get(fromUserId);
		if (!pc) {
			console.warn(`[P2P] PeerConnection não encontrada para resposta de ${fromUserId}`);
			return;
		}

		try {
			await pc.setRemoteDescription({ type: "answer", sdp });
			await this.drainPendingCandidates(fromUserId, pc);
			configureSenderParameters(pc);
			console.log(`[P2P] Remote description configurada com sucesso para ${fromUserId}`);
		} catch (err) {
			console.error(`[P2P] Erro ao definir remoteDescription de ${fromUserId}:`, err);
		}
	}

	private async handleIceCandidate(fromUserId: string, candidate: RTCIceCandidateInit): Promise<void> {
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

	private closePeer(peerId: string): void {
		const pc = this.peerConnections.get(peerId);
		if (pc) {
			try {
				pc.close();
			} catch {}
			this.peerConnections.delete(peerId);
			this.pendingCandidates.delete(peerId);
			this.callbacks.onDisconnected(peerId);
			console.log(`[P2P] PeerConnection com ${peerId} encerrada.`);
		}
	}

	private async sendSignal(endpoint: string, body: Record<string, unknown>): Promise<void> {
		const token = getToken();
		if (!token || !window.api?.apiRequest) return;

		const result = await window.api.apiRequest({
			endpoint,
			method: "POST",
			body: { ...body, fromUserId: this.myUserId },
			token,
		});

		if (!result.ok) {
			console.error(`[P2P] Falha ao enviar sinal ${endpoint}:`, result.data);
			this.callbacks.onError(`Falha na sinalização: ${endpoint}`);
		}
	}
}
