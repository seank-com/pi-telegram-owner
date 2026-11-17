import assert from "node:assert/strict";import test from "node:test";import {verifyPacked} from "./fixtures/package-harness.ts";
test("packed Telegram composes with independent companions and a narrowed private message-store root",t=>{assert.ok(process.env.DATASTORE_TARBALL&&process.env.OBSERVABILITY_TARBALL,"explicit companion tarballs required");return verifyPacked(t,true);});
