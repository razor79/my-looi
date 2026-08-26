export type FaceTapVoiceState =
  | "sleeping"
  | "attention"
  | "verifying"
  | "listening"
  | "processing"
  | "speaking";

export type FaceTapImmediateRoute =
  | "driving-stop"
  | "driving-session-exit"
  | "classic-interrupt"
  | "burst";

export function classifyFaceTapImmediateRoute(input: {
  motionActive: boolean;
  drivingSessionActive: boolean;
  conversationProcessing: boolean;
  conversationSpeaking: boolean;
  voiceState: FaceTapVoiceState;
}): FaceTapImmediateRoute {
  if (input.motionActive) return "driving-stop";
  if (input.drivingSessionActive) return "driving-session-exit";
  if (
    input.conversationProcessing ||
    input.conversationSpeaking ||
    input.voiceState === "processing" ||
    input.voiceState === "speaking" ||
    input.voiceState === "verifying"
  ) {
    return "classic-interrupt";
  }
  // `listening`/`attention` can be a speech-free fresh-launch/follow-up window.
  // Let the 280 ms burst discriminator decide: one tap continues Classic;
  // 2+/3+ taps ask VoicePerceiver to release only passive listening first.
  return "burst";
}
