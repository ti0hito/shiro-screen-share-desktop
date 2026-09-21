import streamDeck, {
	action,
	type KeyDownEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	SingletonAction,
} from "@elgato/streamdeck";
import { exec } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const DISCORD_ACTIVITY_URL = "discord://-/activities/1452768777585299486";

function findDiscordPath(): string | null {
	const localAppData = process.env.LOCAPPDATA || "";
	const paths = [
		join(localAppData, "Discord", "Update.exe"),
		join(localAppData, "Discord", "Discord.exe"),
	];
	for (const p of paths) {
		if (existsSync(p)) return p;
	}
	return null;
}

@action({ UUID: "com.shiro.screenshare.launch-activity" })
export class LaunchActivityAction extends SingletonAction {
	override onWillAppear(_ev: WillAppearEvent): void {}

	override onWillDisappear(_ev: WillDisappearEvent): void {}

	override onKeyDown(ev: KeyDownEvent): void | Promise<void> {
		const platform = process.platform;
		let cmd: string;

		if (platform === "win32") {
			const discordPath = findDiscordPath();
			if (discordPath) {
				if (discordPath.endsWith("Update.exe")) {
					cmd = `"${discordPath}" --processStart Discord.exe -- "${DISCORD_ACTIVITY_URL}"`;
				} else {
					cmd = `"${discordPath}" "${DISCORD_ACTIVITY_URL}"`;
				}
			} else {
				cmd = `start "" "${DISCORD_ACTIVITY_URL}"`;
			}
		} else if (platform === "darwin") {
			cmd = `open -a "Discord" "${DISCORD_ACTIVITY_URL}"`;
		} else {
			cmd = `xdg-open "${DISCORD_ACTIVITY_URL}"`;
		}

		exec(cmd);
		ev.action.showOk();
	}
}
