/**
 * Resolve hooks for running the plugin's pure logic under plain Node:
 *  - `obsidian` is redirected to the local stub
 *  - extensionless relative imports get the `.ts` extension Node's ESM
 *    resolver would otherwise refuse to guess
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STUB = new URL("./obsidian-stub.ts", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "obsidian") {
		return { url: STUB, shortCircuit: true, format: "module-typescript" };
	}

	if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
		const candidate = new URL(`${specifier}.ts`, context.parentURL);
		if (existsSync(fileURLToPath(candidate))) {
			return { url: candidate.href, shortCircuit: true, format: "module-typescript" };
		}
	}

	return nextResolve(specifier, context);
}
