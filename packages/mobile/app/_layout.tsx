/**
 * The app shell.
 *
 * It does three things and deliberately no more: it provides the session and
 * `ManagerState`, it decides between the login screen and the tabs, and it
 * renders the toast stack once above everything.
 *
 * The gate is here rather than in each screen because the alternative — every
 * screen checking whether somebody is signed in — is how one of them ends up
 * not checking, and calling an API client that is `null`.
 */

import { useEffect } from 'react';
import { Stack, router, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { View, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ManagerProvider, useManager } from '../src/manager';
import { Toasts } from '../src/components/ui';
import { DARK, LIGHT } from '../src/theme';

export default function RootLayout(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <ManagerProvider>
        <Shell />
      </ManagerProvider>
    </SafeAreaProvider>
  );
}

function Shell(): React.JSX.Element {
  const { phase, toasts } = useManager();
  const scheme = useColorScheme();
  const palette = scheme === 'dark' ? DARK : LIGHT;
  const segments = useSegments();

  /**
   * The one redirect in the app.
   *
   * Somebody who is not signed in has nothing any other screen can render, so
   * they go to the login screen and stay there; signing in sends them Home.
   *
   * `unreachable` deliberately does NOT redirect. Being unable to reach the
   * Manager is not being signed out — the credential is still good and the
   * machine is asleep — and throwing somebody back to a password prompt for a
   * network problem is how an app teaches people that their password "doesn't
   * work sometimes".
   */
  useEffect(() => {
    if (phase === 'loading') return;

    // Advanced is reachable while signed out, and has to be. It is where a
    // development build is given a client id, and a build with none is
    // PERMANENTLY signed out — so a gate that bounced it back to the sign-in
    // screen would make the only way out of that state unreachable.
    const route = segments[0];
    const allowedWhileSignedOut =
      route === 'login' || route === 'advanced' || route === 'image-editor-preview';
    const signedOut = phase === 'signed-out' || phase === 'unconfigured';

    if (signedOut && !allowedWhileSignedOut) {
      router.replace('/login');
    } else if (!signedOut && route === 'login') {
      router.replace('/');
    }
  }, [phase, segments]);

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />

      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.surface },
          headerTintColor: palette.text,
          headerTitleStyle: { fontSize: 16, fontWeight: '600' },
          contentStyle: { backgroundColor: palette.bg },
          // Android's hardware back is handled by the navigator itself; the
          // header button is here so a screen reached by tapping a row can be
          // left without one.
          headerBackButtonDisplayMode: 'minimal',
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="announcements/new" options={{ title: 'New Announcement' }} />
        <Stack.Screen name="announcements/[id]" options={{ title: 'Announcement' }} />
        <Stack.Screen name="advanced" options={{ title: 'Advanced' }} />
        <Stack.Screen name="image-editor-preview" options={{ title: 'Image editor' }} />
      </Stack>

      <Toasts toasts={toasts} />
    </View>
  );
}
