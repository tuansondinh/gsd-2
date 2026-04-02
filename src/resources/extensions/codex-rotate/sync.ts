/**
 * Sync codex accounts to LSD's auth.json as api_key credentials
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { FileAuthStorageBackend, getAgentDir } from "@gsd/pi-coding-agent";
import type { CodexAccount } from "./types.js";
import { PROVIDER_NAME } from "./config.js";
import { logCodexRotateError } from "./logger.js";

type LockResult<T> = {
	result: T;
	next?: string;
};

type FileAuthStorageBackendLike = {
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
};

async function getFileAuthStorageBackend(): Promise<FileAuthStorageBackendLike> {
	return new FileAuthStorageBackend();
}

/**
 * Auth storage data format (matching pi-coding-agent's format)
 */
type ApiKeyCredential = { type: "api_key"; key: string };
type AuthCredential = ApiKeyCredential;
type AuthStorageData = Record<string, AuthCredential | AuthCredential[]>;

/**
 * Sync accounts to auth.json
 *
 * This writes all active codex accounts as api_key credentials in the auth.json file.
 * It uses withLockAsync to safely update the file atomically.
 */
export async function syncAccountsToAuth(accounts: CodexAccount[]): Promise<boolean> {
	try {
		const storage = await getFileAuthStorageBackend();

		await storage.withLockAsync(async (current) => {
			let authData: AuthStorageData = {};
			if (current) {
				try {
					authData = JSON.parse(current);
				} catch {
					// Ignore malformed existing auth.json here; a fresh value will be written below.
				}
			}

			const credentials: ApiKeyCredential[] = accounts
				.filter((acc) => !acc.disabled)
				.map((acc) => ({
					type: "api_key" as const,
					key: acc.accessToken,
				}));

			if (credentials.length > 0) {
				authData[PROVIDER_NAME] = credentials;
			} else {
				delete authData[PROVIDER_NAME];
			}

			return {
				result: true,
				next: JSON.stringify(authData, null, 2),
			};
		});

		return true;
	} catch (error) {
		logCodexRotateError("Failed to sync accounts to auth.json:", error);
		return false;
	}
}

/**
 * Remove codex credentials from auth.json
 */
export async function removeCodexFromAuth(): Promise<boolean> {
	try {
		const storage = await getFileAuthStorageBackend();

		await storage.withLockAsync(async (current) => {
			let authData: AuthStorageData = {};
			if (current) {
				try {
					authData = JSON.parse(current);
				} catch {
					// Ignore malformed existing auth.json here; a fresh value will be written below.
				}
			}

			delete authData[PROVIDER_NAME];

			return {
				result: true,
				next: JSON.stringify(authData, null, 2),
			};
		});

		return true;
	} catch (error) {
		logCodexRotateError("Failed to remove codex from auth.json:", error);
		return false;
	}
}

/**
 * Check if codex credentials exist in auth.json
 */
export function hasCodexInAuth(): boolean {
	try {
		const authPath = join(getAgentDir(), "auth.json");

		if (!existsSync(authPath)) {
			return false;
		}

		const content = readFileSync(authPath, "utf-8");
		const authData = JSON.parse(content) as AuthStorageData;
		return PROVIDER_NAME in authData;
	} catch (error) {
		logCodexRotateError("Failed to check auth.json:", error);
		return false;
	}
}
