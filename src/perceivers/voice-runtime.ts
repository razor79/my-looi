import { BasePerceiver } from "../core/perceiver";
import { getRuntimeProfile } from "../core/runtime-profile";
import { isRealtimeConversationMode, useUserStore } from "../store/user";
import { getVoiceModule } from "../voice/lazy-services";

/**
 * Lightweight voice runtime facade. It keeps cold start free of Sherpa,
 * AudioStudio, and expo-audio until voice is explicitly needed.
 */
export class VoiceRuntime extends BasePerceiver {
  name = "voice";
  private loaded = false;
  private unsubscribeVoice: (() => void) | null = null;
  private mainScreenTransitionQueue: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    if (this.isActive) {
      await this.sync();
      return;
    }
    this.isActive = true;

    const prefs = useUserStore.getState().preferences;
    if (!getRuntimeProfile().allowsWakewordAutostart || !prefs.wakeWordEnabled) {
      return;
    }

    await this.ensureLoaded();
    const { voicePerceiver } = await getVoiceModule();
    await voicePerceiver.start();
  }

  async sync(): Promise<void> {
    if (!this.isActive) return;
    const prefs = useUserStore.getState().preferences;
    if (!getRuntimeProfile().allowsWakewordAutostart || !prefs.wakeWordEnabled) {
      if (!this.loaded) return;
      const { voicePerceiver } = await getVoiceModule();
      await voicePerceiver.syncWakewordRuntime();
      return;
    }

    await this.ensureLoaded();
    const { voicePerceiver } = await getVoiceModule();
    await voicePerceiver.start();
    await voicePerceiver.syncConversationMode();
    await voicePerceiver.syncWakewordRuntime();
  }

  async rearmWakewordAfterNavigation(): Promise<void> {
    if (!this.isActive || useUserStore.getState().robotSleeping) return;
    await this.ensureLoaded();
    const { voicePerceiver } = await getVoiceModule();
    await voicePerceiver.start();
    await voicePerceiver.rearmWakewordAfterNavigation();
  }

  async suspendMainScreenConversation(reason = "main-screen-blur"): Promise<void> {
    return this.enqueueMainScreenTransition(async () => {
      if (!this.loaded) return;
      const { realtimeConversationService } = await import("../voice/realtime-conversation");
      if (!realtimeConversationService.isActive) return;
      await realtimeConversationService.stop(reason);
    });
  }

  async resumeMainScreenConversation(
    source: "navigation-return" | "foreground-resume"
  ): Promise<void> {
    return this.enqueueMainScreenTransition(async () => {
      if (!this.isActive || useUserStore.getState().robotSleeping) return;
      await this.ensureLoaded();
      const { voicePerceiver } = await getVoiceModule();
      await voicePerceiver.start();

      const { realtimeConversationService } = await import("../voice/realtime-conversation");
      if (realtimeConversationService.isActive) {
        const { recordDiagnosticEvent } = await import("../diagnostics/diagnostic-log");
        recordDiagnosticEvent("navigation", "main-return-auto-listen-skipped", {
          source,
          reason: "realtime-already-active",
        });
        return;
      }

      const conversation = (await import("../store/conversation")).useConversationStore.getState();
      const voiceState = useUserStore.getState().voiceState;
      if (
        conversation.isListening ||
        conversation.isProcessing ||
        conversation.isSpeaking ||
        voiceState === "processing" ||
        voiceState === "speaking" ||
        voiceState === "verifying"
      ) {
        const { recordDiagnosticEvent } = await import("../diagnostics/diagnostic-log");
        recordDiagnosticEvent("navigation", "main-return-auto-listen-skipped", {
          source,
          reason: "conversation-busy",
          voiceState,
          listening: conversation.isListening,
          processing: conversation.isProcessing,
          speaking: conversation.isSpeaking,
        });
        return;
      }

      const { recordDiagnosticEvent } = await import("../diagnostics/diagnostic-log");
      const conversationMode = useUserStore.getState().preferences.conversationMode;
      recordDiagnosticEvent("navigation", "main-return-auto-listen", {
        source,
        conversationMode,
        realtimeEntryPreparation: isRealtimeConversationMode(conversationMode) ? "pcm-stability-gate" : "n/a",
      });
      if (isRealtimeConversationMode(conversationMode)) {
        await voicePerceiver.resumeRealtimeConversationFromMain(source);
        return;
      }
      await voicePerceiver.trigger();
    });
  }

  async stop(): Promise<void> {
    this.isActive = false;
    if (!this.loaded) return;

    const { voicePerceiver } = await getVoiceModule();
    await voicePerceiver.stop();
  }

  async trigger(): Promise<void> {
    await this.ensureLoaded();
    const { voicePerceiver } = await getVoiceModule();
    await voicePerceiver.start();
    await voicePerceiver.trigger();
  }

  async interruptAndListen(): Promise<void> {
    await this.ensureLoaded();
    const { voicePerceiver } = await getVoiceModule();
    await voicePerceiver.start();
    await voicePerceiver.interruptAndListen("tap");
  }

  async applyLiveRealtimePreferences(source: string): Promise<boolean> {
    const { realtimeConversationService } = await import("../voice/realtime-conversation");
    if (!realtimeConversationService.isActive) return false;
    realtimeConversationService.applySessionPreferences(source);
    return true;
  }

  async prepareIdleCharacterReaction(): Promise<{ ok: boolean; reason: string }> {
    await this.ensureLoaded();
    const { voicePerceiver } = await getVoiceModule();
    await voicePerceiver.start();
    return voicePerceiver.prepareIdleCharacterReaction();
  }

  async finishListening(): Promise<void> {
    if (!this.loaded) return;

    const { voicePerceiver } = await getVoiceModule();
    await voicePerceiver.finishListening();
  }

  private enqueueMainScreenTransition(task: () => Promise<void>): Promise<void> {
    const queued = this.mainScreenTransitionQueue.then(task, task);
    this.mainScreenTransitionQueue = queued.catch(() => undefined);
    return queued;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const { voicePerceiver } = await getVoiceModule();
    this.unsubscribeVoice = voicePerceiver.onObservation((observation) => {
      this.emit(observation);
    });
  }
}

export const voiceRuntime = new VoiceRuntime();
