/**
 * Compila o processo main (esbuild) embutindo a SHIRO_API_KEY no momento do build.
 *
 * A chave NÃO fica no código-fonte (o repositório é público). Ela vem de:
 *   - a variável de ambiente SHIRO_API_KEY (ex.: secret do GitHub Actions), ou
 *   - o arquivo .env na raiz do projeto (ignorado pelo git).
 *
 * É embutida embaralhada (XOR com um sal aleatório a cada build) para não aparecer em texto
 * puro no app compilado. Não é criptografia forte: quem tem o app consegue extraí-la — a
 * proteção real da API é o login (JWT).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import process from "node:process";
import dotenv from "dotenv";
import { build } from "esbuild";

if (existsSync(".env")) dotenv.config({ path: ".env" });

// Tolera erros comuns ao colar o secret: a linha inteira do .env ("SHIRO_API_KEY=...") ou aspas
const apiKey = process.env.SHIRO_API_KEY?.trim()
	.replace(/^SHIRO_API_KEY\s*=\s*/, "")
	.replace(/^(['"])(.*)\1$/, "$2")
	.trim();
if (!apiKey) {
	console.error(`
[build-main] SHIRO_API_KEY não encontrada.

  Crie um arquivo .env na raiz do projeto com a linha:
      SHIRO_API_KEY=<a chave da API>

  (No GitHub Actions, cadastre o secret SHIRO_API_KEY em Settings → Secrets and variables → Actions.)
`);
	process.exit(1);
}

// A API aceita várias chaves separadas por vírgula ("nova,antiga"), mas o app usa só UMA
if (apiKey.includes(",")) {
	console.error(`
[build-main] SHIRO_API_KEY tem uma vírgula: parece a lista de chaves do SERVIDOR ("nova,antiga").
  O app precisa de uma chave só (a nova). Corrija o .env ou o secret do GitHub Actions.
`);
	process.exit(1);
}

// Impressão digital da chave (hash curto): dá para conferir no log público se é a mesma chave
// do servidor sem expor a chave. Compare com: node scripts/key-fingerprint.mjs <chave>
const fingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 8);
console.log(`[build-main] SHIRO_API_KEY embutida: ${apiKey.length} caracteres, impressão digital ${fingerprint}`);

const salt = randomBytes(32);
const keyBytes = Buffer.from(apiKey, "utf8");
const obfuscated = Buffer.from(keyBytes.map((byte, i) => byte ^ salt[i % salt.length]));

await build({
	entryPoints: ["src/main/main.ts"],
	bundle: true,
	platform: "node",
	target: "node18",
	outfile: "dist/main/main.js",
	format: "cjs",
	external: ["electron", "koffi", "loopback-capture", "dotenv", "electron-updater"],
	define: {
		__SHIRO_API_KEY_DATA__: JSON.stringify(obfuscated.toString("base64")),
		__SHIRO_API_KEY_SALT__: JSON.stringify(salt.toString("base64")),
	},
	logLevel: "info",
});
