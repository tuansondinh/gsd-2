/**
 * Codex OAuth Rotation Extension
 *
 * Manages multiple ChatGPT/Codex OAuth accounts with automatic rotation
 * and background token refresh.
 */

import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { getAllAccounts, updateAccount, getAccountsNeedingRefresh } from "./accounts.js";
import { syncAccountsToAuth } from "./sync.js";
import { registerCodexCommand } from "./commands.js";
import { classifyError, markCredentialBackoff, shouldBackoffCredential } from "./quota.js";
import { REFRESH_INTERVAL_MS, PROVIDER_NAME } from "./config.js";
import { logCodexRotateError, logCodexRotateSwitch } from "./logger.js";

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

		const { refreshAccountToken } = await import("./oauth.js");
		let successCount = 0;
		let failCount = 0;

		for (const account of accountsNeedingRefresh) {
			try {
				const refreshed = await refreshAccountToken(account);
				updateAccount(account.id, refreshed);
				successCount++;
			} catch (error) {
				failCount++;
				logCodexRotateError(`Failed to refresh account ${account.id}:`, error);
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
		}

		if (failCount > 0 && successCount === 0) {
			logCodexRotateError(`Failed to refresh ${failCount} account(s)`);
		}
	} catch (error) {
		logCodexRotateError("Error in refresh task:", error);
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
}

/**
 * Stop the background refresh timer
 */
function stopRefreshTimer(): void {
	if (refreshTimer) {
		clearInterval(refreshTimer);
		refreshTimer = null;
	}
}

/**
 * Main extension entry point
 */
export default function CodexRotateExtension(pi: ExtensionAPI) {

	// Register commands
	registerCodexCommand(pi);

	// Session start hook
	pi.on("session_start", async (_event) => {
		const accounts = getAllAccounts();

		if (accounts.length === 0) {
			return;
		}

		// Refresh any expiring accounts immediately
		await refreshExpiringAccounts();

		// Sync to auth.json
		await syncAccountsToAuth(getAllAccounts());

		// Start background refresh timer
		startRefreshTimer();
	});

	// Session shutdown hook
	pi.on("session_shutdown", () => {
		stopRefreshTimer();
	});

	// Agent end hook - detect quota/auth errors and backoff credentials
	pi.on("agent_end", async (event, ctx) => {
		try {
			const messages = event.messages;
			const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
			if (!lastAssistant || !("errorMessage" in lastAssistant) || !lastAssistant.errorMessage) return;

			const errorMessage = lastAssistant.errorMessage;
			if (!shouldBackoffCredential(errorMessage)) return;

			const errorType = classifyError(errorMessage);
			const sessionId = ctx.sessionManager.getSessionId();
			const anotherAvailable = markCredentialBackoff(PROVIDER_NAME, sessionId, errorType);

			if (anotherAvailable) {
				logCodexRotateSwitch(`Auto-switched account after ${errorType} error`);
				ctx.ui.notify("Codex credential backed off, rotating to next account", "info");
			} else {
				logCodexRotateError(`All accounts backed off after ${errorType} error`);
				ctx.ui.notify("All Codex credentials are backed off. Please wait before retrying.", "warning");
			}
		} catch (error) {
			logCodexRotateError("Error in agent_end handler:", error);
		}
	});
}
