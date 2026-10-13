#!/usr/bin/env node

import { resolve } from "node:path";

import {
	loadTelegramOwnerConfig,
	projectTelegramOwnerConfigPath,
	sanitizeError,
} from "../runtime.ts";

async function main(): Promise<void> {
	if (![3, 5].includes(process.argv.length) || (process.argv.length === 5 && process.argv[3] !== "--config-dir")) {
		throw new Error("usage: pi-telegram-register-menu PROJECT_ROOT [--config-dir DIRECTORY]");
	}
	const projectRoot = resolve(process.argv[2]);
	const loaded = await loadTelegramOwnerConfig(projectTelegramOwnerConfigPath(projectRoot, process.argv[4] ?? ".pi"));
	if (loaded.kind !== "configured" || !loaded.config) {
		throw new Error(`Telegram owner configuration is absent for ${projectRoot}`);
	}
	await loaded.config.createApiClient().setOwnerCommandMenu();
	process.stdout.write("Registered the five Telegram owner commands.\n");
}

main().catch((error) => {
	process.stderr.write(`${sanitizeError(error)}\n`);
	process.exitCode = 1;
});
