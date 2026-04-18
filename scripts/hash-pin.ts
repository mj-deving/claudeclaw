#!/usr/bin/env bun
/** Generate a salted SHA-256 hash for use as PIN_HASH in .env. */

import { createHash, randomBytes } from "node:crypto";

const pin = process.argv[2];
if (!pin) {
  console.error("Usage: bun run scripts/hash-pin.ts <pin> [salt]");
  console.error("\nGenerates PIN_HASH and PIN_SALT values for your .env file.");
  console.error("If salt is omitted, a random one is generated.");
  process.exit(1);
}

const salt = process.argv[3] || randomBytes(16).toString("hex");
// Must match the hash algorithm in src/security.ts hashWithSalt()
const hash = createHash("sha256").update(`${salt}:${pin}`).digest("hex");

console.log("\nAdd these to your .env file:\n");
console.log(`PIN_SALT=${salt}`);
console.log(`PIN_HASH=${hash}`);
