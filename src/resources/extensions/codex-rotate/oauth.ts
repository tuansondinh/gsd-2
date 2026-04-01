/**
 * OAuth flow wrapper for Codex account management
 */

import type { OAuthCredentials } from "@gsd/pi-ai";
import { loginOpenAICodex, refreshOpenAICodexToken } from "@gsd/pi-ai/oauth";
import type { CodexAccount } from "./types.js";

/**
 * Perform OAuth login and return a new Codex account
 */
export async function performOAuthLogin(
	email?: string,
): Promise<Omit<CodexAccount, "id" | "addedAt" | "lastUsed" | "disabled">> {
	const credentials: OAuthCredentials = await loginOpenAICodex({
		onAuth: (info) => {
			console.log(`[codex-rotate] Opening browser for OAuth login...`);
			console.log(`[codex-rotate] URL: ${info.url}`);
			if (info.instructions) {
				console.log(`[codex-rotate] ${info.instructions}`);
			}
		},
		onPrompt: async (prompt) => {
			// This will be called if browser callback fails
			throw new Error("OAuth browser flow failed. Please try again.");
		},
		onProgress: (message) => {
			console.log(`[codex-rotate] ${message}`);
		},
	});

	return {
		email,
		accountId: credentials.accountId,
		refreshToken: credentials.refresh,
		accessToken: credentials.access,
		expiresAt: credentials.expires,
	};
}

/**
 * Refresh an account's access token
 */
export async function refreshAccountToken(account: CodexAccount): Promise<Omit<CodexAccount, "id" | "addedAt" | "lastUsed" | "disabled">> {
	try {
		const credentials = await refreshOpenAICodexToken(account.refreshToken);

		return {
			email: account.email,
			accountId: credentials.accountId,
			refreshToken: credentials.refresh,
			accessToken: credentials.access,
			expiresAt: credentials.expires,
		};
	} catch (error) {
		console.error(`[codex-rotate] Failed to refresh token for account ${account.id}:`, error);
		throw error;
	}
}

/**
 * Import account from existing ~/.codex/auth.json
 */
export async function importFromExistingCodexAuth(): Promise<CodexAccount | null> {
	try {
		const { homedir } = await import("os");
		const { readFileSync, existsSync } = await import("fs");
		const { join } = await import("path");

		const codexAuthPath = join(homedir(), ".codex", "auth.json");

		if (!existsSync(codexAuthPath)) {
			console.log("[codex-rotate] No existing ~/.codex/auth.json found");
			return null;
		}

		const content = readFileSync(codexAuthPath, "utf-8");
		const data = JSON.parse(content);

		// The file format varies, but typically contains refreshToken
		const refreshToken = data.refreshToken || data.refresh_token;
		if (!refreshToken) {
			console.log("[codex-rotate] No refresh token found in ~/.codex/auth.json");
			return null;
		}

		// Refresh to get fresh credentials
		const credentials = await refreshOpenAICodexToken(refreshToken);

		return {
			email: data.email,
			accountId: credentials.accountId,
			refreshToken: credentials.refresh,
			accessToken: credentials.access,
			expiresAt: credentials.expires,
			addedAt: Date.now(),
			id: `imported_${Date.now()}`,
			lastUsed: undefined,
			disabled: false,
		};
	} catch (error) {
		console.error("[codex-rotate] Failed to import from ~/.codex/auth.json:", error);
		return null;
	}
}

/**
 * Import accounts from Cockpit Tools store
 */
export async function importFromCockpit(): Promise<CodexAccount[]> {
	try {
		const { homedir } = await import("os");
		const { readFileSync, existsSync, readdirSync } = await import("fs");
		const { join } = await import("path");

		const cockpitDir = join(homedir(), ".antigravity_cockpit", "codex_accounts");

		if (!existsSync(cockpitDir)) {
			console.log("[codex-rotate] No Cockpit Tools store found");
			return [];
		}

		const files = readdirSync(cockpitDir).filter((f) => f.endsWith(".json"));
		const accounts: CodexAccount[] = [];

		for (const file of files) {
			try {
				const content = readFileSync(join(cockpitDir, file), "utf-8");
				const data = JSON.parse(content);

				const refreshToken = data.refreshToken || data.refresh_token;
				if (!refreshToken) continue;

				const credentials = await refreshOpenAICodexToken(refreshToken);

				accounts.push({
					email: data.email,
					accountId: credentials.accountId,
					refreshToken: credentials.refresh,
					accessToken: credentials.access,
					expiresAt: credentials.expires,
					addedAt: Date.now(),
					id: `cockpit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
					lastUsed: undefined,
					disabled: false,
				});
			} catch (error) {
				console.error(`[codex-rotate] Failed to import ${file}:`, error);
			}
		}

		return accounts;
	} catch (error) {
		console.error("[codex-rotate] Failed to import from Cockpit Tools:", error);
		return [];
	}
}
