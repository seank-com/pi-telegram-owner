import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ProjectPreferences {
	provider: string;
	model: string;
	thinking: string;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Update Pi's documented project configuration, never the shared agent profile. */
export async function saveProjectPreferences(projectRoot: string, configDirectory: string, preferences: ProjectPreferences): Promise<string> {
	const path = join(projectRoot, configDirectory, "settings.json");
	let settings: Record<string, unknown> = {};
	let mode = 0o600;
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!object(parsed)) throw new Error("Project settings must be a JSON object; nothing was saved.");
		settings = parsed;
		mode = (await stat(path)).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const levels = settings.modelThinkingLevels === undefined ? {} : settings.modelThinkingLevels;
	if (!object(levels)) throw new Error("Project modelThinkingLevels must be an object; nothing was saved.");
	const updated = {
		...settings,
		defaultProvider: preferences.provider,
		defaultModel: preferences.model,
		defaultThinkingLevel: preferences.thinking,
		// A per-model setting takes precedence over the ordinary thinking default.
		// Pin only this model's level so an inherited override cannot undo /save.
		modelThinkingLevels: { ...levels, [`${preferences.provider}/${preferences.model}`]: preferences.thinking },
	};
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.settings-${randomUUID()}.tmp`);
	try {
		const file = await open(temporary, "wx", mode);
		try {
			await file.chmod(mode);
			await file.writeFile(`${JSON.stringify(updated, null, 2)}\n`);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
	return path;
}
