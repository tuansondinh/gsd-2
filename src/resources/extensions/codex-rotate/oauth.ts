/**
 * OAuth flow wrapper for Codex account management
 */

import type { OAuthCredentials } from "@gsd/pi-ai";
import { loginOpenAICodex, refreshOpenAICodexToken } from "@gsd/pi-ai/oauth";
import type { CodexAccount } from "./types.js";
import { logCodexRotateError } from "./logger.js";

function getAccountId(credentials: OAuthCredentials): string {
	if (typeof credentials.accountId !== "string" || credentials.accountId.length === 0) {
		throw new Error("Missing Codex accountId in OAuth credentials");
	}
	return credentials.accountId;
}

function asObject(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getRequiredRefreshToken(data: Record<string, unknown>): string | null {
	const refreshToken = data.refreshToken ?? data.refresh_token;
	return typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null;
}

/**
 * Perform OAuth login and return a new Codex account
 */
export async function performOAuthLogin(
	email?: string,
): Promise<Omit<CodexAccount, "id" | "addedAt" | "lastUsed" | "disabled">> {
	const credentials: OAuthCredentials = await loginOpenAICodex({
		onAuth: () => {},
		onPrompt: async () => {
			throw new Error("OAuth browser flow failed. Please try again.");
		},
		onProgress: () => {},
	});

	return {
		email,
		accountId: getAccountId(credentials),
		refreshToken: credentials.refresh,
		accessToken: credentials.access,
		expiresAt: credentials.expires,
	};
}

/**
 * Refresh an account's access token
 */
export async function refreshAccountToken(
	account: CodexAccount,
): Promise<Omit<CodexAccount, "id" | "addedAt" | "lastUsed" | "disabled">> {
	try {
		const credentials = await refreshOpenAICodexToken(account.refreshToken);

		return {
			email: account.email,
			accountId: getAccountId(credentials),
			refreshToken: credentials.refresh,
			accessToken: credentials.access,
			expiresAt: credentials.expires,
		};
	} catch (error) {
		logCodexRotateError(`Failed to refresh token for account ${account.id}:`, error);
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
			return null;
		}

		const content = readFileSync(codexAuthPath, "utf-8");
		const data = asObject(JSON.parse(content));
		if (!data) {
			return null;
		}

		const refreshToken = getRequiredRefreshToken(data);
		if (!refreshToken) {
			return null;
		}

		const credentials = await refreshOpenAICodexToken(refreshToken);

		return {
			email: getOptionalString(data.email),
			accountId: getAccountId(credentials),
			refreshToken: credentials.refresh,
			accessToken: credentials.access,
			expiresAt: credentials.expires,
			addedAt: Date.now(),
			id: `imported_${Date.now()}`,
			lastUsed: undefined,
			disabled: false,
		};
	} catch (error) {
		logCodexRotateError("Failed to import from ~/.codex/auth.json:", error);
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
			return [];
		}

		const files = readdirSync(cockpitDir).filter((f) => f.endsWith(".json"));
		const accounts: CodexAccount[] = [];

		for (const file of files) {
			try {
				const content = readFileSync(join(cockpitDir, file), "utf-8");
				const data = asObject(JSON.parse(content));
				if (!data) continue;

				const refreshToken = getRequiredRefreshToken(data);
				if (!refreshToken) continue;

				const credentials = await refreshOpenAICodexToken(refreshToken);

				accounts.push({
					email: getOptionalString(data.email),
					accountId: getAccountId(credentials),
					refreshToken: credentials.refresh,
					accessToken: credentials.access,
					expiresAt: credentials.expires,
					addedAt: Date.now(),
					id: `cockpit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
					lastUsed: undefined,
					disabled: false,
				});
			} catch (error) {
				logCodexRotateError(`Failed to import ${file}:`, error);
			}
		}

		return accounts;
	} catch (error) {
		logCodexRotateError("Failed to import from Cockpit Tools:", error);
		return [];
	}
}
