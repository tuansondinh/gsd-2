/**
 * Sync codex accounts to LSD's auth.json as api_key credentials
 */

import { existsSync } from "fs";
import { join } from "path";
import type { CodexAccount } from "./types.js";
import { PROVIDER_NAME } from "./config.js";

/**
 * FileAuthStorageBackend interface (matching pi-coding-agent's implementation)
 */
interface FileAuthStorageBackend {
	authPath: string;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T>;
}

/**
 * Get the FileAuthStorageBackend implementation
 */
function getFileAuthStorageBackend(): FileAuthStorageBackend {
	// Import dynamically to avoid top-level Node.js dependencies
	const { getAgentDir } = require("@gsd/pi-coding-agent/dist/config.js");

	class FileAuthStorageBackendImpl implements FileAuthStorageBackend {
		public authPath: string;

		constructor() {
			this.authPath = join(getAgentDir(), "auth.json");
		}
	}

	return new FileAuthStorageBackendImpl();
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
		const storage = getFileAuthStorageBackend();

		await storage.withLockAsync(async (current) => {
			// Parse existing auth data
			let authData: AuthStorageData = {};
			if (current) {
				try {
					authData = JSON.parse(current);
				} catch (error) {
					console.error("[codex-rotate] Failed to parse auth.json:", error);
				}
			}

			// Build new credential array for openai-codex
			const credentials: ApiKeyCredential[] = accounts
				.filter((acc) => !acc.disabled)
				.map((acc) => ({
					type: "api_key" as const,
					key: acc.accessToken,
				}));

			// Update auth data
			if (credentials.length > 0) {
				authData[PROVIDER_NAME] = credentials;
			} else {
				// Remove provider if no credentials
				delete authData[PROVIDER_NAME];
			}

			// Return updated auth data
			return {
				result: true,
				next: JSON.stringify(authData, null, 2),
			};
		});

		return true;
	} catch (error) {
		console.error("[codex-rotate] Failed to sync accounts to auth.json:", error);
		return false;
	}
}

/**
 * Remove codex credentials from auth.json
 */
export async function removeCodexFromAuth(): Promise<boolean> {
	try {
		const storage = getFileAuthStorageBackend();

		await storage.withLockAsync(async (current) => {
			let authData: AuthStorageData = {};
			if (current) {
				try {
					authData = JSON.parse(current);
				} catch (error) {
					console.error("[codex-rotate] Failed to parse auth.json:", error);
				}
			}

			// Remove provider from auth data
			delete authData[PROVIDER_NAME];

			return {
				result: true,
				next: JSON.stringify(authData, null, 2),
			};
		});

		return true;
	} catch (error) {
		console.error("[codex-rotate] Failed to remove codex from auth.json:", error);
		return false;
	}
}

/**
 * Check if codex credentials exist in auth.json
 */
export function hasCodexInAuth(): boolean {
	try {
		const { getAgentDir } = require("@gsd/pi-coding-agent/dist/config.js");
		const authPath = join(getAgentDir(), "auth.json");

		if (!existsSync(authPath)) {
			return false;
		}

		const { readFileSync } = require("fs");
		const content = readFileSync(authPath, "utf-8");
		const authData = JSON.parse(content) as AuthStorageData;
		return PROVIDER_NAME in authData;
	} catch (error) {
		console.error("[codex-rotate] Failed to check auth.json:", error);
		return false;
	}
}
