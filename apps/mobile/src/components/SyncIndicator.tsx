import React from 'react';
import { Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { AppText } from './primitives';
import { useI18n, useTheme } from '../providers/AppProviders';
import { getDatabase } from '../db/client';
import { SqlOutboxRepository } from '../db/repositories';
import { getConnectivity } from '../features/sync/connectivity';
import { type MerchantSyncStatus, toMerchantStatus } from '../features/sync/engine';

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

  const query = useQuery({
    queryKey: ['sync-status'],
    refetchInterval: 5_000,
    queryFn: async () => {
      const database = await getDatabase();
      const outbox = new SqlOutboxRepository(database);
      const [counts, isOnline] = await Promise.all([
        outbox.counts(),
        getConnectivity().isOnline(),
      ]);
      const snapshot = {
        isOnline,
        isSyncing: false,
        pending: counts.pending,
        failed: counts.failed,
        conflict: counts.conflict,
      };
      // Both the status AND the counts are returned. Deriving only the status and
      // rendering a hardcoded count told the merchant "0 waiting to upload" while
      // work was in fact queued — the one number this chip exists to convey.
      return { status: toMerchantStatus(snapshot), ...snapshot };
    },
  });

  const status: MerchantSyncStatus = query.data?.status ?? 'SYNCED';
  const pending = query.data?.pending ?? 0;

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
      onPress={() => router.push('/settings/diagnostics')}
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
