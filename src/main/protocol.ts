import path from "node:path";
import { app } from "electron";
import type { DeepLinkParams } from "../types/ipc";

export const PROTOCOL_NAME = "shiro";

export function registerDeepLinkProtocol(): void {
	if (!app.setAsDefaultProtocolClient) return;

	try {
		if (process.defaultApp) {
			if (process.argv.length >= 2) {
				app.setAsDefaultProtocolClient(PROTOCOL_NAME, process.execPath, [
					path.resolve(process.argv[1]),
				]);
			}
		} else {
			app.setAsDefaultProtocolClient(PROTOCOL_NAME);
		}
		console.log(
			`[Protocol] Registered ${PROTOCOL_NAME}:// custom protocol client`,
		);
	} catch (err) {
		console.error("[Protocol] Error registering protocol handler:", err);
	}
}

export function parseDeepLinkUrl(urlStr: string): DeepLinkParams | null {
	try {
		const parsed = new URL(urlStr);
		if (parsed.protocol !== `${PROTOCOL_NAME}:`) return null;

		const params: DeepLinkParams = {};
		for (const [key, value] of parsed.searchParams) {
			params[key] = decodeURIComponent(value);
		}

		const action = parsed.hostname || parsed.pathname?.replace(/^\/+/, "");
		if (action) {
			params._action = action;
		}

		return params;
	} catch (err) {
		console.warn("[Protocol] Error parsing deep link URL:", urlStr, err);
		return null;
	}
}
