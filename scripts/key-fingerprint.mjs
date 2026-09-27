/**
 * Mostra a impressão digital (hash curto) de chaves da API, a mesma que o build imprime.
 * Serve para conferir se a chave embutida num build (ex.: log do GitHub Actions) é a que o
 * servidor aceita, sem expor a chave.
 *
 * Uso:
 *   node scripts/key-fingerprint.mjs <chave>            (uma chave)
 *   node scripts/key-fingerprint.mjs "nova,antiga"      (a lista do servidor: mostra cada uma)
 *   node scripts/key-fingerprint.mjs                    (usa a SHIRO_API_KEY do .env)
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import process from "node:process";
import dotenv from "dotenv";

if (existsSync(".env")) dotenv.config({ path: ".env" });

const input = process.argv[2] ?? process.env.SHIRO_API_KEY ?? "";
const keys = input.split(",").map((k) => k.trim()).filter(Boolean);
if (keys.length === 0) {
	console.error("Informe a chave: node scripts/key-fingerprint.mjs <chave>");
	process.exit(1);
}
for (const key of keys) {
	const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 8);
	console.log(`${key.length} caracteres, impressão digital ${fingerprint}`);
}
