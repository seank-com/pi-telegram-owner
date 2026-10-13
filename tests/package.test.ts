import test from "node:test";import {verifyPacked} from "./fixtures/package-harness.ts";
test("packed Telegram loads standalone, runs native helpers and both compiled CLIs",{timeout:90000},t=>verifyPacked(t));
