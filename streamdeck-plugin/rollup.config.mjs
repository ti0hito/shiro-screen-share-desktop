import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";

export default {
	input: "src/plugin.ts",
	output: {
		file: "com.shiro.screenshare.sdPlugin/bin/plugin.js",
		format: "cjs",
		sourcemap: false,
	},
	external: ["sharp"],
	plugins: [
		typescript({ tsconfig: "./tsconfig.json" }),
		resolve({ preferBuiltins: true }),
		commonjs(),
	],
};
