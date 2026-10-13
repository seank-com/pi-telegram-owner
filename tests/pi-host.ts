import { findPackageJSON } from "node:module";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * An explicit PI_CODING_AGENT_PACKAGE, else the locked development host.
 * Resolve that host's own pi-ai (including nested npm shrinkwrap layouts).
 */
export function piPackageRoot(): string {
	const configured = process.env.PI_CODING_AGENT_PACKAGE;
	const root = configured ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
	return realpathSync(root);
}

export async function importPi(): Promise<any> {
	return import(pathToFileURL(join(piPackageRoot(), "dist/index.js")).href);
}

/** A module from the host Pi's own `@earendil-works/pi-ai`, for example `index.js` or `api/anthropic-messages.js`. */
export async function importPiAi(modulePath = "index.js"): Promise<any> {
	const manifest = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(join(piPackageRoot(), "package.json")));
	if (!manifest) throw new Error("selected host has no pi-ai dependency");
	return import(pathToFileURL(join(manifest, "..", "dist", modulePath)).href);
}
