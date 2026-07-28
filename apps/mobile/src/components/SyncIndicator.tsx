import React from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { AppText } from './primitives';
import { useI18n, useTheme } from '../providers/AppProviders';
import { type MerchantSyncStatus } from '../features/sync/engine';
import { useSync } from '../features/sync/SyncProvider';

/**
 * Sync status, in the merchant's language.
 *
 * Non-intrusive by design: it is a small chip, never a blocking banner, and it
 * never uses the word "sync". A shopkeeper cares whether their records are
 * saved, not about a queue. The technical detail lives one tap away on the
 * diagnostics screen, for support.
 */
export function SyncIndicator(): React.ReactElement | null {
  const theme = useTheme();
  const { t, tCount } = useI18n();

  // Reads the running engine rather than polling the outbox separately. Two
  // independent pollers would disagree with each other, and only the engine knows
  // when a drain is actually in flight.
  const { status, pending, syncNow } = useSync();

  // Everything saved and online: say nothing. A permanent "all good" badge is
  // noise that trains merchants to ignore the indicator when it matters.
  if (status === 'SYNCED') return null;

  const presentation: Record<
    Exclude<MerchantSyncStatus, 'SYNCED'>,
    { label: string; glyph: string; foreground: string; background: string }
  > = {
    OFFLINE: {
      label: t('sync.offline'),
      glyph: '◌',
      foreground: theme.colors.offline,
      background: theme.colors.offlineSubtle,
    },
    PENDING: {
      label: tCount('sync.pending', pending),
      glyph: '↑',
      foreground: theme.colors.partial,
      background: theme.colors.partialSubtle,
    },
    SYNCING: {
      label: t('sync.syncing'),
      glyph: '↻',
      foreground: theme.colors.partial,
      background: theme.colors.partialSubtle,
    },
    NEEDS_ATTENTION: {
      label: t('sync.attention'),
      glyph: '!',
      foreground: theme.colors.overdue,
      background: theme.colors.overdueSubtle,
    },
  };

  const visual = presentation[status];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={visual.label}
      accessibilityHint={t('settings.diagnostics')}
      onPress={() => {
        // Tapping "something needs your attention" should attempt the obvious
        // fix; anything else opens the detail view.
        if (status === 'NEEDS_ATTENTION') router.push('/settings/diagnostics');
        else void syncNow();
      }}
      style={{ minHeight: 32, justifyContent: 'center' }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.xs,
          paddingHorizontal: theme.spacing.sm,
          paddingVertical: theme.spacing.xxs,
          borderRadius: theme.radii.pill,
          backgroundColor: visual.background,
        }}
      >
        <AppText variant="caption" style={{ color: visual.foreground, fontWeight: '700' }}>
          {visual.glyph}
        </AppText>
        <AppText variant="caption" style={{ color: visual.foreground, fontWeight: '600' }}>
          {visual.label}
        </AppText>
      </View>
    </Pressable>
  );
}
