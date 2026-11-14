import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { piPackageRoot } from "./pi-host.ts";

test("normal queued delivery claims, and a reentrant custom triggerTurn does not", (t) => {
	const host = piPackageRoot();
	const version = JSON.parse(readFileSync(join(host, "package.json"), "utf8")).version;
	if (version !== "1.5.2") {
		t.skip("custom triggerTurn event exists on the 1.5.2 host");
		return;
	}
	execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/custom-run-probe.ts", import.meta.url))], {
		cwd: fileURLToPath(new URL("../", import.meta.url)),
		env: { ...process.env, TEST_PI_HOST: host },
		stdio: "pipe",
	});
});
