import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Tabs, router } from 'expo-router';
import { AppText } from '../../src/components/primitives';
import { useI18n, useTheme } from '../../src/providers/AppProviders';
import { ADD_BUTTON_SIZE, MIN_TOUCH_TARGET } from '../../src/theme/tokens';

/**
 * Bottom navigation: five destinations, with a visually prominent central Add.
 *
 * Recording a debt is the single most frequent action in this product, so it is
 * a raised button rather than an equal peer — reachable with one thumb while the
 * customer is still at the counter.
 */
function AddButton(): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('nav.add')}
      onPress={() => router.push('/record/debt')}
      style={{
        top: Platform.OS === 'ios' ? -18 : -14,
        width: ADD_BUTTON_SIZE,
        height: ADD_BUTTON_SIZE,
        borderRadius: ADD_BUTTON_SIZE / 2,
        backgroundColor: theme.colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
        ...theme.elevation.floating,
      }}
    >
      <AppText variant="h2" style={{ color: theme.colors.textOnPrimary, lineHeight: 30 }}>
        +
      </AppText>
    </Pressable>
  );
}

function TabGlyph({
  glyph,
  focused,
}: {
  readonly glyph: string;
  readonly focused: boolean;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <View style={{ minHeight: 24, justifyContent: 'center' }}>
      <AppText
        variant="bodyStrong"
        style={{ color: focused ? theme.colors.primary : theme.colors.textTertiary }}
      >
        {glyph}
      </AppText>
    </View>
  );
}

export default function AppTabsLayout(): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textTertiary,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          minHeight: MIN_TOUCH_TARGET + 16,
          paddingTop: 4,
        },
        tabBarLabelStyle: { ...theme.typography.caption, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('nav.home'),
          tabBarIcon: ({ focused }) => <TabGlyph glyph="⌂" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="customers"
        options={{
          title: t('nav.customers'),
          tabBarIcon: ({ focused }) => <TabGlyph glyph="☰" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="add"
        options={{
          title: '',
          tabBarButton: () => <AddButton />,
        }}
      />
      <Tabs.Screen
        name="transactions"
        options={{
          title: t('nav.transactions'),
          tabBarIcon: ({ focused }) => <TabGlyph glyph="≡" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: t('nav.more'),
          tabBarIcon: ({ focused }) => <TabGlyph glyph="⋯" focused={focused} />,
        }}
      />
    </Tabs>
  );
}
