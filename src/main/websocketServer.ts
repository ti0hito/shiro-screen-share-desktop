import { WebSocketServer, WebSocket } from "ws";
import type { BrowserWindow } from "electron";

const WS_PORT = 51234;

export type ScreenShareState = {
	isSharing: boolean;
};

export type SourceInfo = {
	id: string;
	name: string;
	processName: string;
	sourceType: "window" | "screen";
	thumbnailUrl: string;
};

export type AudioMode = "process" | "system" | "disabled";

type WsMessage =
	| { type: "state_changed"; payload: ScreenShareState }
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

let wss: WebSocketServer | null = null;
let mainWindow: BrowserWindow | null = null;

export function startWebSocketServer(win: BrowserWindow): void {
	mainWindow = win;

	if (wss) {
		console.log("[WS] Server already running on port", WS_PORT);
		return;
	}

	wss = new WebSocketServer({ port: WS_PORT });

	wss.on("listening", () => {
		console.log(`[WS] Stream Deck bridge listening on ws://127.0.0.1:${WS_PORT}`);
	});

	wss.on("connection", (ws) => {
		console.log("[WS] Stream Deck plugin connected");

		ws.on("message", (raw) => {
			try {
				const msg: WsMessage = JSON.parse(raw.toString());
				handleMessage(ws, msg);
			} catch (err) {
				console.warn("[WS] Invalid message:", err);
			}
		});

		ws.on("close", () => {
			console.log("[WS] Stream Deck plugin disconnected");
		});

		// Send current state on connect
		queryCurrentState(ws);
		querySources(ws);
		queryAudioMode(ws);
	});

	wss.on("error", (err) => {
		console.error("[WS] Server error:", err);
	});
}

function handleMessage(ws: WebSocket, msg: WsMessage): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;

	switch (msg.type) {
		case "get_state":
			queryCurrentState(ws);
			break;

		case "toggle":
			mainWindow.webContents.send("streamdeck-toggle");
			break;

		case "get_sources":
			querySources(ws);
			break;

		case "select_source":
			mainWindow.webContents.send("streamdeck-select-source", msg.payload.index);
			break;

		case "cycle_source":
			mainWindow.webContents.send("streamdeck-cycle-source");
			break;

		case "get_audio_mode":
			queryAudioMode(ws);
			break;

		case "set_audio_mode":
			mainWindow.webContents.send("streamdeck-set-audio-mode", msg.payload.mode);
			break;

		case "cycle_audio_mode":
			mainWindow.webContents.send("streamdeck-cycle-audio-mode");
			break;

		case "launch_activity":
			mainWindow.webContents.send("streamdeck-launch-activity");
			break;

		default:
			console.warn("[WS] Unknown message type:", (msg as any).type);
	}
}

function queryCurrentState(ws: WebSocket): void {
	if (!mainWindow || mainWindow.isDestroyed()) {
		sendMessage(ws, { type: "state_changed", payload: { isSharing: false } });
		return;
	}
	mainWindow.webContents.send("streamdeck-get-state");
	pendingStateRequests.add(ws);
}

function querySources(ws: WebSocket): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send("streamdeck-get-sources");
	pendingSourceRequests.add(ws);
}

function queryAudioMode(ws: WebSocket): void {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send("streamdeck-get-audio-mode");
	pendingAudioRequests.add(ws);
}

export const pendingStateRequests = new Set<WebSocket>();
export const pendingSourceRequests = new Set<WebSocket>();
export const pendingAudioRequests = new Set<WebSocket>();

export function broadcastState(state: ScreenShareState): void {
	broadcast({ type: "state_changed", payload: state });
}

export function broadcastSources(sources: SourceInfo[], selectedIndex: number): void {
	broadcast({ type: "sources_updated", payload: { sources, selectedIndex } });
}

export function broadcastAudioMode(mode: AudioMode): void {
	broadcast({ type: "audio_mode_changed", payload: { mode } });
}

export function respondToStateRequest(state: ScreenShareState): void {
	respondToPending(pendingStateRequests, {
		type: "state_changed",
		payload: state,
	});
}

export function respondToSourceRequest(
	sources: SourceInfo[],
	selectedIndex: number,
): void {
	respondToPending(pendingSourceRequests, {
		type: "sources_updated",
		payload: { sources, selectedIndex },
	});
}

export function respondToAudioRequest(mode: AudioMode): void {
	respondToPending(pendingAudioRequests, {
		type: "audio_mode_changed",
		payload: { mode },
	});
}

export function sendThumbnailUpdate(context: string, thumbnailUrl: string): void {
	broadcast({
		type: "thumbnail_update",
		payload: { context, thumbnailUrl },
	});
}

function broadcast(msg: WsMessage): void {
	if (!wss) return;
	const data = JSON.stringify(msg);
	wss.clients.forEach((client) => {
		if (client.readyState === WebSocket.OPEN) {
			client.send(data);
		}
	});
}

function respondToPending(
	pending: Set<WebSocket>,
	msg: WsMessage,
): void {
	const data = JSON.stringify(msg);
	for (const ws of pending) {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(data);
		}
	}
	pending.clear();
}

function sendMessage(ws: WebSocket, msg: WsMessage): void {
	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

export function stopWebSocketServer(): void {
	if (wss) {
		wss.close();
		wss = null;
		console.log("[WS] Server stopped");
	}
}
