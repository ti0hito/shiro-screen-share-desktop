import streamDeck from "@elgato/streamdeck";
import WebSocket from "ws";

const WS_URL = "ws://127.0.0.1:51234";

export type WsMessage =
	| { type: "state_changed"; payload: { isSharing: boolean } }
	| { type: "sources_updated"; payload: { sources: SourceInfo[]; selectedIndex: number } }
	| { type: "audio_mode_changed"; payload: { mode: AudioMode } }
	| { type: "thumbnail_update"; payload: { context: string; thumbnailUrl: string } }
	| { type: "toggle" }
	| { type: "get_state" }
	| { type: "get_sources" }
	| { type: "select_source"; payload: { index: number } }
	| { type: "cycle_source" }
	| { type: "get_audio_mode" }
	| { type: "set_audio_mode"; payload: { mode: AudioMode } }
	| { type: "cycle_audio_mode" }
	| { type: "launch_activity" };

export type SourceInfo = {
	id: string;
	name: string;
	processName: string;
	sourceType: "window" | "screen";
	thumbnailUrl: string;
};

export type AudioMode = "process" | "system" | "disabled";

export type MessageHandler = (msg: WsMessage) => void;

class StreamDeckWsClient {
	private ws: WebSocket | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private handlers: MessageHandler[] = [];

	constructor() {
		this.connect();
	}

	onMessage(handler: MessageHandler): void {
		this.handlers.push(handler);
	}

	private connect(): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

		try {
			this.ws = new WebSocket(WS_URL);
		} catch (err) {
			this.scheduleReconnect();
			return;
		}

		this.ws.on("open", () => {
			streamDeck.logger.info("Connected to Shiro Screen Share");
		});

		this.ws.on("message", (raw) => {
			try {
				const msg: WsMessage = JSON.parse(raw.toString());
				this.handlers.forEach((h) => h(msg));
			} catch {
				// ignore parse errors
			}
		});

		this.ws.on("close", () => {
			streamDeck.logger.info("Disconnected from Shiro Screen Share");
			this.ws = null;
			this.scheduleReconnect();
		});

		this.ws.on("error", () => {
			this.ws = null;
		});
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, 3000);
	}

	send(msg: WsMessage): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	get isConnected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}
}

// Singleton shared across all actions
let client: StreamDeckWsClient | null = null;

export function getWsClient(): StreamDeckWsClient {
	if (!client) {
		client = new StreamDeckWsClient();
	}
	return client;
}
