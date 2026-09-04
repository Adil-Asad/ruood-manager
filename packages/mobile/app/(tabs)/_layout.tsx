/**
 * The three tabs.
 *
 * Home           what is going out, and the way in to each module
 * Announcements  the list, the search, and where a new one is created
 * Settings       the account, and nothing that needs explaining
 *
 * ## Why three, when there used to be four technical ones
 *
 * The old tabs were Dashboard, Records, Publish and Repository — four names for
 * four things the *system* does. None of them is a thing the administrator
 * wants: nobody opens this app to look at a repository. They open it to write
 * an announcement, and publishing is the last step of writing one rather than a
 * destination of its own.
 *
 * So publishing moved into the announcement it belongs to, and the repository
 * disappeared entirely — git, commits and revisions are how the Manager keeps
 * its promises, not something to make somebody read about.
 *
 * ## Why Announcements is a tab and not the whole app
 *
 * §35: announcements are the FIRST module of RUOOD Manager, not its identity.
 * Home exists so that Subscriptions and Users can be added beside it without
 * redesigning the navigation — a second module arriving into an app whose only
 * screen was a list of announcements would mean rebuilding the shell to hold
 * it. The tile on Home is the seam that makes that a one-line change.
 */

import { Tabs } from 'expo-router';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native';

import { usePalette } from '../../src/components/ui';
import { TOUCH_TARGET } from '../../src/theme';

export default function TabsLayout(): React.JSX.Element {
  const palette = usePalette();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: palette.surface },
        headerTintColor: palette.text,
        headerTitleStyle: { fontSize: 16, fontWeight: '600' },
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.border,
          borderTopWidth: StyleSheet.hairlineWidth,
          // Nothing interactive below 44dp. Three tabs leave room for it where
          // five did not, which is part of why there are three.
          minHeight: TOUCH_TARGET + 12,
        },
        tabBarActiveTintColor: palette.accent,
        tabBarInactiveTintColor: palette.textFaint,
        tabBarLabelStyle: { fontSize: 11 },
        sceneStyle: { backgroundColor: palette.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="home-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="announcements"
        options={{
          title: 'Announcements',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="bullhorn-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <MaterialCommunityIcons name="cog-outline" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
