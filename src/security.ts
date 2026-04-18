/** PIN lock with salted SHA-256, idle auto-lock, per-chat lock state. */

import { createHash, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000; // 15 minutes

interface LockState {
  locked: boolean;
  lastActivity: number;
  failedAttempts: number;
  lockoutUntil: number;
}

/** Per-chat lock state. Starts locked if PIN is configured. */
const lockStates = new Map<number, LockState>();

/** Hash a PIN with an explicit salt using SHA-256. Shared by security.ts and hash-pin.ts. */
export function hashWithSalt(pin: string, salt: string): string {
  return createHash("sha256")
    .update(`${salt}:${pin}`)
    .digest("hex");
}

/** Hash a PIN with the configured salt. */
export function hashPin(pin: string): string {
  return hashWithSalt(pin, config.pinSalt);
}

/** Get or create lock state for a chat. New chats start locked. */
function getState(chatId: number): LockState {
  let state = lockStates.get(chatId);
  if (!state) {
    state = { locked: true, lastActivity: Date.now(), failedAttempts: 0, lockoutUntil: 0 };
    lockStates.set(chatId, state);
  }
  return state;
}

/** Check if a chat is currently locked (including idle auto-lock). */
export function isLocked(chatId: number): boolean {
  if (!config.pinHash) return false; // PIN not configured — no locking

  const state = getState(chatId);

  // Check idle auto-lock
  if (!state.locked && config.idleLockMs > 0) {
    const elapsed = Date.now() - state.lastActivity;
    if (elapsed >= config.idleLockMs) {
      state.locked = true;
      console.log(`[security] Chat ${chatId} auto-locked after ${Math.round(elapsed / 60_000)}m idle`);
    }
  }

  return state.locked;
}

/** Attempt to unlock a chat with a PIN. Returns true if PIN matches. */
export function tryUnlock(chatId: number, pin: string): { success: boolean; lockedOut?: boolean } {
  if (!config.pinHash) return { success: true };

  const state = getState(chatId);

  // Rate limiting — check lockout
  if (state.failedAttempts >= MAX_FAILED_ATTEMPTS && Date.now() < state.lockoutUntil) {
    const remainingMin = Math.ceil((state.lockoutUntil - Date.now()) / 60_000);
    console.warn(`[security] Chat ${chatId} locked out for ${remainingMin} more minutes`);
    return { success: false, lockedOut: true };
  }

  // Timing-safe comparison to prevent side-channel attacks
  const hash = hashPin(pin);
  const hashBuf = Buffer.from(hash, "hex");
  const expectedBuf = Buffer.from(config.pinHash, "hex");
  const match = hashBuf.length === expectedBuf.length && timingSafeEqual(hashBuf, expectedBuf);

  if (match) {
    state.locked = false;
    state.lastActivity = Date.now();
    state.failedAttempts = 0;
    state.lockoutUntil = 0;
    console.log(`[security] Chat ${chatId} unlocked`);
    return { success: true };
  }

  state.failedAttempts++;
  if (state.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    state.lockoutUntil = Date.now() + LOCKOUT_MS;
    console.warn(`[security] Chat ${chatId} locked out after ${MAX_FAILED_ATTEMPTS} failed attempts`);
  } else {
    console.warn(`[security] Failed unlock attempt for chat ${chatId} (${state.failedAttempts}/${MAX_FAILED_ATTEMPTS})`);
  }
  return { success: false };
}

/** Manually lock a chat. */
export function lock(chatId: number): void {
  const state = getState(chatId);
  state.locked = true;
  console.log(`[security] Chat ${chatId} manually locked`);
}

/** Update last activity timestamp (resets idle timer). */
export function touchActivity(chatId: number): void {
  const state = getState(chatId);
  state.lastActivity = Date.now();
}

/** Whether PIN lock is enabled at all. */
export function isPinEnabled(): boolean {
  return !!config.pinHash;
}
