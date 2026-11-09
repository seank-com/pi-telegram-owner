import test from "node:test";
import { piPackageRoot } from "./pi-host.ts";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("selectors use verified public APIs on the real Pi SDK with no Telegram or model calls", () => {
	execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/selector-host-probe.ts", import.meta.url))], {
		cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...process.env, TEST_PI_HOST: piPackageRoot() }, stdio: "pipe",
	});
});
