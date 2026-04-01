/**
 * Error detection and backoff integration for Codex OAuth rotation
 */

import type { CodexErrorType } from "./types.js";
import { QUOTA_ERROR_PATTERNS, AUTH_ERROR_PATTERNS } from "./config.js";

/**
 * Detect if an error is a quota/rate limit error
 */
export function isQuotaError(errorMessage: string): boolean {
	const lower = errorMessage.toLowerCase();
	return QUOTA_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Detect if an error is an auth error (401, invalid token, etc.)
 */
export function isAuthError(errorMessage: string): boolean {
	const lower = errorMessage.toLowerCase();
	return AUTH_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Classify an error message into an error type
 */
export function classifyError(errorMessage: string): CodexErrorType {
	if (isQuotaError(errorMessage)) {
		return errorMessage.toLowerCase().includes("rate limit") || errorMessage.includes("429")
			? "rate_limit"
			: "quota_exhausted";
	}
	if (isAuthError(errorMessage)) {
		return "auth_error";
	}
	return "unknown";
}

/**
 * Extract error information from an agent response
 */
export function extractErrorFromResponse(response: any): string | null {
	if (!response) return null;

	// Check for error in content
	if (response.content) {
		const content = Array.isArray(response.content) ? response.content : [response.content];
		for (const item of content) {
			if (item.type === "text" && typeof item.text === "string") {
				const text = item.text;
				// Look for common error indicators
				if (text.includes("error") || text.includes("Error") || text.includes("failed")) {
					return text;
				}
			}
		}
	}

	// Check for error metadata
	if (response.error) {
		return typeof response.error === "string" ? response.error : JSON.stringify(response.error);
	}

	if (response.errorMessage) {
		return response.errorMessage;
	}

	// Check for HTTP status
	if (response.status && response.status >= 400) {
		return `HTTP ${response.status}${response.statusText ? `: ${response.statusText}` : ""}`;
	}

	return null;
}

/**
 * Get the AuthStorage instance for marking usage limits
 */
function getAuthStorage() {
	// Dynamic import to avoid top-level dependencies
	const { AuthStorage } = require("@gsd/pi-coding-agent/dist/core/auth-storage.js");
	return new AuthStorage();
}

/**
 * Mark a credential as rate-limited/quota exhausted
 *
 * This should be called when we detect a quota/rate limit error in the agent response.
 * It will back off the credential and LSD will automatically rotate to the next one.
 */
export function markCredentialBackoff(
	provider: string,
	sessionId: string,
	errorType: CodexErrorType,
): boolean {
	try {
		const authStorage = getAuthStorage();

		// Map CodexErrorType to AuthStorage error type
		const authErrorType =
			errorType === "rate_limit"
				? "rate_limit"
				: errorType === "quota_exhausted"
					? "quota_exhausted"
					: errorType === "auth_error"
						? "rate_limit" // Treat auth errors as rate limits for immediate rotation
						: "unknown";

		const anotherAvailable = authStorage.markUsageLimitReached(provider, sessionId, {
			errorType: authErrorType,
		});

		return anotherAvailable;
	} catch (error) {
		console.error("[codex-rotate] Failed to mark credential backoff:", error);
		return false;
	}
}

/**
 * Check if an error message indicates the last response failed due to quota/auth
 */
export function shouldBackoffCredential(errorMessage: string): boolean {
	const errorType = classifyError(errorMessage);
	return errorType === "rate_limit" || errorType === "quota_exhausted" || errorType === "auth_error";
}
