import { useEffect } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { useConversationStore } from "@/src/store/conversation";
import { looiTheme } from "@/src/ui/looi-theme";

const AUTO_CLOSE_MS = 3000;

export function ImageOverlay() {
  const imageUri = useConversationStore((state) => state.imageOverlayUri);
  const hideImageOverlay = useConversationStore((state) => state.hideImageOverlay);

  useEffect(() => {
    if (!imageUri) return;
    const timer = setTimeout(hideImageOverlay, AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [hideImageOverlay, imageUri]);

  return (
    <Modal
      animationType="fade"
      onRequestClose={hideImageOverlay}
      transparent
      visible={Boolean(imageUri)}
    >
      <Pressable accessibilityRole="button" onPress={hideImageOverlay} style={styles.backdrop}>
        <View pointerEvents="none" style={styles.frame}>
          {imageUri ? (
            <Image
              contentFit="contain"
              source={{ uri: imageUri }}
              style={styles.image}
              transition={140}
            />
          ) : null}
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.72)",
    padding: 24,
  },
  frame: {
    width: "100%",
    maxWidth: 720,
    height: "80%",
    maxHeight: 760,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: looiTheme.lineActive,
    backgroundColor: looiTheme.bgRaised,
    overflow: "hidden",
  },
  image: {
    width: "100%",
    height: "100%",
  },
});
