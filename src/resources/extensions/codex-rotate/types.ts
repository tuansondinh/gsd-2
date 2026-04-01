/**
 * Types for the Codex OAuth rotation extension
 */

export interface CodexAccount {
	id: string;
	email?: string;
	accountId: string;
	refreshToken: string;
	accessToken: string;
	expiresAt: number;
	addedAt: number;
	lastUsed?: number;
	disabled: boolean;
	disabledReason?: string;
}

export interface CodexAccountsStore {
	accounts: CodexAccount[];
	version: number;
}

export interface RefreshResult {
	account: CodexAccount;
	success: boolean;
	error?: string;
}

export type CodexErrorType = "rate_limit" | "quota_exhausted" | "auth_error" | "unknown";
