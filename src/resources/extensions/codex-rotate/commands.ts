/**
 * /codex slash command handlers
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import type { CodexAccount } from "./types.js";
import {
	addAccount,
	getAccountByEmail,
	getAccountById,
	getAllAccounts,
	removeAccount,
	updateAccount,
	markAccountUsed,
} from "./accounts.js";
import { performOAuthLogin, refreshAccountToken, importFromExistingCodexAuth, importFromCockpit } from "./oauth.js";
import { syncAccountsToAuth, removeCodexFromAuth } from "./sync.js";
import { PROVIDER_NAME } from "./config.js";

/**
 * Format a timestamp for display
 */
function formatTimestamp(timestamp?: number): string {
	if (!timestamp) return "never";
	const date = new Date(timestamp);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	return date.toLocaleDateString();
}

/**
 * Format expiry time for display
 */
function formatExpiry(expiresAt: number): string {
	const date = new Date(expiresAt);
	const now = new Date();
	const diffMs = date.getTime() - now.getTime();
	const diffMins = Math.floor(diffMs / 60000);

	if (diffMins < 0) return "expired";
	if (diffMins < 5) return "expires soon";
	if (diffMins < 60) return `${diffMins}m`;
	const diffHours = Math.floor(diffMins / 60);
	return `${diffHours}h`;
}

/**
 * Display list of accounts
 */
function displayAccounts(ctx: any, accounts: CodexAccount[]): void {
	if (accounts.length === 0) {
		ctx.ui.notify("No Codex accounts configured.", "info");
		return;
	}

	const lines: string[] = [];
	accounts.forEach((acc, index) => {
		const status = acc.disabled ? "✗" : "✓";
		const email = acc.email || acc.accountId;
		const lastUsed = acc.lastUsed ? formatTimestamp(acc.lastUsed) : "never";
		const expiry = formatExpiry(acc.expiresAt);

		lines.push(`${index + 1}. ${status} ${email}`);
		lines.push(`   Last used: ${lastUsed}, Token: ${expiry}`);
		if (acc.disabled && acc.disabledReason) {
			lines.push(`   Reason: ${acc.disabledReason}`);
		}
	});

	ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Register the /codex command
 */
export function registerCodexCommand(pi: ExtensionAPI): void {
	pi.registerCommand("codex", {
		description: "Manage Codex OAuth accounts: /codex [add|list|status|remove|enable|disable|import|import-cockpit|sync]",

		getArgumentCompletions: (prefix: string) => {
			const subcommands = [
				"add",
				"list",
				"status",
				"remove",
				"enable",
				"disable",
				"import",
				"import-cockpit",
				"sync",
			];
			const parts = prefix.trim().split(/\s+/);

			if (parts.length <= 1) {
				return subcommands
					.filter((cmd) => cmd.startsWith(parts[0] ?? ""))
					.map((cmd) => ({ value: cmd, label: cmd }));
			}

			// For remove/enable/disable, suggest account indices
			if (["remove", "enable", "disable"].includes(parts[0])) {
				const accounts = getAllAccounts();
				return accounts.map((acc, idx) => ({
					value: `${parts[0]} ${idx + 1}`,
					label: `${idx + 1} — ${acc.email || acc.accountId}`,
				}));
			}

			return [];
		},

		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "list";

			try {
				switch (sub) {
					case "add": {
						ctx.ui.notify("Starting OAuth login flow...", "info");
						const accountData = await performOAuthLogin();

						// Prompt for email (optional)
						const emailInput = await ctx.ui.input("Email for this account (optional, press Enter to skip)", "");
						const email = emailInput || undefined;

						const account = addAccount({
							...accountData,
							email,
							lastUsed: undefined,
							disabled: false,
						});

						// Sync to auth.json
						const success = await syncAccountsToAuth(getAllAccounts());
						if (success) {
							ctx.ui.notify(`Added account: ${email || account.accountId}. Synced to auth.json.`, "success");
						} else {
							ctx.ui.notify(`Added account: ${email || account.accountId}. Failed to sync to auth.json.`, "warning");
						}
						return;
					}

					case "list": {
						const accounts = getAllAccounts();
						displayAccounts(ctx, accounts);
						return;
					}

					case "status": {
						const accounts = getAllAccounts();
						const activeCount = accounts.filter((a) => !a.disabled).length;
						const disabledCount = accounts.length - activeCount;
						const expiringSoon = accounts.filter((a) => !a.disabled && a.expiresAt - Date.now() < 5 * 60 * 1000).length;

						const lines: string[] = [];
						lines.push(`Codex OAuth Rotation Status`);
						lines.push(`===========================`);
						lines.push(`Total accounts: ${accounts.length}`);
						lines.push(`Active: ${activeCount}, Disabled: ${disabledCount}`);
						lines.push(`Expiring soon: ${expiringSoon}`);

						if (accounts.length > 0) {
							lines.push(`\nAccounts:`);
							accounts.forEach((acc, index) => {
								const status = acc.disabled ? "✗" : "✓";
								const email = acc.email || acc.accountId;
								const expiry = formatExpiry(acc.expiresAt);
								lines.push(`  ${index + 1}. ${status} ${email} (${expiry})`);
							});
						}

						ctx.ui.notify(lines.join("\n"), "info");
						return;
					}

					case "remove": {
						const indexStr = parts[1];
						if (!indexStr) {
							ctx.ui.notify("Usage: /codex remove <index|email>", "error");
							return;
						}

						let account: CodexAccount | undefined;
						const index = parseInt(indexStr, 10);

						if (!isNaN(index) && index > 0 && index <= getAllAccounts().length) {
							account = getAllAccounts()[index - 1];
						} else {
							account = getAccountByEmail(indexStr) || getAccountById(indexStr);
						}

						if (!account) {
							ctx.ui.notify(`Account not found: ${indexStr}`, "error");
							return;
						}

						const confirmed = await ctx.ui.select(
							`Remove account: ${account.email || account.accountId}?`,
							["Yes, remove", "Cancel"],
							{ signal: AbortSignal.timeout(30000) },
						);

						if (confirmed === "Yes, remove") {
							removeAccount(account.id);
							await syncAccountsToAuth(getAllAccounts());
							ctx.ui.notify(`Removed account: ${account.email || account.accountId}`, "success");
						}
						return;
					}

					case "enable": {
						const indexStr = parts[1];
						if (!indexStr) {
							ctx.ui.notify("Usage: /codex enable <index|email>", "error");
							return;
						}

						let account: CodexAccount | undefined;
						const index = parseInt(indexStr, 10);

						if (!isNaN(index) && index > 0 && index <= getAllAccounts().length) {
							account = getAllAccounts()[index - 1];
						} else {
							account = getAccountByEmail(indexStr) || getAccountById(indexStr);
						}

						if (!account) {
							ctx.ui.notify(`Account not found: ${indexStr}`, "error");
							return;
						}

						updateAccount(account.id, { disabled: false, disabledReason: undefined });
						await syncAccountsToAuth(getAllAccounts());
						ctx.ui.notify(`Enabled account: ${account.email || account.accountId}`, "success");
						return;
					}

					case "disable": {
						const indexStr = parts[1];
						if (!indexStr) {
							ctx.ui.notify("Usage: /codex disable <index|email>", "error");
							return;
						}

						let account: CodexAccount | undefined;
						const index = parseInt(indexStr, 10);

						if (!isNaN(index) && index > 0 && index <= getAllAccounts().length) {
							account = getAllAccounts()[index - 1];
						} else {
							account = getAccountByEmail(indexStr) || getAccountById(indexStr);
						}

						if (!account) {
							ctx.ui.notify(`Account not found: ${indexStr}`, "error");
							return;
						}

						updateAccount(account.id, { disabled: true, disabledReason: "manually disabled" });
						await syncAccountsToAuth(getAllAccounts());
						ctx.ui.notify(`Disabled account: ${account.email || account.accountId}`, "success");
						return;
					}

					case "import": {
						ctx.ui.notify("Importing from ~/.codex/auth.json...", "info");
						const imported = await importFromExistingCodexAuth();

						if (!imported) {
							ctx.ui.notify("No account found to import.", "warning");
							return;
						}

						const account = addAccount({
							email: imported.email,
							accountId: imported.accountId,
							refreshToken: imported.refreshToken,
							accessToken: imported.accessToken,
							expiresAt: imported.expiresAt,
							lastUsed: undefined,
							disabled: false,
						});

						await syncAccountsToAuth(getAllAccounts());
						ctx.ui.notify(`Imported account: ${imported.email || imported.accountId}`, "success");
						return;
					}

					case "import-cockpit": {
						ctx.ui.notify("Importing from Cockpit Tools...", "info");
						const imported = await importFromCockpit();

						if (imported.length === 0) {
							ctx.ui.notify("No accounts found to import.", "warning");
							return;
						}

						for (const acc of imported) {
							addAccount(acc);
						}

						await syncAccountsToAuth(getAllAccounts());
						ctx.ui.notify(`Imported ${imported.length} account(s) from Cockpit Tools`, "success");
						return;
					}

					case "sync": {
						ctx.ui.notify("Refreshing all tokens and syncing to auth.json...", "info");

						const accounts = getAllAccounts();
						const results: { success: number; failed: number } = { success: 0, failed: 0 };

						for (const acc of accounts) {
							if (acc.disabled) continue;

							try {
								const refreshed = await refreshAccountToken(acc);
								updateAccount(acc.id, refreshed);
								results.success++;
							} catch (error) {
								console.error(`[codex-rotate] Failed to refresh ${acc.id}:`, error);
								results.failed++;
							}
						}

						await syncAccountsToAuth(getAllAccounts());

						if (results.failed === 0) {
							ctx.ui.notify(`Synced ${results.success} account(s) to auth.json`, "success");
						} else {
							ctx.ui.notify(`Synced ${results.success} account(s), ${results.failed} failed`, "warning");
						}
						return;
					}

					default:
						ctx.ui.notify(
							`Usage: /codex [add|list|status|remove|enable|disable|import|import-cockpit|sync]`,
							"info",
						);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Error: ${message}`, "error");
			}
		},
	});
}
