import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { piPackageRoot } from "./pi-host.ts";

test(
	"native SDK executes Request, silent waiting, terminal Reply and pinned owner continuation offline",
	{ timeout: 30000 },
	() => {
		execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/native-lifecycle-probe.ts", import.meta.url))], {
			cwd: fileURLToPath(new URL("../", import.meta.url)),
			env: { ...process.env, TEST_PI_HOST: piPackageRoot() },
			stdio: "pipe",
			timeout: 25000,
		});
	},
);
