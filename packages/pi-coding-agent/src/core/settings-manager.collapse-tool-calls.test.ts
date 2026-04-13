import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { SettingsManager } from "./settings-manager.js";

describe("SettingsManager collapseToolCalls", () => {
	it("defaults collapseToolCalls to false", () => {
		const manager = SettingsManager.inMemory();
		assert.equal(manager.getCollapseToolCalls(), false);
	});

	it("persists collapseToolCalls changes to settings.json", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-collapse-tool-calls-settings-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");

		try {
			const manager = SettingsManager.create(cwd, agentDir);
			assert.equal(manager.getCollapseToolCalls(), false);

			manager.setCollapseToolCalls(true);
			await manager.flush();

			const rawEnabled = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
				collapseToolCalls?: boolean;
			};
			assert.equal(rawEnabled.collapseToolCalls, true);

			const reloaded = SettingsManager.create(cwd, agentDir);
			assert.equal(reloaded.getCollapseToolCalls(), true);

			reloaded.setCollapseToolCalls(false);
			await reloaded.flush();

			const rawDisabled = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
				collapseToolCalls?: boolean;
			};
			assert.equal(rawDisabled.collapseToolCalls, false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
