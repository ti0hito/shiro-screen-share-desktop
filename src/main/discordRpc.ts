import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";

const IPC_OP_HANDSHAKE = 0;
const IPC_OP_FRAME = 1;
const IPC_OP_CLOSE = 2;
const IPC_OP_PING = 3;
const IPC_OP_PONG = 4;

const DEFAULT_CLIENT_ID = "1452768777585299486";
const RECONNECT_INTERVAL_MS = 15_000;

export type DiscordPresenceMode = "lobby" | "room" | "streaming" | "watching";

export interface DiscordPresenceState {
	mode: DiscordPresenceMode;
	roomName?: string;
	memberCount?: number;
	isPrivate?: boolean;
}

/**
 * Pure Node.js Discord Rich Presence IPC client (zero native dependencies).
 * Connects to the local Discord Desktop IPC pipe/socket when available and
 * silently retries if Discord is closed or not installed.
 */
export class DiscordRpcService {
	private readonly clientId: string;
	private enabled = true;
	private socket: net.Socket | null = null;
	private ready = false;
	private connecting = false;
	private destroyed = false;
	private readBuffer: Buffer = Buffer.alloc(0);
	private reconnectTimer: NodeJS.Timeout | null = null;
	private readonly startTimestamp = Math.floor(Date.now() / 1000);
	private currentState: DiscordPresenceState = { mode: "lobby" };

	constructor(clientId?: string) {
		this.clientId =
			clientId || process.env.SHIRO_DISCORD_CLIENT_ID || DEFAULT_CLIENT_ID;
	}

	public isEnabled(): boolean {
		return this.enabled;
	}

	public setEnabled(enabled: boolean): void {
		if (this.enabled === enabled) return;
		this.enabled = enabled;

		if (!enabled) {
			this.clearReconnectTimer();
			this.clearActivityAndDisconnect();
			return;
		}

		if (!this.destroyed) {
			this.ensureConnected();
		}
	}

	public updateActivity(state: DiscordPresenceState): void {
		this.currentState = { ...state };
		if (!this.enabled || this.destroyed) return;

		if (this.ready && this.socket && !this.socket.destroyed) {
			this.sendActivity();
		} else {
			this.ensureConnected();
		}
	}

	public start(): void {
		if (this.enabled && !this.destroyed) {
			this.ensureConnected();
		}
	}

	public destroy(): void {
		this.destroyed = true;
		this.clearReconnectTimer();
		this.clearActivityAndDisconnect();
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private scheduleReconnect(): void {
		if (!this.enabled || this.destroyed || this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.ensureConnected();
		}, RECONNECT_INTERVAL_MS);
		this.reconnectTimer.unref();
	}

	private ensureConnected(): void {
		if (
			!this.enabled ||
			this.destroyed ||
			this.connecting ||
			(this.socket && !this.socket.destroyed)
		) {
			return;
		}
		void this.connectToPipe(0);
	}

	private getCandidatePaths(): string[] {
		const paths: string[] = [];
		if (process.platform === "win32") {
			for (let i = 0; i < 10; i++) {
				paths.push(`\\\\?\\pipe\\discord-ipc-${i}`);
			}
			return paths;
		}

		const baseDirs = [
			process.env.XDG_RUNTIME_DIR,
			process.env.TMPDIR,
			process.env.TMP,
			process.env.TEMP,
			"/tmp",
		].filter((dir): dir is string => Boolean(dir));

		for (const base of baseDirs) {
			for (let i = 0; i < 10; i++) {
				paths.push(path.join(base, `discord-ipc-${i}`));
				paths.push(
					path.join(base, "app", "com.discordapp.Discord", `discord-ipc-${i}`),
				);
			}
		}
		return paths;
	}

	private async connectToPipe(index: number): Promise<void> {
		if (!this.enabled || this.destroyed) {
			this.connecting = false;
			return;
		}

		const candidates = this.getCandidatePaths();
		if (index >= candidates.length) {
			this.connecting = false;
			this.scheduleReconnect();
			return;
		}

		this.connecting = true;
		const pipePath = candidates[index];

		const socket = net.createConnection(pipePath);
		let settled = false;

		const handleConnectError = () => {
			if (settled) return;
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			void this.connectToPipe(index + 1);
		};

		socket.once("error", handleConnectError);

		socket.once("connect", () => {
			if (settled) return;
			settled = true;
			socket.removeListener("error", handleConnectError);

			if (!this.enabled || this.destroyed) {
				socket.destroy();
				this.connecting = false;
				return;
			}

			this.socket = socket;
			this.ready = false;
			this.connecting = false;
			this.readBuffer = Buffer.alloc(0);

			socket.on("data", (chunk: Buffer) => this.handleData(chunk));
			socket.on("close", () => this.handleSocketClose());
			socket.on("error", () => this.handleSocketClose());

			this.sendFrame(IPC_OP_HANDSHAKE, {
				v: 1,
				client_id: this.clientId,
			});
		});
	}

	private handleSocketClose(): void {
		this.ready = false;
		this.connecting = false;
		if (this.socket) {
			this.socket.removeAllListeners();
			this.socket.destroy();
			this.socket = null;
		}
		this.readBuffer = Buffer.alloc(0);
		this.scheduleReconnect();
	}

	private clearActivityAndDisconnect(): void {
		if (this.socket && !this.socket.destroyed) {
			if (this.ready) {
				this.sendFrame(IPC_OP_FRAME, {
					cmd: "SET_ACTIVITY",
					args: { pid: process.pid },
					nonce: crypto.randomUUID(),
				});
			}
			try {
				this.sendFrame(IPC_OP_CLOSE, {});
			} catch {
				// ignore socket write errors on teardown
			}
			this.socket.removeAllListeners();
			this.socket.destroy();
		}
		this.socket = null;
		this.ready = false;
		this.connecting = false;
		this.readBuffer = Buffer.alloc(0);
	}

	private handleData(chunk: Buffer): void {
		this.readBuffer = Buffer.concat([this.readBuffer, chunk]);

		while (this.readBuffer.length >= 8) {
			const op = this.readBuffer.readInt32LE(0);
			const len = this.readBuffer.readInt32LE(4);
			if (len < 0 || len > 1_048_576) {
				this.handleSocketClose();
				return;
			}
			if (this.readBuffer.length < 8 + len) {
				return;
			}

			const payloadBuf = this.readBuffer.subarray(8, 8 + len);
			this.readBuffer = this.readBuffer.subarray(8 + len);

			if (op === IPC_OP_PING) {
				try {
					this.sendFrame(IPC_OP_PONG, JSON.parse(payloadBuf.toString("utf8")));
				} catch {
					// ignore invalid ping payload
				}
				continue;
			}

			if (op === IPC_OP_CLOSE) {
				this.handleSocketClose();
				return;
			}

			if (op === IPC_OP_FRAME) {
				try {
					const message = JSON.parse(payloadBuf.toString("utf8")) as {
						cmd?: string;
						evt?: string;
					};
					if (message.cmd === "DISPATCH" && message.evt === "READY") {
						this.ready = true;
						this.sendActivity();
					}
				} catch {
					// ignore malformed JSON frames
				}
			}
		}
	}

	private sendFrame(op: number, data: unknown): void {
		if (!this.socket || this.socket.destroyed) return;
		const payload = Buffer.from(JSON.stringify(data), "utf8");
		const header = Buffer.alloc(8);
		header.writeInt32LE(op, 0);
		header.writeInt32LE(payload.length, 4);
		this.socket.write(Buffer.concat([header, payload]));
	}

	private buildActivityPayload(): Record<string, unknown> {
		const { mode, roomName, memberCount, isPrivate } = this.currentState;
		const cleanRoomName = roomName?.trim();

		let details = "Shiro Screen Share";
		let state = "No lobby • Preparando transmissão";

		if (mode === "streaming") {
			details = isPrivate
				? "Transmitindo em sala privada"
				: cleanRoomName
					? `Transmitindo: ${cleanRoomName}`
					: "Transmitindo a tela ao vivo";
			state =
				memberCount && memberCount > 1
					? `${memberCount} pessoas na sala`
					: "Compartilhando tela em tempo real";
		} else if (mode === "watching") {
			details = isPrivate
				? "Assistindo em sala privada"
				: cleanRoomName
					? `Assistindo: ${cleanRoomName}`
					: "Assistindo transmissão ao vivo";
			state =
				memberCount && memberCount > 1
					? `${memberCount} pessoas na sala`
					: "Conectado à transmissão";
		} else if (mode === "room") {
			details = isPrivate
				? "Em uma sala privada"
				: cleanRoomName
					? `Na sala: ${cleanRoomName}`
					: "Em uma sala do Shiro Screen Share";
			state =
				memberCount && memberCount > 1
					? `${memberCount} pessoas na sala`
					: "Aguardando transmissão";
		}

		return {
			details,
			state,
			timestamps: {
				start: this.startTimestamp,
			},
			assets: {
				large_image: "shiro_logo",
				large_text: "Shiro Screen Share • share.shirobot.xyz",
			},
			buttons: [
				{
					label: "Conheça a Shiro",
					url: "https://shirobot.xyz",
				},
				{
					label: "Visite o Screen Share",
					url: "https://share.shirobot.xyz",
				},
			],
			instance: false,
		};
	}

	private sendActivity(): void {
		if (!this.enabled || !this.ready || !this.socket || this.socket.destroyed) {
			return;
		}
		this.sendFrame(IPC_OP_FRAME, {
			cmd: "SET_ACTIVITY",
			args: {
				pid: process.pid,
				activity: this.buildActivityPayload(),
			},
			nonce: crypto.randomUUID(),
		});
	}
}
