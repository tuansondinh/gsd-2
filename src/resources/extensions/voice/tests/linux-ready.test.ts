/**
 * linux-ready.test.ts — Tests for Linux voice readiness logic (#2403).
 *
 * Covers:
 *   - diagnoseSounddeviceError branch ordering (ModuleNotFoundError must NOT
 *     match the portaudio branch, even though it contains "sounddevice")
 *   - ensureVoiceVenv auto-creation
 *   - linuxPython venv detection
 */

import { diagnoseSounddeviceError, ensureVoiceVenv } from "../linux-ready.ts";

function createTestContext() {
	let passed = 0;
	let failed = 0;

	function assertEq<T>(actual: T, expected: T, message: string): void {
		if (JSON.stringify(actual) === JSON.stringify(expected)) {
			passed++;
		} else {
			failed++;
			console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
		}
	}

	function assertTrue(condition: boolean, message: string): void {
		if (condition) {
			passed++;
		} else {
			failed++;
			console.error(`  FAIL: ${message}`);
		}
	}

	function report(): void {
		console.log(`\nResults: ${passed} passed, ${failed} failed`);
		if (failed > 0) {
			process.exit(1);
		} else {
			console.log("All tests passed");
		}
	}

	return { assertEq, assertTrue, report };
}

const { assertEq, assertTrue, report } = createTestContext();

function main(): void {
	// ── diagnoseSounddeviceError ──────────────────────────────────────────

	// The critical regression: "ModuleNotFoundError: No module named 'sounddevice'"
	// contains the word "sounddevice", so the old code matched the portaudio branch.
	console.log("\n=== diagnoseSounddeviceError: ModuleNotFoundError must return missing-module ===");
	{
		const stderr = "Traceback (most recent call last):\n  File \"<string>\", line 1, in <module>\nModuleNotFoundError: No module named 'sounddevice'";
		assertEq(diagnoseSounddeviceError(stderr), "missing-module",
			"ModuleNotFoundError for sounddevice should be 'missing-module', not 'missing-portaudio'");
	}

	console.log("\n=== diagnoseSounddeviceError: 'No module named sounddevice' variant ===");
	{
		const stderr = "ImportError: No module named sounddevice";
		assertEq(diagnoseSounddeviceError(stderr), "missing-module",
			"'No module' substring should return missing-module");
	}

	console.log("\n=== diagnoseSounddeviceError: actual portaudio error ===");
	{
		const stderr = "OSError: PortAudio library not found";
		assertEq(diagnoseSounddeviceError(stderr), "missing-portaudio",
			"PortAudio library error should return missing-portaudio");
	}

	console.log("\n=== diagnoseSounddeviceError: lowercase portaudio error ===");
	{
		const stderr = "OSError: libportaudio.so.2: cannot open shared object file: No such file or directory";
		assertEq(diagnoseSounddeviceError(stderr), "missing-portaudio",
			"lowercase portaudio error should return missing-portaudio");
	}

	console.log("\n=== diagnoseSounddeviceError: unrelated error ===");
	{
		const stderr = "SyntaxError: invalid syntax";
		assertEq(diagnoseSounddeviceError(stderr), "unknown",
			"unrelated error should return unknown");
	}

	console.log("\n=== diagnoseSounddeviceError: empty stderr ===");
	{
		assertEq(diagnoseSounddeviceError(""), "unknown",
			"empty stderr should return unknown");
	}

	// ── ensureVoiceVenv ──────────────────────────────────────────────────

	console.log("\n=== ensureVoiceVenv: returns true when venv already exists ===");
	{
		const notifications: string[] = [];
		const result = ensureVoiceVenv({
			notify: (msg) => notifications.push(msg),
			exists: () => true,
			execFile: (() => Buffer.from("")) as any,
		});
		assertTrue(result, "should return true when venv exists");
		assertEq(notifications.length, 0, "should not notify when venv exists");
	}

	console.log("\n=== ensureVoiceVenv: creates venv when missing ===");
	{
		const notifications: string[] = [];
		const commands: string[][] = [];
		let existsCalled = false;

		const result = ensureVoiceVenv({
			notify: (msg) => notifications.push(msg),
			exists: () => { existsCalled = true; return false; },
			execFile: ((cmd: string, args: string[]) => {
				commands.push([cmd, ...args]);
				return Buffer.from("");
			}) as any,
		});

		assertTrue(result, "should return true after venv creation");
		assertTrue(existsCalled, "should check if venv exists");
		assertEq(commands.length, 2, "should run 2 commands (venv + pip)");
		assertTrue(commands[0][0] === "python3", "first command is python3");
		assertTrue(commands[0].includes("-m") && commands[0].includes("venv"),
			"first command creates venv");
		assertTrue(commands[1][0].endsWith("bin/pip"), "second command is pip");
		assertTrue(commands[1].includes("sounddevice"), "pip installs sounddevice");
		assertTrue(commands[1].includes("requests"), "pip installs requests");
		assertTrue(notifications[0].includes("one-time setup"),
			"notifies about one-time setup");
	}

	console.log("\n=== ensureVoiceVenv: returns false and notifies on failure ===");
	{
		const notifications: Array<{ msg: string; level: string }> = [];

		const result = ensureVoiceVenv({
			notify: (msg, level) => notifications.push({ msg, level }),
			exists: () => false,
			execFile: (() => { throw new Error("externally-managed-environment"); }) as any,
		});

		assertTrue(!result, "should return false on failure");
		const errorNotif = notifications.find(n => n.level === "error");
		assertTrue(errorNotif !== undefined, "should emit error notification");
		assertTrue(errorNotif!.msg.includes("python3 -m venv"),
			"error message should suggest manual venv creation");
	}

	report();
}

main();
