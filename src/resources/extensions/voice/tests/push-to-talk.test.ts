import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { handlePushToTalkInput } from "../push-to-talk.js";

const SPACE_RELEASE = "\x1b[32;1:3u";

describe("voice push-to-talk handler", () => {
    it("starts push-to-talk on Space when editor is empty and release support is available", () => {
        let startCalls = 0;
        let stopCalls = 0;

        const result = handlePushToTalkInput(" ", {
            active: false,
            activationMode: null,
            editorText: "",
            holdToTalkSupported: true,
            startPushToTalk: () => { startCalls += 1; },
            stopVoice: () => { stopCalls += 1; },
        });

        assert.deepEqual(result, { consume: true });
        assert.equal(startCalls, 1);
        assert.equal(stopCalls, 0);
    });

    it("does not start push-to-talk when the editor already contains text", () => {
        let startCalls = 0;

        const result = handlePushToTalkInput(" ", {
            active: false,
            activationMode: null,
            editorText: "hello",
            holdToTalkSupported: true,
            startPushToTalk: () => { startCalls += 1; },
            stopVoice: () => { },
        });

        assert.equal(result, undefined);
        assert.equal(startCalls, 0);
    });

    it("consumes repeated Space press events while push-to-talk is already active", () => {
        let startCalls = 0;

        const result = handlePushToTalkInput(" ", {
            active: true,
            activationMode: "push-to-talk",
            editorText: "",
            holdToTalkSupported: true,
            startPushToTalk: () => { startCalls += 1; },
            stopVoice: () => { },
        });

        assert.deepEqual(result, { consume: true });
        assert.equal(startCalls, 0);
    });

    it("stops push-to-talk on Space release", () => {
        let stopCalls = 0;

        const result = handlePushToTalkInput(SPACE_RELEASE, {
            active: true,
            activationMode: "push-to-talk",
            editorText: "",
            holdToTalkSupported: true,
            startPushToTalk: () => { },
            stopVoice: () => { stopCalls += 1; },
        });

        assert.deepEqual(result, { consume: true });
        assert.equal(stopCalls, 1);
    });

    it("does not stop manually toggled voice mode on Space release", () => {
        let stopCalls = 0;

        const result = handlePushToTalkInput(SPACE_RELEASE, {
            active: true,
            activationMode: "toggle",
            editorText: "",
            holdToTalkSupported: true,
            startPushToTalk: () => { },
            stopVoice: () => { stopCalls += 1; },
        });

        assert.equal(result, undefined);
        assert.equal(stopCalls, 0);
    });

    it("consumes Space and notifies once when hold-to-talk is unsupported", () => {
        let notifyCalls = 0;
        let startCalls = 0;

        const result = handlePushToTalkInput(" ", {
            active: false,
            activationMode: null,
            editorText: "",
            holdToTalkSupported: false,
            onUnsupported: () => { notifyCalls += 1; },
            startPushToTalk: () => { startCalls += 1; },
            stopVoice: () => { },
        });

        assert.deepEqual(result, { consume: true });
        assert.equal(notifyCalls, 1);
        assert.equal(startCalls, 0);
    });
});
