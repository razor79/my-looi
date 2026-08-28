import { useFonts } from 'expo-font';
import { useKeepAwake } from 'expo-keep-awake';
import * as NavigationBar from 'expo-navigation-bar';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState, Platform, View } from 'react-native';
import '../global.css';
import 'react-native-reanimated';

import { useColorScheme } from '@/components/useColorScheme';
import { useUserStore } from '@/src/store/user';
import { markRobotInteraction, startRobotInactivityTimer, stopRobotInactivityTimer } from '@/src/core/robot-inactivity';
import { recordDiagnosticEvent } from '@/src/diagnostics/diagnostic-log';
import {
  cancelBackgroundHardExit,
  consumePreviousBackgroundProcessExit,
  scheduleBackgroundHardExit,
} from '@/src/core/background-process-exit';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const robotSleeping = useUserStore((state) => state.robotSleeping);
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  useEffect(() => {
    startRobotInactivityTimer();
    return () => stopRobotInactivityTimer();
  }, []);

  useEffect(() => {
    void consumePreviousBackgroundProcessExit()
      .then((previous) => {
        if (!previous) return;
        recordDiagnosticEvent('app', 'previous-background-process-exit', {
          previousPid: previous.pid,
          exitEpochMs: previous.epochMs,
        });
      })
      .catch((error) => {
        recordDiagnosticEvent('app', 'background-process-exit-marker-read-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    import('@/src/core/app-bootstrap')
      .then(async ({ bootstrapApp, pauseAppRuntime }) => {
        await bootstrapApp();
        if (AppState.currentState !== 'active') {
          if (AppState.currentState === 'background') {
            const status = await scheduleBackgroundHardExit();
            recordDiagnosticEvent('app', 'background-process-exit-scheduled', {
              pid: status.pid,
              delayMs: status.scheduledDelayMs,
              scheduled: status.scheduled,
              skippedForExternalActivity: status.skippedForExternalActivity,
              leaseReasons: status.leaseReasons || null,
              source: 'bootstrap-not-active',
            });
          }
          await pauseAppRuntime();
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      void (async () => {
        if (state === 'active') {
          // Cancel the native kill before touching foreground audio/BLE state.
          // Near the 5 s boundary this ordering prevents a pending background
          // exit from racing a legitimate foreground resume.
          try {
            const status = await cancelBackgroundHardExit();
            recordDiagnosticEvent('app', 'background-process-exit-cancelled', {
              pid: status.pid,
              scheduled: status.scheduled,
              source: 'foreground',
            });
          } catch (error) {
            recordDiagnosticEvent('app', 'background-process-exit-cancel-failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }

          const { resumeAppRuntime } = await import('@/src/core/app-bootstrap');
          await resumeAppRuntime();
          return;
        }

        if (state === 'background') {
          // Arm the kill in native code before starting JS cleanup. The native
          // Handler keeps counting even if Android suspends the JS thread. Five
          // seconds gives normal Realtime/mic/BLE/session cleanup time to finish.
          try {
            const status = await scheduleBackgroundHardExit();
            recordDiagnosticEvent('app', 'background-process-exit-scheduled', {
              pid: status.pid,
              delayMs: status.scheduledDelayMs,
              scheduled: status.scheduled,
              skippedForExternalActivity: status.skippedForExternalActivity,
              leaseReasons: status.leaseReasons || null,
              source: 'appstate-background',
            });
          } catch (error) {
            recordDiagnosticEvent('app', 'background-process-exit-schedule-failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const { pauseAppRuntime } = await import('@/src/core/app-bootstrap');
        await pauseAppRuntime();
      })().catch(console.error);
    });

    return () => {
      subscription.remove();
    };
  }, []);

  if (!loaded) {
    return null;
  }

  return (
    <>
      {!robotSleeping ? <ActiveRobotKeepAwake /> : null}
      <RootLayoutNav />
    </>
  );
}

function ActiveRobotKeepAwake() {
  // v1.1.20 used the hook-owned keep-awake lifecycle successfully. Keep the
  // native screen flag tied to a mounted component instead of manual sync
  // activate/deactivate calls, which can be lost across Android lifecycle churn.
  useKeepAwake('looi-main-screen');

  useEffect(() => {
    recordDiagnosticEvent('app', 'keep-awake-mounted', { tag: 'looi-main-screen' });
    return () => {
      recordDiagnosticEvent('app', 'keep-awake-released', { tag: 'looi-main-screen' });
    };
  }, []);

  return null;
}

function RootLayoutNav() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const segments = useSegments();
  const currentRoot = String(segments[0] ?? '');

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    NavigationBar.setVisibilityAsync('hidden').catch(console.error);
  }, []);

  useEffect(() => {
    let cancelled = false;

    import('@/src/setup/setup-readiness')
      .then(({ computeSetupReadiness }) => computeSetupReadiness())
      .then((readiness) => {
        if (cancelled || readiness.requiredReady) return;
        if (currentRoot === 'onboarding') return;
        router.replace(`/onboarding?step=${readiness.nextStep}` as never);
      })
      .catch((error) => {
        console.warn('[Setup] Initial readiness routing failed:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [currentRoot, router]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <View style={{ flex: 1 }} onTouchStart={() => markRobotInteraction('touch')}>
        <StatusBar hidden />
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="onboarding" options={{ headerShown: false }} />
        </Stack>
      </View>
    </ThemeProvider>
  );
}
