/**
 * Gera os pacotes Linux (AppImage + .deb) a partir do Windows usando Docker.
 *
 * Os bundles (dist/) são compilados no host pelo "npm run build:all" antes; o container só
 * empacota com o electron-builder (que precisa de ferramentas Linux para AppImage/deb).
 * Requer o Docker Desktop rodando.
 *
 * Uso: npm run build:linux:docker
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

const IMAGE = "electronuserland/builder:20";
const projectDir = process.cwd();

const args = [
	"run",
	"--rm",
	"-v",
	`${projectDir}:/project`,
	// Cache do Electron/electron-builder fora do projeto (evita baixar tudo a cada build)
	"-v",
	"shiro-electron-cache:/root/.cache/electron",
	"-v",
	"shiro-electron-builder-cache:/root/.cache/electron-builder",
	"-w",
	"/project",
	IMAGE,
	"/bin/bash",
	"-c",
	"node node_modules/electron-builder/cli.js --linux --publish never",
];

console.log(`[build-linux] docker ${args.join(" ")}`);
const result = spawnSync("docker", args, { stdio: "inherit" });
if (result.error) {
	console.error("[build-linux] Falha ao executar o Docker. O Docker Desktop está rodando?", result.error.message);
	process.exit(1);
}
process.exit(result.status ?? 1);
