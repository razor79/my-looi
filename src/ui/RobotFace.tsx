import { useEffect, useMemo, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { isRealtimeConversationMode, useUserStore, type VoiceState } from "@/src/store/user";
import { useConversationStore } from "@/src/store/conversation";
import { looiTheme } from "@/src/ui/looi-theme";
import { useUiText } from "@/src/i18n/use-ui-text";
import { useCharacterReactionStore, type CharacterMood } from "@/src/character/character-reaction";
import { recordDiagnosticEvent } from "@/src/diagnostics/diagnostic-log";

type RobotFaceMode = "fullscreen" | "avatar";

type RobotFaceProps = {
  mode?: RobotFaceMode;
  onPress?: () => void;
  onLongPress?: () => void;
  labelVisible?: boolean;
};

type FaceMood = "neutral" | "happy" | "excited" | "curious" | "concerned";
type MouthShape = "none" | "line" | "smile";

type FaceVisual = {
  leftEyeScaleX: number;
  leftEyeScaleY: number;
  rightEyeScaleX: number;
  rightEyeScaleY: number;
  leftEyeOffsetY: number;
  rightEyeOffsetY: number;
  leftEyeRotation: number;
  rightEyeRotation: number;
  mouth: MouthShape;
  mouthWidth: number;
};

const EYE_COLOR = "#54DCF2";
const EYE_SHADOW_COLOR = "#4050E8";

export function RobotFace({
  mode = "fullscreen",
  onPress,
  onLongPress,
  labelVisible = mode === "fullscreen",
}: RobotFaceProps) {
  const voiceState = useUserStore((state) => state.voiceState);
  const streamingText = useConversationStore((state) => state.streamingText);
  const realtimeReadiness = useConversationStore((state) => state.realtimeReadiness);
  const conversationMode = useUserStore((state) => state.preferences.conversationMode);
  const characterMood = useCharacterReactionStore((state) => state.mood);
  const { t } = useUiText();
  const characterReactionId = useCharacterReactionStore((state) => state.reactionId);
  const blink = useSharedValue(1);
  const gaze = useSharedValue(0);
  const breathe = useSharedValue(0);
  const mouthPulse = useSharedValue(0);
  const longPressFired = useRef(false);
  const isAvatar = mode === "avatar";
  const statusLabel = isRealtimeConversationMode(conversationMode)
    ? voiceState === "speaking"
      ? t("face.speaking")
      : voiceState === "processing"
        ? t("face.thinking")
        : realtimeReadiness === "preparing-microphone"
          ? t("overlay.preparingMic")
          : realtimeReadiness === "connecting"
            ? t("overlay.connecting")
            : realtimeReadiness === "ready"
              ? t("overlay.readyListening")
              : realtimeReadiness === "microphone-error"
                ? t("overlay.micNotReady")
                : realtimeReadiness === "error"
                  ? t("overlay.noConnection")
                  : t("face.tapToStart")
    : voiceState === "sleeping"
      ? t("face.ready")
      : voiceState === "attention"
        ? t("face.here")
        : voiceState === "listening"
          ? t("face.listening")
          : voiceState === "processing"
            ? t("face.thinking")
            : voiceState === "speaking"
              ? t("face.speaking")
              : t("face.verifying");
  const characterReactionVisible = Boolean(characterMood) && (
    voiceState === "sleeping" ||
    (isRealtimeConversationMode(conversationMode) && voiceState === "listening")
  );
  const face = useMemo(
    () => getFaceForState(voiceState, streamingText, characterReactionVisible ? characterMood : null),
    [characterMood, characterReactionVisible, streamingText, voiceState]
  );

  useEffect(() => {
    if (!characterMood) return;
    recordDiagnosticEvent("character", "reaction-render-state", {
      mood: characterMood,
      reactionId: characterReactionId,
      voiceState,
      conversationMode,
      visible: characterReactionVisible,
    });
  }, [characterMood, characterReactionId, characterReactionVisible, conversationMode, voiceState]);

  useEffect(() => {
    const runBlink = () => {
      blink.value = withSequence(
        withTiming(0.08, { duration: 75 }),
        withTiming(1, { duration: 120 })
      );
    };
    const interval = voiceState === "processing" ? 2900 : 4300;
    const timer = setInterval(runBlink, interval);
    return () => {
      clearInterval(timer);
      cancelAnimation(blink);
    };
  }, [blink, voiceState]);

  useEffect(() => {
    cancelAnimation(gaze);
    if (voiceState === "processing") {
      gaze.value = withRepeat(
        withSequence(withTiming(-1, { duration: 850 }), withTiming(1, { duration: 1000 })),
        -1,
        true
      );
    } else if (voiceState === "sleeping") {
      gaze.value = withRepeat(
        withSequence(withTiming(-0.45, { duration: 3000 }), withTiming(0.45, { duration: 3400 })),
        -1,
        true
      );
    } else {
      gaze.value = withTiming(0, { duration: 180 });
    }
    return () => cancelAnimation(gaze);
  }, [gaze, voiceState]);

  useEffect(() => {
    const duration = voiceState === "speaking" ? 520 : voiceState === "listening" ? 760 : 1700;
    breathe.value = withRepeat(
      withSequence(withTiming(1, { duration }), withTiming(0, { duration })),
      -1
    );
    return () => cancelAnimation(breathe);
  }, [breathe, voiceState]);

  useEffect(() => {
    cancelAnimation(mouthPulse);
    if (voiceState === "speaking") {
      mouthPulse.value = withRepeat(
        withSequence(withTiming(1, { duration: 180 }), withTiming(0, { duration: 240 })),
        -1
      );
    } else {
      mouthPulse.value = withTiming(0, { duration: 120 });
    }
    return () => cancelAnimation(mouthPulse);
  }, [mouthPulse, voiceState]);

  const eyeMotionStyle = useAnimatedStyle(() => ({
    transform: [
      { scaleY: blink.value },
      { translateX: interpolate(gaze.value, [-1, 1], [-10, 10]) },
      { translateY: interpolate(breathe.value, [0, 1], [0, voiceState === "speaking" ? -2 : -1]) },
    ],
  }));

  const mouthAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { scaleX: interpolate(mouthPulse.value, [0, 1], [0.86, 1.14]) },
      { scaleY: interpolate(mouthPulse.value, [0, 1], [0.88, 1.12]) },
    ],
  }));

  const baseEyeWidth = isAvatar ? 16 : 106;
  const baseEyeHeight = isAvatar ? 14 : 92;
  const eyeGap = isAvatar ? 16 : 86;

  const renderEye = (
    key: "left" | "right",
    scaleX: number,
    scaleY: number,
    offsetY: number,
    rotation: number
  ) => {
    const width = baseEyeWidth * scaleX;
    const height = baseEyeHeight * scaleY;
    return (
      <View key={key} style={{ width, height, transform: [{ translateY: offsetY }, { rotate: `${rotation}deg` }] }}>
        <Animated.View
          style={[
            styles.eyeMotion,
            isAvatar && styles.avatarEyeMotion,
            eyeMotionStyle,
            { width, height },
          ]}
        >
          <View
            style={[
              styles.eyeShadow,
              isAvatar && styles.avatarEyeShadow,
              { width, height, backgroundColor: EYE_SHADOW_COLOR },
            ]}
          />
          <View
            style={[
              styles.eye,
              isAvatar && styles.avatarEye,
              { width, height, backgroundColor: EYE_COLOR },
            ]}
          />
        </Animated.View>
      </View>
    );
  };

  const content = (
    <View style={[styles.wrap, isAvatar ? styles.avatarWrap : styles.fullscreenWrap]}>
      <View style={[styles.eyeRow, isAvatar && styles.avatarEyeRow, { gap: eyeGap }]}>
        {renderEye("left", face.leftEyeScaleX, face.leftEyeScaleY, face.leftEyeOffsetY, face.leftEyeRotation)}
        {renderEye("right", face.rightEyeScaleX, face.rightEyeScaleY, face.rightEyeOffsetY, face.rightEyeRotation)}
      </View>
      {face.mouth !== "none" ? (
        <Animated.View
          style={[
            styles.mouth,
            isAvatar && styles.avatarMouth,
            face.mouth === "smile" && styles.smileMouth,
            mouthAnimatedStyle,
            { width: (isAvatar ? 0.22 : 1) * face.mouthWidth },
          ]}
        />
      ) : null}
      {labelVisible ? (
        <View style={[styles.caption, isAvatar && styles.avatarCaption]}>
          <Text style={[styles.captionText, isAvatar && styles.avatarCaptionText]}>
            {statusLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );

  if (!onPress && !onLongPress) return content;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={t("face.accessibilityHint")}
      onPressIn={() => {
        longPressFired.current = false;
      }}
      onLongPress={() => {
        longPressFired.current = true;
        onLongPress?.();
      }}
      delayLongPress={520}
      onPress={() => {
        if (!longPressFired.current) onPress?.();
      }}
      style={styles.pressable}
    >
      {content}
    </Pressable>
  );
}

function inferSpeakingMood(text: string): FaceMood {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return "neutral";
  if (/(?:ура|круто|супер|отличн|здорово|клас|wow|awesome|great|amazing|yay|чудов|класно)/i.test(normalized) || /!{2,}/.test(normalized)) {
    return "excited";
  }
  if (/(?:жаль|извини|прости|осторож|неприят|плохо|sorry|careful|unfortunately|шкода|вибач|обереж)/i.test(normalized)) {
    return "concerned";
  }
  if (/(?:интерес|думаю|может быть|как думаешь|hmm|maybe|wonder|цікав|гадаю)/i.test(normalized) || normalized.includes("?")) {
    return "curious";
  }
  if (/(?:рад|приятно|хорош|люблю|happy|glad|nice|радий|приємно|добре)/i.test(normalized)) {
    return "happy";
  }
  return "neutral";
}

function getCharacterFace(mood: CharacterMood): FaceVisual {
  switch (mood) {
    case "startled":
      return {
        leftEyeScaleX: 1.14, leftEyeScaleY: 1.16, rightEyeScaleX: 1.14, rightEyeScaleY: 1.16,
        leftEyeOffsetY: -2, rightEyeOffsetY: -2, leftEyeRotation: 0, rightEyeRotation: 0,
        mouth: "line", mouthWidth: 18,
      };
    case "pleased":
      return {
        leftEyeScaleX: 1.04, leftEyeScaleY: 0.68, rightEyeScaleX: 1.04, rightEyeScaleY: 0.68,
        leftEyeOffsetY: 2, rightEyeOffsetY: 2, leftEyeRotation: 0, rightEyeRotation: 0,
        mouth: "smile", mouthWidth: 36,
      };
    case "annoyed":
      return {
        leftEyeScaleX: 1.02, leftEyeScaleY: 0.58, rightEyeScaleX: 0.92, rightEyeScaleY: 0.52,
        leftEyeOffsetY: 4, rightEyeOffsetY: 5, leftEyeRotation: -5, rightEyeRotation: 5,
        mouth: "line", mouthWidth: 24,
      };
    case "angry":
      return {
        leftEyeScaleX: 1.06, leftEyeScaleY: 0.48, rightEyeScaleX: 1.06, rightEyeScaleY: 0.48,
        leftEyeOffsetY: 5, rightEyeOffsetY: 5, leftEyeRotation: 10, rightEyeRotation: -10,
        mouth: "line", mouthWidth: 34,
      };
    case "victory":
      return {
        leftEyeScaleX: 1.12, leftEyeScaleY: 0.82, rightEyeScaleX: 1.12, rightEyeScaleY: 0.82,
        leftEyeOffsetY: -2, rightEyeOffsetY: -2, leftEyeRotation: -3, rightEyeRotation: 3,
        mouth: "smile", mouthWidth: 40,
      };
  }
}

function getFaceForState(voiceState: VoiceState, streamingText: string, characterMood: CharacterMood | null): FaceVisual {
  // Caller only passes a Character mood when it is safe to render. Classic
  // pipeline states still win; Realtime passive listening explicitly permits a
  // short tap reaction so annoyed/angry is actually visible on the face.
  if (characterMood) return getCharacterFace(characterMood);
  if (voiceState === "speaking") {
    const mood = inferSpeakingMood(streamingText);
    if (mood === "excited") {
      return {
        leftEyeScaleX: 1.08,
        leftEyeScaleY: 1.06,
        rightEyeScaleX: 1.08,
        rightEyeScaleY: 1.06,
        leftEyeOffsetY: 0,
        rightEyeOffsetY: 0,
        leftEyeRotation: 0,
        rightEyeRotation: 0,
        mouth: "smile",
        mouthWidth: 34,
      };
    }
    if (mood === "curious") {
      return {
        leftEyeScaleX: 1.04,
        leftEyeScaleY: 1.03,
        rightEyeScaleX: 0.94,
        rightEyeScaleY: 0.92,
        leftEyeOffsetY: -3,
        rightEyeOffsetY: 3,
        leftEyeRotation: 0,
        rightEyeRotation: 0,
        mouth: "line",
        mouthWidth: 28,
      };
    }
    if (mood === "concerned") {
      return {
        leftEyeScaleX: 1,
        leftEyeScaleY: 0.82,
        rightEyeScaleX: 1,
        rightEyeScaleY: 0.82,
        leftEyeOffsetY: 3,
        rightEyeOffsetY: 3,
        leftEyeRotation: 0,
        rightEyeRotation: 0,
        mouth: "line",
        mouthWidth: 24,
      };
    }
    return {
      leftEyeScaleX: 1.02,
      leftEyeScaleY: mood === "happy" ? 0.9 : 1,
      rightEyeScaleX: 1.02,
      rightEyeScaleY: mood === "happy" ? 0.9 : 1,
      leftEyeOffsetY: 0,
      rightEyeOffsetY: 0,
      leftEyeRotation: 0,
      rightEyeRotation: 0,
      mouth: mood === "happy" ? "smile" : "line",
      mouthWidth: mood === "happy" ? 32 : 28,
    };
  }

  switch (voiceState) {
    case "attention":
      return {
        leftEyeScaleX: 1.08,
        leftEyeScaleY: 1.08,
        rightEyeScaleX: 1.08,
        rightEyeScaleY: 1.08,
        leftEyeOffsetY: 0,
        rightEyeOffsetY: 0,
        leftEyeRotation: 0,
        rightEyeRotation: 0,
        mouth: "none",
        mouthWidth: 0,
      };
    case "listening":
      return {
        leftEyeScaleX: 1.06,
        leftEyeScaleY: 1.05,
        rightEyeScaleX: 1.06,
        rightEyeScaleY: 1.05,
        leftEyeOffsetY: -2,
        rightEyeOffsetY: -2,
        leftEyeRotation: 0,
        rightEyeRotation: 0,
        mouth: "line",
        mouthWidth: 20,
      };
    case "processing":
      return {
        leftEyeScaleX: 0.98,
        leftEyeScaleY: 0.78,
        rightEyeScaleX: 0.98,
        rightEyeScaleY: 0.78,
        leftEyeOffsetY: 2,
        rightEyeOffsetY: 2,
        leftEyeRotation: 0,
        rightEyeRotation: 0,
        mouth: "none",
        mouthWidth: 0,
      };
    case "verifying":
      return {
        leftEyeScaleX: 1,
        leftEyeScaleY: 0.9,
        rightEyeScaleX: 1,
        rightEyeScaleY: 0.9,
        leftEyeOffsetY: 0,
        rightEyeOffsetY: 0,
        leftEyeRotation: 0,
        rightEyeRotation: 0,
        mouth: "line",
        mouthWidth: 18,
      };
    case "sleeping":
    default:
      return {
        leftEyeScaleX: 1,
        leftEyeScaleY: 1,
        rightEyeScaleX: 1,
        rightEyeScaleY: 1,
        leftEyeOffsetY: 0,
        rightEyeOffsetY: 0,
        leftEyeRotation: 0,
        rightEyeRotation: 0,
        mouth: "none",
        mouthWidth: 0,
      };
  }
}

const styles = StyleSheet.create({
  pressable: {
    alignItems: "center",
    justifyContent: "center",
  },
  wrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  fullscreenWrap: {
    width: "100%",
    minHeight: 340,
  },
  avatarWrap: {
    width: 92,
    height: 92,
  },
  eyeRow: {
    minHeight: 120,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarEyeRow: {
    minHeight: 32,
  },
  eyeMotion: {
    alignItems: "center",
    justifyContent: "center",
  },
  avatarEyeMotion: {},
  eyeShadow: {
    position: "absolute",
    left: 7,
    top: 8,
    borderRadius: 999,
    opacity: 0.9,
  },
  avatarEyeShadow: {
    left: 2,
    top: 2,
    opacity: 0.85,
  },
  eye: {
    borderRadius: 999,
    boxShadow: "0 0 20px rgba(84, 220, 242, 0.32)",
  },
  avatarEye: {
    boxShadow: "0 0 6px rgba(84, 220, 242, 0.28)",
  },
  mouth: {
    height: 5,
    marginTop: 28,
    borderRadius: 999,
    backgroundColor: EYE_COLOR,
    opacity: 0.92,
  },
  avatarMouth: {
    height: 2,
    marginTop: 7,
  },
  smileMouth: {
    height: 14,
    borderRadius: 999,
    borderBottomWidth: 4,
    borderBottomColor: EYE_COLOR,
    backgroundColor: "transparent",
  },
  caption: {
    marginTop: 26,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: "rgba(3, 13, 24, 0.62)",
  },
  avatarCaption: {
    marginTop: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  captionText: {
    color: looiTheme.muted,
    fontSize: 12,
    fontWeight: "700",
  },
  avatarCaptionText: {
    fontSize: 8,
  },
});
