import assert from "node:assert/strict";import test from "node:test";import {verifyPacked} from "./fixtures/package-harness.ts";
test("packed Telegram composes with independently installed datastore and observability",{timeout:90000},t=>{assert.ok(process.env.DATASTORE_TARBALL&&process.env.OBSERVABILITY_TARBALL,"explicit companion tarballs required");return verifyPacked(t,true);});
