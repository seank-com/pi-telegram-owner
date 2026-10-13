import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
const files = readdirSync("tests").filter(name => name.endsWith(".test.ts") && !["package.test.ts", "integration.test.ts"].includes(name));
const result = spawnSync(process.execPath, ["--test", ...files.map(name => `tests/${name}`)], { stdio: "inherit", timeout: 120_000 });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
