export type UiSoundType = "click" | "notification" | "new_message" | "mention";

const SOUND_FILES: Record<UiSoundType, string> = {
	click: "./sounds/click.mp3",
	notification: "./sounds/notification.mp3",
	new_message: "./sounds/new_message.mp3",
	mention: "./sounds/mention.mp3",
};

const DEFAULT_VOLUMES: Record<UiSoundType, number> = {
	click: 45,
	notification: 70,
	new_message: 65,
	mention: 80,
};

const STORAGE_PREFIX = "shiro-sound-volume-";
const lastPlayedAt = new Map<UiSoundType, number>();

function clampVolume(value: number): number {
	if (!Number.isFinite(value)) return 50;
	return Math.max(0, Math.min(100, Math.round(value)));
}

export function getSoundVolume(type: UiSoundType): number {
	try {
		const raw = localStorage.getItem(`${STORAGE_PREFIX}${type}`);
		if (raw !== null) {
			const parsed = Number(raw);
			if (Number.isFinite(parsed)) {
				return clampVolume(parsed);
			}
		}
	} catch {
		// ignore localStorage errors
	}
	return DEFAULT_VOLUMES[type];
}

export function setSoundVolume(type: UiSoundType, volume: number): number {
	const clamped = clampVolume(volume);
	try {
		localStorage.setItem(`${STORAGE_PREFIX}${type}`, String(clamped));
	} catch {
		// ignore localStorage errors
	}
	return clamped;
}

export function getAllSoundVolumes(): Record<UiSoundType, number> {
	return {
		click: getSoundVolume("click"),
		notification: getSoundVolume("notification"),
		new_message: getSoundVolume("new_message"),
		mention: getSoundVolume("mention"),
	};
}

/**
 * Plays a UI sound effect respecting the user's per-sound volume setting (0-100).
 */
export function playUiSound(type: UiSoundType, ignoreThrottle = false): void {
	const volume = getSoundVolume(type);
	if (volume <= 0) return;

	if (!ignoreThrottle) {
		const now = performance.now();
		const minGapMs = type === "click" ? 30 : 80;
		const last = lastPlayedAt.get(type) ?? 0;
		if (now - last < minGapMs) return;
		lastPlayedAt.set(type, now);
	}

	try {
		const audio = new Audio(SOUND_FILES[type]);
		audio.volume = volume / 100;
		void audio.play().catch((err) => {
			console.warn(`[SoundManager] Falha ao reproduzir ${type}:`, err);
		});
	} catch (err) {
		console.warn(`[SoundManager] Erro ao criar áudio ${type}:`, err);
	}
}

