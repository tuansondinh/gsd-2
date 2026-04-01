import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { CompactionOrchestrator, type CompactionOrchestratorDeps } from "./compaction-orchestrator.js";
import { AgentSession } from "./agent-session.js";

function createDeps(): CompactionOrchestratorDeps {
	return {
		agent: {
			state: { messages: [] },
			hasQueuedMessages: () => false,
			replaceMessages: () => {},
			continue: async () => {},
		} as any,
		sessionManager: {} as any,
		settingsManager: {
			getCompactionEnabled: () => true,
			getCompactionSettings: () => ({ enabled: true, reserveTokens: 1000, keepRecentTokens: 1000, thresholdPercent: 85 }),
		} as any,
		modelRegistry: {} as any,
		getModel: () => undefined,
		getSessionId: () => "test-session",
		getExtensionRunner: () => undefined,
		emit: () => {},
		disconnectFromAgent: () => {},
		reconnectToAgent: () => {},
		abort: async () => {},
	};
}

describe("CompactionOrchestrator auto-compaction continuation", () => {
	it("keeps waitForAutoCompaction pending until scheduled auto-continue settles", async () => {
		const orchestrator = new CompactionOrchestrator(createDeps());
		orchestrator.createAutoCompactionPromiseForAgentEnd([{ role: "assistant" } as any]);

		let resolved = false;
		const waitPromise = orchestrator.waitForAutoCompaction().then(() => {
			resolved = true;
		});

		(orchestrator as any)._pendingAutoContinues = 1;
		(orchestrator as any)._resolveAutoCompaction();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(resolved, false, "auto-compaction wait resolved before pending continue finished");

		(orchestrator as any)._pendingAutoContinues = 0;
		(orchestrator as any)._resolveAutoCompaction();
		await waitPromise;
		assert.equal(resolved, true);
	});

	it("AgentSession waits for auto-compaction follow-ups before finishing a prompt", async () => {
		let releaseCompaction!: () => void;
		const compactionDone = new Promise<void>((resolve) => {
			releaseCompaction = resolve;
		});

		const fakeSession = {
			_retryHandler: {
				isRetrying: false,
				waitForRetry: mock.fn(async () => {}),
			},
			_compactionOrchestrator: {
				hasPendingAutoCompaction: true,
				waitForAutoCompaction: mock.fn(async () => {
					await compactionDone;
					(fakeSession._compactionOrchestrator as any).hasPendingAutoCompaction = false;
				}),
			},
		};

		let resolved = false;
		const waitPromise = (AgentSession.prototype as any)._waitForAutomatedFollowUps.call(fakeSession).then(() => {
			resolved = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(resolved, false, "session finished before auto-compaction follow-up completed");

		releaseCompaction();
		await waitPromise;

		assert.equal(resolved, true);
		assert.equal(fakeSession._retryHandler.waitForRetry.mock.calls.length, 1);
		assert.equal(fakeSession._compactionOrchestrator.waitForAutoCompaction.mock.calls.length, 1);
	});
});
