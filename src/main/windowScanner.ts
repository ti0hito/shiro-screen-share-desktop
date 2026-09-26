import { desktopCapturer } from "electron";
import koffi from "koffi";
import type { WindowSource } from "../types/capture";

// Load User32.dll via Koffi FFI to extract PID from Window Handle (HWND)
let GetWindowThreadProcessId: any = null;
try {
	const user32 = koffi.load("user32.dll");
	GetWindowThreadProcessId = user32.func(
		"uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32 *lpdwProcessId)",
	);
} catch (err) {
	console.error("[WindowScanner] Failed to load user32.dll via Koffi:", err);
}

/**
 * Extracts PID from HWND integer using Win32 API
 */
export function getPidFromHwnd(hwndInt: number): number {
	if (!hwndInt || !GetWindowThreadProcessId) return 0;
	try {
		const pidBox = [0];
		GetWindowThreadProcessId(hwndInt, pidBox);
		return pidBox[0] || 0;
	} catch (err) {
		console.error("[WindowScanner] Error resolving PID from HWND:", err);
		return 0;
	}
}

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

let cachedProcessMap: Map<number, string> = new Map();
let lastCacheTime = 0;

/**
 * Build a map of PID to Process Name using tasklist (Cached for 5s)
 */
export async function getProcessMap(): Promise<Map<number, string>> {
	const now = Date.now();
	if (now - lastCacheTime < 5000 && cachedProcessMap.size > 0) {
		return cachedProcessMap;
	}

	const map = new Map<number, string>();
	try {
		const { stdout } = await execAsync("tasklist /FO CSV /NH", {
			encoding: "utf8",
			timeout: 3000,
		});
		const lines = stdout.split("\n");
		for (const line of lines) {
			const match = line.match(/^"([^"]+)","(\d+)"/);
			if (match) {
				const processName = match[1];
				const pid = parseInt(match[2], 10);
				map.set(pid, processName);
			}
		}
		cachedProcessMap = map;
		lastCacheTime = now;
	} catch (err) {
		console.warn(
			"[WindowScanner] Could not execute tasklist for process names:",
			err,
		);
	}
	return cachedProcessMap;
}

/**
 * Finds all candidate PIDs associated with a given primary PID or process name
 */
export function findCandidatePids(
	primaryPid: number,
	processName?: string | null,
): number[] {
	const candidates: number[] = [];
	if (primaryPid > 0) candidates.push(primaryPid);

	if (!processName || processName === "Unknown" || processName === "System") {
		return candidates;
	}

	const map = cachedProcessMap;
	const lowerTarget = processName.toLowerCase();

	// Known launcher-to-game mappings (e.g. LeagueClient.exe -> League of Legends.exe)
	const gameAliases: Record<string, string[]> = {
		"leagueclient.exe": ["leagueclientux.exe", "league of legends.exe"],
		"leagueclientux.exe": ["leagueclient.exe", "league of legends.exe"],
		"riotclientservices.exe": [
			"leagueclient.exe",
			"league of legends.exe",
			"valorant-win64-shipping.exe",
		],
	};

	const aliases = gameAliases[lowerTarget] || [];

	for (const [pid, name] of map.entries()) {
		const lowerName = name.toLowerCase();
		if (
			pid !== primaryPid &&
			(lowerName === lowerTarget || aliases.includes(lowerName))
		) {
			candidates.push(pid);
		}
	}

	return candidates;
}

/**
 * Scans available screens and windows with resolved Process IDs & Executable names
 */
export async function scanSources(): Promise<WindowSource[]> {
	const sources = await desktopCapturer.getSources({
		types: ["window", "screen"],
		thumbnailSize: { width: 480, height: 270 },
		fetchWindowIcons: true,
	});

	const processMap = await getProcessMap();
	const windowSources: WindowSource[] = [];

	for (const src of sources) {
		const isScreen = src.id.startsWith("screen:");
		let pid = 0;
		let hwnd = 0;
		let processName = isScreen ? "System" : "Unknown";

		if (!isScreen) {
			// Electron source IDs for windows are formatted as "window:HWND_INT:SUB_ID"
			const parts = src.id.split(":");
			if (parts.length >= 2) {
				hwnd = parseInt(parts[1], 10);
				if (hwnd > 0) {
					pid = getPidFromHwnd(hwnd);
					if (pid > 0 && processMap.has(pid)) {
						processName = processMap.get(pid)!;
					}
				}
			}
		}

		windowSources.push({
			id: src.id,
			name: src.name || (isScreen ? "Tela Inteira" : "Janela Sem Nome"),
			sourceType: isScreen ? "screen" : "window",
			pid,
			hwnd,
			processName,
			// JPEG: codifica bem mais rápido que PNG (toDataURL) e reduz o payload do IPC
			thumbnailUrl: `data:image/jpeg;base64,${src.thumbnail.toJPEG(75).toString("base64")}`,
			appIconUrl: src.appIcon ? src.appIcon.toDataURL() : undefined,
		});
	}

	return windowSources;
}
