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
import { isRealtimeConversationMode, useUserStore, type FacePaletteId, type FaceStyleId, type VoiceState } from "@/src/store/user";
import { useConversationStore } from "@/src/store/conversation";
import { looiTheme } from "@/src/ui/looi-theme";
import { useUiText } from "@/src/i18n/use-ui-text";
import { useCharacterReactionStore, type CharacterMood } from "@/src/character/character-reaction";
import { recordDiagnosticEvent } from "@/src/diagnostics/diagnostic-log";
import { useSocialAttentionStore } from "@/src/core/social-attention";

type RobotFaceMode = "fullscreen" | "avatar";

type RobotFaceProps = {
  mode?: RobotFaceMode;
  onPress?: () => void;
  onLongPress?: () => void;
  labelVisible?: boolean;
};

type FaceMood = "neutral" | "happy" | "excited" | "curious" | "concerned";
type MouthShape = "none" | "line" | "smile" | "dot";

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

type FaceStyleVisual = {
  eyeWidthScale: number;
  eyeHeightScale: number;
  eyeRadius: number;
  eyeGapScale: number;
  mouthWidthScale: number;
  idleMouth: MouthShape;
  idleMouthWidth: number;
  leftEyeRotationOffset: number;
  rightEyeRotationOffset: number;
  decor: "none" | "lashes" | "brows" | "fringe" | "cowboy" | "bandana";
};

type FacePaletteVisual = {
  eyeColor: string;
  eyeShadowColor: string;
  eyeGlow: string;
  mouthColor: string;
  accentColor: string;
};

const FACE_STYLES: Record<FaceStyleId, FaceStyleVisual> = {
  classic: {
    eyeWidthScale: 1, eyeHeightScale: 1, eyeRadius: 999, eyeGapScale: 1,
    mouthWidthScale: 1, idleMouth: "none", idleMouthWidth: 0,
    leftEyeRotationOffset: 0, rightEyeRotationOffset: 0, decor: "none",
  },
  soft: {
    eyeWidthScale: 1.03, eyeHeightScale: 1.1, eyeRadius: 999, eyeGapScale: 0.94,
    mouthWidthScale: 0.88, idleMouth: "smile", idleMouthWidth: 28,
    leftEyeRotationOffset: -2, rightEyeRotationOffset: 2, decor: "lashes",
  },
  playful: {
    eyeWidthScale: 1.08, eyeHeightScale: 0.92, eyeRadius: 999, eyeGapScale: 0.9,
    mouthWidthScale: 1, idleMouth: "dot", idleMouthWidth: 11,
    leftEyeRotationOffset: -4, rightEyeRotationOffset: 5, decor: "brows",
  },
  // Legacy `fringe` id is intentionally retained for preference compatibility,
  // but the old hair strokes are replaced by a stylized cap.
  fringe: {
    eyeWidthScale: 0.92, eyeHeightScale: 0.84, eyeRadius: 42, eyeGapScale: 1.04,
    mouthWidthScale: 1.08, idleMouth: "smile", idleMouthWidth: 40,
    leftEyeRotationOffset: -2, rightEyeRotationOffset: 2, decor: "fringe",
  },
  sharp: {
    eyeWidthScale: 1.08, eyeHeightScale: 0.72, eyeRadius: 26, eyeGapScale: 1.04,
    mouthWidthScale: 0.88, idleMouth: "line", idleMouthWidth: 24,
    leftEyeRotationOffset: -5, rightEyeRotationOffset: 5, decor: "brows",
  },
  cowboy: {
    eyeWidthScale: 0.88, eyeHeightScale: 0.72, eyeRadius: 30, eyeGapScale: 1.08,
    mouthWidthScale: 1.14, idleMouth: "smile", idleMouthWidth: 44,
    leftEyeRotationOffset: -3, rightEyeRotationOffset: 3, decor: "cowboy",
  },
  bandana: {
    eyeWidthScale: 0.90, eyeHeightScale: 0.86, eyeRadius: 38, eyeGapScale: 1.02,
    mouthWidthScale: 1.18, idleMouth: "line", idleMouthWidth: 38,
    leftEyeRotationOffset: -2, rightEyeRotationOffset: 2, decor: "bandana",
  },
};

const FACE_PALETTES: Record<FacePaletteId, FacePaletteVisual> = {
  cyan: {
    eyeColor: "#54DCF2", eyeShadowColor: "#4050E8", eyeGlow: "rgba(84,220,242,0.32)",
    mouthColor: "#54DCF2", accentColor: "#82EAF8",
  },
  rose: {
    eyeColor: "#FF8BD1", eyeShadowColor: "#8D6BFF", eyeGlow: "rgba(255,139,209,0.30)",
    mouthColor: "#FF9BD8", accentColor: "#FFC0E6",
  },
  lime: {
    eyeColor: "#9EF06A", eyeShadowColor: "#2C9CFF", eyeGlow: "rgba(158,240,106,0.28)",
    mouthColor: "#9EF06A", accentColor: "#C8FF9F",
  },
  amber: {
    eyeColor: "#FFB454", eyeShadowColor: "#FF5F6D", eyeGlow: "rgba(255,180,84,0.30)",
    mouthColor: "#FFC15A", accentColor: "#FFE09A",
  },
  violet: {
    eyeColor: "#B99AFF", eyeShadowColor: "#596BFF", eyeGlow: "rgba(185,154,255,0.30)",
    mouthColor: "#CFB8FF", accentColor: "#E2D5FF",
  },
};

export function RobotFace({
  mode = "fullscreen",
  onPress,
  onLongPress,
  labelVisible = mode === "fullscreen",
}: RobotFaceProps) {
  const voiceState = useUserStore((state) => state.voiceState);
  const faceStyleId = useUserStore((state) => state.preferences.faceStyle);
  const facePaletteId = useUserStore((state) => state.preferences.facePalette);
  const faceStyle = FACE_STYLES[faceStyleId] ?? FACE_STYLES.classic;
  const palette = FACE_PALETTES[facePaletteId] ?? FACE_PALETTES.cyan;
  const streamingText = useConversationStore((state) => state.streamingText);
  const realtimeReadiness = useConversationStore((state) => state.realtimeReadiness);
  const conversationMode = useUserStore((state) => state.preferences.conversationMode);
  const characterMood = useCharacterReactionStore((state) => state.mood);
  const { t } = useUiText();
  const characterReactionId = useCharacterReactionStore((state) => state.reactionId);
  const socialAttentionActive = useSocialAttentionStore((state) => state.active);
  const socialFaceVisible = useSocialAttentionStore((state) => state.faceVisible);
  const socialGazeX = useSocialAttentionStore((state) => state.gazeX);
  const socialGazeY = useSocialAttentionStore((state) => state.gazeY);
  const blink = useSharedValue(1);
  const gaze = useSharedValue(0);
  const gazeY = useSharedValue(0);
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
    cancelAnimation(gazeY);
    if (socialAttentionActive && socialFaceVisible) {
      gaze.value = withTiming(socialGazeX, { duration: 110 });
      gazeY.value = withTiming(socialGazeY, { duration: 110 });
    } else if (voiceState === "processing") {
      gaze.value = withRepeat(
        withSequence(withTiming(-1, { duration: 850 }), withTiming(1, { duration: 1000 })),
        -1,
        true
      );
      gazeY.value = withTiming(0, { duration: 180 });
    } else if (voiceState === "sleeping") {
      gaze.value = withRepeat(
        withSequence(withTiming(-0.45, { duration: 3000 }), withTiming(0.45, { duration: 3400 })),
        -1,
        true
      );
      gazeY.value = withTiming(0, { duration: 180 });
    } else {
      gaze.value = withTiming(0, { duration: 180 });
      gazeY.value = withTiming(0, { duration: 180 });
    }
    return () => {
      cancelAnimation(gaze);
      cancelAnimation(gazeY);
    };
  }, [gaze, gazeY, socialAttentionActive, socialFaceVisible, socialGazeX, socialGazeY, voiceState]);

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

  const gazeTravelX = isAvatar ? 4 : 26;
  const gazeTravelY = isAvatar ? 3 : 15;
  const eyeMotionStyle = useAnimatedStyle(() => ({
    transform: [
      { scaleY: blink.value },
      { translateX: interpolate(gaze.value, [-1, 1], [-gazeTravelX, gazeTravelX]) },
      {
        translateY:
          interpolate(gazeY.value, [-1, 1], [-gazeTravelY, gazeTravelY]) +
          interpolate(breathe.value, [0, 1], [0, voiceState === "speaking" ? -2 : -1]),
      },
    ],
  }));

  const mouthAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { scaleX: interpolate(mouthPulse.value, [0, 1], [0.86, 1.14]) },
      { scaleY: interpolate(mouthPulse.value, [0, 1], [0.88, 1.12]) },
    ],
  }));

  const baseEyeWidth = (isAvatar ? 16 : 106) * faceStyle.eyeWidthScale;
  const baseEyeHeight = (isAvatar ? 14 : 92) * faceStyle.eyeHeightScale;
  const eyeGap = (isAvatar ? 16 : 86) * faceStyle.eyeGapScale;
  const renderedMouth = face.mouth !== "none" || voiceState === "sleeping" ? face.mouth : faceStyle.idleMouth;
  const renderedMouthWidth = face.mouth !== "none" ? face.mouthWidth : faceStyle.idleMouthWidth;

  const renderEye = (
    key: "left" | "right",
    scaleX: number,
    scaleY: number,
    offsetY: number,
    rotation: number
  ) => {
    const width = baseEyeWidth * scaleX;
    const height = baseEyeHeight * scaleY;
    const styleRotation = key === "left" ? faceStyle.leftEyeRotationOffset : faceStyle.rightEyeRotationOffset;
    return (
      <View key={key} style={{ width, height, transform: [{ translateY: offsetY }, { rotate: `${rotation + styleRotation}deg` }] }}>
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
              { width, height, backgroundColor: palette.eyeShadowColor, borderRadius: faceStyle.eyeRadius },
            ]}
          />
          <View
            style={[
              styles.eye,
              isAvatar && styles.avatarEye,
              { width, height, backgroundColor: palette.eyeColor, borderRadius: faceStyle.eyeRadius, boxShadow: `${isAvatar ? "0 0 6px" : "0 0 20px"} ${palette.eyeGlow}` },
            ]}
          />
        </Animated.View>
      </View>
    );
  };

  const content = (
    <View style={[styles.wrap, isAvatar ? styles.avatarWrap : styles.fullscreenWrap]}>
      {faceStyle.decor === "fringe" ? (
        <View pointerEvents="none" style={[styles.capDecor, isAvatar && styles.avatarCapDecor]}>
          <View style={[styles.capCrown, isAvatar && styles.avatarCapCrown, { backgroundColor: palette.accentColor, borderColor: palette.eyeShadowColor }]} />
          <View style={[styles.capBrim, isAvatar && styles.avatarCapBrim, { backgroundColor: palette.eyeShadowColor }]} />
        </View>
      ) : null}
      {faceStyle.decor === "cowboy" ? (
        <View pointerEvents="none" style={[styles.cowboyDecor, isAvatar && styles.avatarCowboyDecor]}>
          <View style={[styles.cowboyCrown, isAvatar && styles.avatarCowboyCrown, { backgroundColor: palette.accentColor, borderColor: palette.eyeShadowColor }]}>
            <View style={[styles.cowboyBand, isAvatar && styles.avatarCowboyBand, { backgroundColor: palette.eyeShadowColor }]} />
          </View>
          <View style={[styles.cowboyBrim, isAvatar && styles.avatarCowboyBrim, { backgroundColor: palette.accentColor, borderColor: palette.eyeShadowColor }]} />
        </View>
      ) : null}
      {faceStyle.decor === "bandana" ? (
        <View pointerEvents="none" style={[styles.bandanaDecor, isAvatar && styles.avatarBandanaDecor]}>
          <View style={[styles.bandanaBand, isAvatar && styles.avatarBandanaBand, { backgroundColor: palette.accentColor, borderColor: palette.eyeShadowColor }]} />
          <View style={[styles.bandanaTail, styles.bandanaTailOne, isAvatar && styles.avatarBandanaTail, isAvatar && styles.avatarBandanaTailOne, { backgroundColor: palette.eyeShadowColor }]} />
          <View style={[styles.bandanaTail, styles.bandanaTailTwo, isAvatar && styles.avatarBandanaTail, isAvatar && styles.avatarBandanaTailTwo, { backgroundColor: palette.accentColor }]} />
        </View>
      ) : null}
      {faceStyle.decor === "brows" ? (
        <View pointerEvents="none" style={[styles.browRow, isAvatar && styles.avatarBrowRow, { gap: eyeGap + (isAvatar ? 9 : 58) }]}>
          <View style={[styles.brow, isAvatar && styles.avatarBrow, { backgroundColor: palette.accentColor, transform: [{ rotate: "-10deg" }] }]} />
          <View style={[styles.brow, isAvatar && styles.avatarBrow, { backgroundColor: palette.accentColor, transform: [{ rotate: "10deg" }] }]} />
        </View>
      ) : null}
      <View style={[styles.eyeRow, isAvatar && styles.avatarEyeRow, { gap: eyeGap }]}>
        {renderEye("left", face.leftEyeScaleX, face.leftEyeScaleY, face.leftEyeOffsetY, face.leftEyeRotation)}
        {renderEye("right", face.rightEyeScaleX, face.rightEyeScaleY, face.rightEyeOffsetY, face.rightEyeRotation)}
      </View>
      {faceStyle.decor === "lashes" ? (
        <View pointerEvents="none" style={[styles.lashRow, isAvatar && styles.avatarLashRow, { gap: eyeGap + (isAvatar ? 21 : 102) }]}>
          <View style={[styles.lash, isAvatar && styles.avatarLash, { backgroundColor: palette.accentColor, transform: [{ rotate: "-28deg" }] }]} />
          <View style={[styles.lash, isAvatar && styles.avatarLash, { backgroundColor: palette.accentColor, transform: [{ rotate: "28deg" }] }]} />
        </View>
      ) : null}
      {renderedMouth !== "none" ? (
        <Animated.View
          style={[
            styles.mouth,
            isAvatar && styles.avatarMouth,
            renderedMouth === "smile" && styles.smileMouth,
            renderedMouth === "dot" && styles.dotMouth,
            isAvatar && renderedMouth === "dot" && styles.avatarDotMouth,
            mouthAnimatedStyle,
            {
              width: renderedMouth === "dot" ? (isAvatar ? 3 : 11) : (isAvatar ? 0.22 : 1) * renderedMouthWidth * faceStyle.mouthWidthScale,
              backgroundColor: renderedMouth === "smile" ? "transparent" : palette.mouthColor,
              borderBottomColor: palette.mouthColor,
            },
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
      return {
        leftEyeScaleX: 1.08,
        leftEyeScaleY: 0.12,
        rightEyeScaleX: 1.08,
        rightEyeScaleY: 0.12,
        leftEyeOffsetY: 0,
        rightEyeOffsetY: 0,
        leftEyeRotation: 0,
        rightEyeRotation: 0,
        mouth: "none",
        mouthWidth: 0,
      };
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
    position: "relative",
  },
  capDecor: { position: "absolute", top: 31, width: 220, height: 72, alignItems: "center", zIndex: 4 },
  avatarCapDecor: { top: 8, width: 56, height: 19 },
  capCrown: { width: 150, height: 50, borderTopLeftRadius: 48, borderTopRightRadius: 48, borderBottomLeftRadius: 18, borderBottomRightRadius: 18, borderWidth: 3, opacity: 0.96 },
  avatarCapCrown: { width: 38, height: 13, borderWidth: 1, borderTopLeftRadius: 12, borderTopRightRadius: 12, borderBottomLeftRadius: 5, borderBottomRightRadius: 5 },
  capBrim: { position: "absolute", bottom: 7, width: 176, height: 12, borderRadius: 999, transform: [{ rotate: "-4deg" }], opacity: 0.96 },
  avatarCapBrim: { bottom: 2, width: 45, height: 3 },
  cowboyDecor: { position: "absolute", top: 20, width: 270, height: 82, alignItems: "center", zIndex: 4 },
  avatarCowboyDecor: { top: 5, width: 68, height: 22 },
  cowboyCrown: { width: 126, height: 58, borderTopLeftRadius: 22, borderTopRightRadius: 22, borderBottomLeftRadius: 10, borderBottomRightRadius: 10, borderWidth: 3, overflow: "hidden", alignItems: "center", justifyContent: "flex-end", opacity: 0.96 },
  avatarCowboyCrown: { width: 32, height: 15, borderWidth: 1, borderTopLeftRadius: 6, borderTopRightRadius: 6, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 },
  cowboyBand: { width: "100%", height: 12, opacity: 0.95 },
  avatarCowboyBand: { height: 3 },
  cowboyBrim: { position: "absolute", bottom: 5, width: 248, height: 15, borderRadius: 999, borderWidth: 2, opacity: 0.96 },
  avatarCowboyBrim: { bottom: 1, width: 62, height: 4, borderWidth: 1 },
  bandanaDecor: { position: "absolute", top: 53, width: 238, height: 48, alignItems: "center", zIndex: 4 },
  avatarBandanaDecor: { top: 14, width: 60, height: 13 },
  bandanaBand: { width: 210, height: 22, borderRadius: 8, borderWidth: 2, opacity: 0.95 },
  avatarBandanaBand: { width: 53, height: 6, borderRadius: 2, borderWidth: 1 },
  bandanaTail: { position: "absolute", right: 2, top: 16, width: 42, height: 14, borderRadius: 6, opacity: 0.92 },
  bandanaTailOne: { transform: [{ rotate: "28deg" }] },
  bandanaTailTwo: { top: 26, right: 9, transform: [{ rotate: "52deg" }] },
  avatarBandanaTail: { width: 11, height: 4, borderRadius: 2 },
  avatarBandanaTailOne: { right: 1, top: 4 },
  avatarBandanaTailTwo: { right: 2, top: 7 },
  browRow: {
    position: "absolute",
    top: 72,
    flexDirection: "row",
    zIndex: 2,
  },
  avatarBrowRow: { top: 20 },
  brow: { width: 44, height: 7, borderRadius: 999, opacity: 0.78 },
  avatarBrow: { width: 10, height: 2 },
  lashRow: {
    position: "absolute",
    top: 96,
    flexDirection: "row",
    zIndex: 3,
  },
  avatarLashRow: { top: 27 },
  lash: { width: 22, height: 6, borderRadius: 999, opacity: 0.9 },
  avatarLash: { width: 5, height: 2 },
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
    opacity: 0.92,
  },
  avatarMouth: {
    height: 2,
    marginTop: 7,
  },
  dotMouth: {
    height: 11,
    borderRadius: 999,
  },
  avatarDotMouth: {
    height: 3,
  },
  smileMouth: {
    height: 14,
    borderRadius: 999,
    borderBottomWidth: 4,
    borderBottomColor: "#54DCF2",
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
