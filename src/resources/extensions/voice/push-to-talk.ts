import { isKeyRelease, Key, matchesKey } from "@gsd/pi-tui";
import type { TerminalInputHandler } from "@gsd/pi-coding-agent";

export type VoiceActivationMode = "toggle" | "push-to-talk";

export interface PushToTalkState {
    active: boolean;
    activationMode: VoiceActivationMode | null;
    editorText: string;
    holdToTalkSupported: boolean;
    onUnsupported?(): void;
    startPushToTalk(): void | Promise<void>;
    stopVoice(): void | Promise<void>;
}

export function handlePushToTalkInput(data: string, state: PushToTalkState): ReturnType<TerminalInputHandler> {
    if (!matchesKey(data, Key.space)) return undefined;

    if (isKeyRelease(data)) {
        if (state.activationMode === "push-to-talk") {
            void Promise.resolve(state.stopVoice());
            return { consume: true };
        }
        return undefined;
    }

    if (state.activationMode === "push-to-talk") {
        // Consume repeat events while the key is held so we do not leak spaces.
        return { consume: true };
    }

    if (state.active) return undefined;
    if (state.editorText.length > 0) return undefined;

    if (!state.holdToTalkSupported) {
        state.onUnsupported?.();
        return { consume: true };
    }

    void Promise.resolve(state.startPushToTalk());
    return { consume: true };
}
