import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { SettingsManager } from "./settings-manager.js";

describe("SettingsManager fastMode", () => {
	it("defaults fastMode to false", () => {
		const manager = SettingsManager.inMemory();
		assert.equal(manager.getFastMode(), false);
	});

	it("persists fastMode changes to settings.json", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-fast-mode-settings-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");

		try {
			const manager = SettingsManager.create(cwd, agentDir);
			assert.equal(manager.getFastMode(), false);

			manager.setFastMode(true);
			await manager.flush();

			const rawEnabled = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
				fastMode?: boolean;
			};
			assert.equal(rawEnabled.fastMode, true);

			const reloaded = SettingsManager.create(cwd, agentDir);
			assert.equal(reloaded.getFastMode(), true);

			reloaded.setFastMode(false);
			await reloaded.flush();

			const rawDisabled = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
				fastMode?: boolean;
			};
			assert.equal(rawDisabled.fastMode, false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
