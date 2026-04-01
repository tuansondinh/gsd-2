/**
 * Codex OAuth Rotation Extension
 *
 * Manages multiple ChatGPT/Codex OAuth accounts with automatic rotation
 * and background token refresh.
 */

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";
import { getAllAccounts, updateAccount, getAccountsNeedingRefresh } from "./accounts.js";
import { syncAccountsToAuth, removeCodexFromAuth } from "./sync.js";
import { registerCodexCommand } from "./commands.js";
import { markCredentialBackoff, extractErrorFromResponse, shouldBackoffCredential } from "./quota.js";
import { REFRESH_INTERVAL_MS, PROVIDER_NAME } from "./config.js";

let refreshTimer: NodeJS.Timeout | null = null;

/**
 * Refresh all accounts that need it
 */
async function refreshExpiringAccounts(): Promise<void> {
	try {
		const accountsNeedingRefresh = getAccountsNeedingRefresh();

		if (accountsNeedingRefresh.length === 0) {
			return;
		}

		console.log(`[codex-rotate] Refreshing ${accountsNeedingRefresh.length} expiring account(s)`);

		const { refreshAccountToken } = await import("./oauth.js");
		let successCount = 0;
		let failCount = 0;

		for (const account of accountsNeedingRefresh) {
			try {
				const refreshed = await refreshAccountToken(account);
				updateAccount(account.id, refreshed);
				successCount++;
				console.log(`[codex-rotate] Refreshed account: ${account.email || account.accountId}`);
			} catch (error) {
				failCount++;
				console.error(`[codex-rotate] Failed to refresh account ${account.id}:`, error);
				// Disable the account if refresh fails
				updateAccount(account.id, {
					disabled: true,
					disabledReason: `Token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}

		if (successCount > 0) {
			// Sync refreshed accounts to auth.json
			const allAccounts = getAllAccounts();
			await syncAccountsToAuth(allAccounts);
			console.log(`[codex-rotate] Synced ${successCount} refreshed account(s) to auth.json`);
		}

		if (failCount > 0) {
			console.warn(`[codex-rotate] Failed to refresh ${failCount} account(s)`);
		}
	} catch (error) {
		console.error("[codex-rotate] Error in refresh task:", error);
	}
}

/**
 * Start the background refresh timer
 */
function startRefreshTimer(): void {
	if (refreshTimer) {
		clearInterval(refreshTimer);
	}

	refreshTimer = setInterval(() => {
		void refreshExpiringAccounts();
	}, REFRESH_INTERVAL_MS);

	console.log(`[codex-rotate] Background refresh timer started (interval: ${REFRESH_INTERVAL_MS / 1000 / 60}m)`);
}

/**
 * Stop the background refresh timer
 */
function stopRefreshTimer(): void {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
		console.log("[codex-rotate] Background refresh timer stopped");
	}
}

/**
 * Main extension entry point
 */
export default function CodexRotateExtension(pi: ExtensionAPI) {
	console.log("[codex-rotate] Initializing Codex OAuth rotation extension");

	// Register commands
	registerCodexCommand(pi);

	// Session start hook
	pi.on("session_start", async (_event, ctx) => {
		console.log("[codex-rotate] Session started");

		const accounts = getAllAccounts();

		if (accounts.length === 0) {
			console.log("[codex-rotate] No accounts configured, extension ready but inactive");
			return;
		}

		console.log(`[codex-rotate] Found ${accounts.length} account(s)`);

		// Refresh any expiring accounts immediately
		await refreshExpiringAccounts();

		// Sync to auth.json
		await syncAccountsToAuth(getAllAccounts());

		// Start background refresh timer
		startRefreshTimer();
	});

	// Session shutdown hook
	pi.on("session_shutdown", () => {
		console.log("[codex-rotate] Session shutting down");
		stopRefreshTimer();
	});

	// Agent end hook - detect quota/auth errors and backoff credentials
	pi.on("agent_end", async (event, ctx) => {
		try {
			const response = event.response;
			if (!response) return;

			// Extract error from response
			const errorMessage = extractErrorFromResponse(response);
			if (!errorMessage) return;

			// Check if we should backoff
			if (!shouldBackoffCredential(errorMessage)) return;

			console.log(`[codex-rotate] Detected credential error: ${errorMessage}`);

			// Get session ID if available
			const sessionId = ctx.sessionId;

			// Mark credential as backed off
			const anotherAvailable = markCredentialBackoff(PROVIDER_NAME, sessionId, "rate_limit");

			if (anotherAvailable) {
				ctx.ui.notify("Codex credential backed off, rotating to next account", "info");
			} else {
				ctx.ui.notify("All Codex credentials are backed off. Please wait before retrying.", "warning");
			}
		} catch (error) {
			console.error("[codex-rotate] Error in agent_end handler:", error);
		}
	});
}
