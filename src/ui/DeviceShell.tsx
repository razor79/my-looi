import { RobotFace } from "@/src/ui/RobotFace";
import { looiTheme } from "@/src/ui/looi-theme";
import { useUiText } from "@/src/i18n/use-ui-text";
import type { UiStringKey } from "@/src/i18n/ui-strings";
import { Href, usePathname, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import regularSymbolWeight from "expo-symbols/androidWeights/regular";
import { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type DeviceShellProps = {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  scroll?: boolean;
  onReturnHome?: () => void;
};

type DeviceShellHeaderProps = {
  title: string;
  eyebrow?: string;
  onReturnHome?: () => void;
};

const navItems = [
  {
    href: "/conversation",
    matchPath: "/conversation",
    labelKey: "nav.conversations" as UiStringKey,
    symbol: { ios: "message.fill", android: "chat" },
  },
  {
    href: "/memories",
    matchPath: "/memories",
    labelKey: "nav.memory" as UiStringKey,
    symbol: { ios: "brain.head.profile", android: "psychology" },
  },
  {
    href: "/settings",
    matchPath: "/settings",
    labelKey: "nav.settings" as UiStringKey,
    symbol: { ios: "gearshape.fill", android: "settings" },
  },
] as const;

export function DeviceShell({
  title,
  eyebrow,
  children,
  scroll = true,
  onReturnHome,
}: DeviceShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useUiText();
  const returnHome = () => {
    if (onReturnHome) {
      onReturnHome();
      return;
    }
    router.replace("/");
  };
  const content = scroll ? (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      <DeviceShellHeader title={title} eyebrow={eyebrow} onReturnHome={returnHome} />
      {children}
    </ScrollView>
  ) : (
    <View style={styles.fixedContent}>{children}</View>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.backgroundGrid} pointerEvents="none" />
      <View style={styles.frame}>
        <View style={styles.rail}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("nav.returnHome")}
            onPress={returnHome}
            style={styles.homeButton}
          >
            <Text style={styles.homeMark}>LOOI</Text>
          </Pressable>
          <View style={styles.navStack}>
            {navItems.map((item) => {
              const active = pathname === item.matchPath;
              return (
                <Pressable
                  key={item.href}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  onPress={() => {
                    if (active) return;
                    router.replace(item.href as Href);
                  }}
                  style={StyleSheet.flatten([
                    styles.navItem,
                    active && styles.navItemActive,
                  ])}
                >
                  <SymbolView
                    name={item.symbol}
                    size={25}
                    tintColor={active ? looiTheme.cyan : looiTheme.muted}
                    weight={{ ios: "semibold", android: regularSymbolWeight }}
                    fallback={
                      <View
                        style={[
                          styles.navIconFallback,
                          active && styles.navIconFallbackActive,
                        ]}
                      />
                    }
                  />
                  <Text
                    style={[styles.navLabel, active && styles.navLabelActive]}
                  >
                    {t(item.labelKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
        <View style={styles.main}>
          {content}
        </View>
      </View>
    </SafeAreaView>
  );
}

export function DeviceShellHeader({
  title,
  eyebrow,
  onReturnHome,
}: DeviceShellHeaderProps) {
  const router = useRouter();
  const returnHome = () => {
    if (onReturnHome) {
      onReturnHome();
      return;
    }
    router.replace("/");
  };

  return (
    <View style={styles.header}>
      <View style={styles.titleBlock}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.title}>{title}</Text>
      </View>
      <RobotFace mode="avatar" onPress={returnHome} />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: looiTheme.bg,
  },
  backgroundGrid: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    opacity: 0.12,
    backgroundColor: looiTheme.bg,
    borderColor: looiTheme.line,
    borderWidth: 1,
  },
  frame: {
    flex: 1,
    flexDirection: "row",
    padding: 10,
    gap: 10,
  },
  rail: {
    width: 92,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: looiTheme.rail,
    alignItems: "center",
    paddingVertical: 10,
  },
  homeButton: {
    width: 66,
    height: 36,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: "rgba(40, 213, 255, 0.06)",
  },
  homeMark: {
    color: looiTheme.text,
    fontSize: 12,
    fontWeight: "700",
  },
  navStack: {
    flex: 1,
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 8,
  },
  navItem: {
    width: 70,
    minHeight: 56,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  navItemActive: {
    borderColor: looiTheme.lineActive,
    backgroundColor: "rgba(40, 213, 255, 0.08)",
  },
  navIconFallback: {
    width: 22,
    height: 22,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: looiTheme.muted,
  },
  navIconFallbackActive: {
    borderColor: looiTheme.cyan,
  },
  navLabel: {
    color: looiTheme.muted,
    fontSize: 12,
  },
  navLabelActive: {
    color: looiTheme.text,
  },
  main: {
    flex: 1,
    borderRadius: 30,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: looiTheme.line,
    backgroundColor: looiTheme.bgRaised,
  },
  header: {
    minHeight: 78,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  titleBlock: {
    flex: 1,
    paddingRight: 12,
  },
  eyebrow: {
    color: looiTheme.cyan,
    fontSize: 11,
    fontWeight: "700",
    marginBottom: 4,
  },
  title: {
    color: looiTheme.text,
    fontSize: 28,
    lineHeight: 32,
    fontWeight: "700",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 22,
    paddingBottom: 22,
    paddingTop: 12,
  },
  fixedContent: {
    flex: 1,
    paddingHorizontal: 22,
    paddingBottom: 22,
    paddingTop: 12,
  },
});
