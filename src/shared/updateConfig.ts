/**
 * updateConfig.ts
 * Configurações de atualizações da Shiro (Exclusivo para Desenvolvedores).
 * 
 * Para tornar uma atualização obrigatória (bloqueando o aplicativo até o usuário atualizar),
 * você pode:
 * 1. Definir `FORCE_MANDATORY_UPDATES: true` abaixo, OU
 * 2. Adicionar a versão à lista `MANDATORY_VERSIONS: ["2.3.0"]`, OU
 * 3. Definir `MIN_REQUIRED_VERSION: "2.3.0"`, OU
 * 4. No GitHub Release ou latest.yml, incluir `mandatory: true` ou colocar "[MANDATORY]" na descrição.
 */

export const UPDATE_CONFIG = {
	/**
	 * Se verdadeiro, QUALQUER atualização encontrada será obrigatória,
	 * bloqueando o uso do aplicativo até que ela seja instalada.
	 */
	FORCE_MANDATORY_UPDATES: false,

	/**
	 * Lista de versões específicas que são estritamente obrigatórias.
	 * Exemplo: ["2.3.0", "2.4.0"]
	 */
	MANDATORY_VERSIONS: [] as string[],

	/**
	 * Versão mínima aceita para usar o app.
	 * Se houver atualização para versão igual ou superior a esta, o update é forçado.
	 * Exemplo: "2.3.0" (deixe vazio "" para desativar).
	 */
	MIN_REQUIRED_VERSION: "",
};

/**
 * Verifica se a atualização recebida é obrigatória
 */
export function isUpdateMandatory(newVersion: string, releaseNotes?: unknown, customFields?: any): boolean {
	if (UPDATE_CONFIG.FORCE_MANDATORY_UPDATES) return true;

	const cleanVersion = newVersion.replace(/^v/, "").trim();
	if (UPDATE_CONFIG.MANDATORY_VERSIONS.map(v => v.replace(/^v/, "").trim()).includes(cleanVersion)) {
		return true;
	}

	if (UPDATE_CONFIG.MIN_REQUIRED_VERSION) {
		const minClean = UPDATE_CONFIG.MIN_REQUIRED_VERSION.replace(/^v/, "").trim();
		if (cleanVersion >= minClean) return true;
	}

	// Flag customizada no latest.yml ou info
	if (customFields?.mandatory === true || customFields?.isMandatory === true) {
		return true;
	}

	// Tag [MANDATORY] nas release notes
	if (typeof releaseNotes === "string" && (releaseNotes.includes("[MANDATORY]") || releaseNotes.toLowerCase().includes("mandatory: true"))) {
		return true;
	}
	if (Array.isArray(releaseNotes)) {
		const notesStr = JSON.stringify(releaseNotes);
		if (notesStr.includes("[MANDATORY]") || notesStr.toLowerCase().includes("mandatory: true")) {
			return true;
		}
	}

	return false;
}
