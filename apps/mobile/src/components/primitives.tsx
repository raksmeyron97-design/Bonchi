import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  type PressableProps,
  ScrollView,
  StyleSheet,
  Text,
  type TextProps,
  TextInput,
  type TextInputProps,
  View,
  type ViewProps,
} from 'react-native';
import { type DebtDisplayStatus, type Money, formatMoney } from '@bonchi/domain';
import { useI18n, useTheme } from '../providers/AppProviders';
import { MIN_TOUCH_TARGET, type TypographyToken } from '../theme/tokens';
import { statusVisual } from '../theme/status';

/**
 * UI primitives.
 *
 * Accessibility is built in rather than added per screen: every pressable meets
 * the 48dp minimum target, every input is labelled and describes its own error,
 * and every status shows a glyph and text alongside its colour.
 */

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export interface AppTextProps extends TextProps {
  readonly variant?: TypographyToken;
  readonly tone?: 'primary' | 'secondary' | 'tertiary' | 'onPrimary' | 'danger' | 'success';
  readonly children?: React.ReactNode;
}

export function AppText({
  variant = 'body',
  tone = 'primary',
  style,
  ...props
}: AppTextProps): React.ReactElement {
  const theme = useTheme();
  const color = {
    primary: theme.colors.textPrimary,
    secondary: theme.colors.textSecondary,
    tertiary: theme.colors.textTertiary,
    onPrimary: theme.colors.textOnPrimary,
    danger: theme.colors.overdue,
    success: theme.colors.payment,
  }[tone];

  return (
    <Text
      // Khmer glyphs stack above and below the baseline; letting the OS scale
      // text unboundedly clips them, so growth is capped rather than disabled.
      maxFontSizeMultiplier={1.6}
      style={[theme.typography[variant], { color }, style]}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Screen({
  children,
  scrollable = true,
  style,
  ...props
}: ViewProps & { readonly scrollable?: boolean }): React.ReactElement {
  const theme = useTheme();
  const content = (
    <View style={[{ padding: theme.spacing.lg, gap: theme.spacing.lg }, style]} {...props}>
      {children}
    </View>
  );

  if (!scrollable) {
    return <View style={{ flex: 1, backgroundColor: theme.colors.background }}>{content}</View>;
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{ paddingBottom: theme.spacing.xxxl }}
      keyboardShouldPersistTaps="handled"
    >
      {content}
    </ScrollView>
  );
}

export function Card({ children, style, ...props }: ViewProps): React.ReactElement {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radii.lg,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.colors.border,
          padding: theme.spacing.lg,
          gap: theme.spacing.sm,
        },
        theme.elevation.card,
        style,
      ]}
      {...props}
    >
      {children}
    </View>
  );
}

export function Row({
  children,
  gap,
  style,
  ...props
}: ViewProps & { readonly gap?: number }): React.ReactElement {
  const theme = useTheme();
  return (
    <View
      style={[
        { flexDirection: 'row', alignItems: 'center', gap: gap ?? theme.spacing.sm },
        style,
      ]}
      {...props}
    >
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export interface ButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  readonly label: string;
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  readonly size?: 'medium' | 'large';
  readonly loading?: boolean;
  readonly fullWidth?: boolean;
}

export function Button({
  label,
  variant = 'primary',
  size = 'medium',
  loading = false,
  fullWidth = true,
  disabled,
  ...props
}: ButtonProps): React.ReactElement {
  const theme = useTheme();
  const isDisabled = disabled || loading;

  const background = {
    primary: theme.colors.primary,
    secondary: theme.colors.surfaceSunken,
    ghost: 'transparent',
    danger: theme.colors.overdue,
  }[variant];

  const foreground = {
    primary: theme.colors.textOnPrimary,
    secondary: theme.colors.textPrimary,
    ghost: theme.colors.primaryText,
    danger: theme.colors.textOnPrimary,
  }[variant];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      style={({ pressed }) => ({
        minHeight: size === 'large' ? 56 : MIN_TOUCH_TARGET,
        alignSelf: fullWidth ? 'stretch' : 'flex-start',
        paddingHorizontal: theme.spacing.lg,
        borderRadius: theme.radii.md,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: theme.spacing.sm,
        backgroundColor: background,
        borderWidth: variant === 'ghost' ? 0 : StyleSheet.hairlineWidth,
        borderColor: variant === 'secondary' ? theme.colors.border : 'transparent',
        opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
      })}
      {...props}
    >
      {loading ? <ActivityIndicator color={foreground} size="small" /> : null}
      <AppText variant={size === 'large' ? 'bodyLarge' : 'bodyStrong'} style={{ color: foreground }}>
        {label}
      </AppText>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

export interface FieldProps extends TextInputProps {
  readonly label: string;
  readonly error?: string | null;
  readonly hint?: string;
  readonly optional?: boolean;
  readonly required?: boolean;
}

export function Field({
  label,
  error,
  hint,
  optional,
  required,
  style,
  ...props
}: FieldProps): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  const errorId = `${label}-error`;

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Row gap={theme.spacing.xs}>
        <AppText variant="label" tone="secondary">
          {label}
        </AppText>
        {optional ? (
          <AppText variant="caption" tone="tertiary">
            ({t('common.optional')})
          </AppText>
        ) : null}
        {required ? (
          <AppText variant="caption" tone="danger" accessibilityLabel={t('common.required')}>
            *
          </AppText>
        ) : null}
      </Row>

      <TextInput
        accessibilityLabel={label}
        // Screen readers announce the error along with the field rather than
        // leaving it as unassociated text below.
        accessibilityHint={error ?? hint}
        aria-errormessage={error ? errorId : undefined}
        aria-invalid={Boolean(error)}
        placeholderTextColor={theme.colors.textTertiary}
        style={[
          {
            minHeight: MIN_TOUCH_TARGET,
            borderWidth: 1,
            borderColor: error ? theme.colors.overdue : theme.colors.border,
            borderRadius: theme.radii.md,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.sm,
            backgroundColor: theme.colors.surface,
            color: theme.colors.textPrimary,
            ...theme.typography.body,
          },
          style,
        ]}
        {...props}
      />

      {error ? (
        <AppText nativeID={errorId} variant="caption" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      ) : hint ? (
        <AppText variant="caption" tone="tertiary">
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export interface MoneyTextProps {
  readonly value: Money;
  readonly variant?: TypographyToken;
  readonly tone?: 'primary' | 'debt' | 'payment' | 'overdue';
  readonly signDisplay?: 'auto' | 'always' | 'never';
}

/**
 * Renders an amount.
 *
 * Currency is always shown. KHR and USD are separate obligations, so an amount
 * with no currency marker would be genuinely ambiguous to a merchant who deals
 * in both.
 */
export function MoneyText({
  value,
  variant = 'amount',
  tone = 'primary',
  signDisplay = 'auto',
}: MoneyTextProps): React.ReactElement {
  const theme = useTheme();
  const { locale } = useI18n();

  const color = {
    primary: theme.colors.textPrimary,
    debt: theme.colors.debt,
    payment: theme.colors.payment,
    overdue: theme.colors.overdue,
  }[tone];

  const formatted = formatMoney(value, { locale, signDisplay });

  return (
    <Text
      maxFontSizeMultiplier={1.4}
      // Read as one unit ("fifty thousand riel"), not digit by digit.
      accessibilityLabel={formatted}
      style={[theme.typography[variant], { color }]}
    >
      {formatted}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

export function StatusBadge({
  status,
  detail,
}: {
  readonly status: DebtDisplayStatus;
  readonly detail?: string;
}): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  const visual = statusVisual(status);
  const label = t(visual.labelKey);

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.xs,
        alignSelf: 'flex-start',
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.xxs,
        borderRadius: theme.radii.pill,
        backgroundColor: theme.colors[visual.background],
      }}
    >
      {/* Glyph and text carry the meaning; colour only reinforces it. */}
      <Text
        style={{ color: theme.colors[visual.foreground], fontSize: 12, fontWeight: '700' }}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {visual.glyph}
      </Text>
      <Text
        maxFontSizeMultiplier={1.4}
        style={{
          color: theme.colors[visual.foreground],
          ...theme.typography.caption,
          fontWeight: '600',
        }}
      >
        {detail ?? label}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function LoadingState({ label }: { readonly label?: string }): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label ?? t('common.loading')}
      style={{ padding: theme.spacing.xxl, alignItems: 'center', gap: theme.spacing.md }}
    >
      <ActivityIndicator color={theme.colors.primary} />
      <AppText variant="body" tone="secondary">
        {label ?? t('common.loading')}
      </AppText>
    </View>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  readonly title: string;
  readonly body?: string;
  readonly action?: React.ReactNode;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <View
      style={{
        padding: theme.spacing.xxl,
        alignItems: 'center',
        gap: theme.spacing.md,
      }}
    >
      <AppText variant="h3" style={{ textAlign: 'center' }}>
        {title}
      </AppText>
      {body ? (
        <AppText variant="body" tone="secondary" style={{ textAlign: 'center' }}>
          {body}
        </AppText>
      ) : null}
      {action}
    </View>
  );
}

export function ErrorState({
  title,
  body,
  onRetry,
}: {
  readonly title: string;
  readonly body?: string;
  readonly onRetry?: () => void;
}): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{ padding: theme.spacing.xl, alignItems: 'center', gap: theme.spacing.md }}
    >
      <AppText variant="h3" tone="danger" style={{ textAlign: 'center' }}>
        {title}
      </AppText>
      {body ? (
        <AppText variant="body" tone="secondary" style={{ textAlign: 'center' }}>
          {body}
        </AppText>
      ) : null}
      {onRetry ? <Button label={t('common.retry')} variant="secondary" onPress={onRetry} fullWidth={false} /> : null}
    </View>
  );
}

export function Divider(): React.ReactElement {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border }}
    />
  );
}
