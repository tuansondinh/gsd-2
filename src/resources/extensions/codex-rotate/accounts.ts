/**
 * Account store CRUD operations for Codex OAuth rotation
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { CodexAccount, CodexAccountsStore } from "./types.js";
import { ACCOUNTS_FILE, REFRESH_BEFORE_EXPIRY_MS } from "./config.js";

let agentDir: string | null = null;

function getAgentDirImpl(): string {
	if (agentDir) return agentDir;
	// Use the same logic as pi-coding-agent's getAgentDir
	const home = process.env.HOME || process.env.USERPROFILE || require("os").homedir();
	agentDir = join(home, ".lsd", "agent");
	return agentDir;
}

function getAccountsPath(): string {
	return join(getAgentDirImpl(), ACCOUNTS_FILE);
}

function ensureAccountsFile(): CodexAccountsStore {
	const path = getAccountsPath();
	const dir = dirname(path);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	if (!existsSync(path)) {
		const empty: CodexAccountsStore = { accounts: [], version: 1 };
		writeFileSync(path, JSON.stringify(empty, null, 2), "utf-8");
		chmodSync(path, 0o600);
		return empty;
	}

	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as CodexAccountsStore;
	} catch (error) {
		console.error("[codex-rotate] Failed to read accounts file:", error);
		return { accounts: [], version: 1 };
	}
}

function writeAccountsFile(store: CodexAccountsStore): void {
	const path = getAccountsPath();
	writeFileSync(path, JSON.stringify(store, null, 2), "utf-8");
	chmodSync(path, 0o600);
}

/**
 * Get all accounts from the store
 */
export function getAllAccounts(): CodexAccount[] {
	const store = ensureAccountsFile();
	return store.accounts;
}

/**
 * Get an account by ID
 */
export function getAccountById(id: string): CodexAccount | undefined {
	const accounts = getAllAccounts();
	return accounts.find((acc) => acc.id === id);
}

/**
 * Get an account by email
 */
export function getAccountByEmail(email: string): CodexAccount | undefined {
	const accounts = getAllAccounts();
	return accounts.find((acc) => acc.email === email);
}

/**
 * Add a new account to the store
 */
export function addAccount(account: Omit<CodexAccount, "id" | "addedAt">): CodexAccount {
	const store = ensureAccountsFile();
	const newAccount: CodexAccount = {
		...account,
		id: `acc_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
		addedAt: Date.now(),
	};
	store.accounts.push(newAccount);
	writeAccountsFile(store);
	return newAccount;
}

/**
 * Update an account in the store
 */
export function updateAccount(id: string, updates: Partial<CodexAccount>): CodexAccount | null {
	const store = ensureAccountsFile();
	const index = store.accounts.findIndex((acc) => acc.id === id);
	if (index === -1) return null;

	store.accounts[index] = { ...store.accounts[index], ...updates };
	writeAccountsFile(store);
	return store.accounts[index];
}

/**
 * Remove an account from the store
 */
export function removeAccount(id: string): boolean {
	const store = ensureAccountsFile();
	const index = store.accounts.findIndex((acc) => acc.id === id);
	if (index === -1) return false;

	store.accounts.splice(index, 1);
	writeAccountsFile(store);
	return true;
}

/**
 * Get active (non-disabled) accounts
 */
export function getActiveAccounts(): CodexAccount[] {
	return getAllAccounts().filter((acc) => !acc.disabled);
}

/**
 * Get accounts that need refresh (expiring soon)
 */
export function getAccountsNeedingRefresh(): CodexAccount[] {
	const now = Date.now();
	const threshold = now + REFRESH_BEFORE_EXPIRY_MS;
	return getActiveAccounts().filter((acc) => acc.expiresAt < threshold);
}

/**
 * Update the last used timestamp for an account
 */
export function markAccountUsed(accountId: string): void {
	updateAccount(accountId, { lastUsed: Date.now() });
}
