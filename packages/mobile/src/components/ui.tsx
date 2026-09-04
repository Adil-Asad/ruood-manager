/**
 * The small set of pieces every screen is built from.
 *
 * Nothing here knows about announcements — the same rule the web Manager's
 * `components/ui.tsx` follows, so that the day one of these grows a special
 * case for "the publish button" is a day it is obvious something is in the
 * wrong file.
 *
 * What is different from the web set is entirely mobile, and all of it is here
 * rather than repeated in eight screens:
 *
 *   Screen     safe areas, scrolling, keyboard avoidance and pull-to-refresh
 *   Field      a label, a counter and an error that survives a keyboard
 *   Select     a bottom sheet, because a phone has no <select>
 *   Confirm    a modal that cannot be dismissed by accident
 *
 * Every touchable is at least `TOUCH_TARGET` tall. This app has a button that
 * publishes to production on it, so a mis-tap is not a cosmetic problem.
 */

import { useMemo, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { DARK, LIGHT, RADIUS, SPACE, TOUCH_TARGET, lifecycleColour, type Palette } from '../theme';

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}

/**
 * A screen: safe areas, a scroll view, keyboard avoidance and refresh.
 *
 * `KeyboardAvoidingView` wraps the scroll rather than sitting inside it, and
 * the scroll keeps `keyboardShouldPersistTaps="handled"` — without that, the
 * first tap on a button while a field has focus only dismisses the keyboard,
 * which reads as a button that did nothing.
 */
export function Screen({
  children,
  onRefresh,
  refreshing,
  scroll = true,
  topInset = false,
}: {
  children: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  scroll?: boolean;
  /**
   * Pad the status bar as well.
   *
   * Off by default because a screen inside the stack or the tabs already has a
   * navigation header, and that header owns the top inset — adding it here too
   * would double-pad every one of them.
   *
   * Connect is the exception: it runs with `headerShown: false`, so nothing
   * else provides it, and without this the title renders underneath the clock.
   */
  topInset?: boolean;
}): React.JSX.Element {
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  const body = scroll ? (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        padding: SPACE.md,
        // Room past the tab bar and the gesture bar, so the last card is not
        // half-hidden behind them on a tall phone.
        paddingBottom: SPACE.xl * 2 + insets.bottom,
      }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing ?? false}
            onRefresh={onRefresh}
            tintColor={palette.textDim}
            colors={[palette.accent]}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={{ flex: 1, padding: SPACE.md }}>{children}</View>
  );

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: palette.bg }}
      edges={topInset ? ['top', 'left', 'right'] : ['left', 'right']}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {body}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function Card({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}): React.JSX.Element {
  const palette = usePalette();

  return (
    <View
      style={{
        backgroundColor: palette.surface,
        borderColor: palette.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: RADIUS.md,
        padding: SPACE.md,
        marginBottom: SPACE.md,
        gap: SPACE.sm,
      }}
    >
      {title ? <Heading>{title}</Heading> : null}
      {children}
    </View>
  );
}

export function Heading({ children }: { children: ReactNode }): React.JSX.Element {
  const palette = usePalette();
  return (
    <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{children}</Text>
  );
}

export function Body({
  children,
  dim,
  mono,
}: {
  children: ReactNode;
  dim?: boolean;
  mono?: boolean;
}): React.JSX.Element {
  const palette = usePalette();
  return (
    <Text
      style={{
        color: dim ? palette.textDim : palette.text,
        fontSize: 14,
        lineHeight: 20,
        ...(mono ? { fontFamily: Platform.OS === 'android' ? 'monospace' : 'Menlo' } : {}),
      }}
    >
      {children}
    </Text>
  );
}

export function Hint({ children }: { children: ReactNode }): React.JSX.Element {
  const palette = usePalette();
  return (
    <Text style={{ color: palette.textFaint, fontSize: 12, lineHeight: 17 }}>{children}</Text>
  );
}

export function Button({
  children,
  onPress,
  kind = 'default',
  disabled,
  busy,
  full,
}: {
  children: string;
  onPress?: () => void;
  kind?: 'default' | 'primary' | 'danger' | 'alarm';
  disabled?: boolean;
  busy?: boolean;
  full?: boolean;
}): React.JSX.Element {
  const palette = usePalette();
  const off = disabled === true || busy === true;

  const colours =
    kind === 'primary'
      ? { bg: palette.accent, fg: palette.accentText, border: palette.accent }
      : kind === 'danger'
        ? { bg: palette.dangerBg, fg: palette.danger, border: palette.danger }
        : kind === 'alarm'
          ? { bg: palette.alarm, fg: palette.alarmText, border: palette.alarm }
          : { bg: palette.surface2, fg: palette.text, border: palette.border };

  return (
    <Pressable
      onPress={off ? undefined : onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: busy === true }}
      style={({ pressed }) => ({
        minHeight: TOUCH_TARGET,
        paddingHorizontal: SPACE.lg,
        justifyContent: 'center',
        alignItems: 'center',
        flexDirection: 'row',
        gap: SPACE.sm,
        borderRadius: RADIUS.sm,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colours.border,
        backgroundColor: colours.bg,
        // A disabled control has to LOOK disabled, or a greyed-out publish
        // button reads as a publish button that is broken.
        opacity: off ? 0.45 : pressed ? 0.75 : 1,
        ...(full ? { alignSelf: 'stretch' } : {}),
      })}
    >
      {busy ? <ActivityIndicator size="small" color={colours.fg} /> : null}
      <Text style={{ color: colours.fg, fontSize: 15, fontWeight: '600' }}>{children}</Text>
    </Pressable>
  );
}

export function Row({
  children,
  wrap,
}: {
  children: ReactNode;
  wrap?: boolean;
}): React.JSX.Element {
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: SPACE.sm,
        alignItems: 'center',
        ...(wrap ? { flexWrap: 'wrap' } : {}),
      }}
    >
      {children}
    </View>
  );
}

export function Badge({
  children,
  lifecycle,
  kind,
}: {
  children: string;
  lifecycle?: string;
  kind?: 'error' | 'warn' | 'ok' | 'plain';
}): React.JSX.Element {
  const palette = usePalette();

  const colours = lifecycle
    ? lifecycleColour(palette, lifecycle)
    : kind === 'error'
      ? { fg: palette.danger, bg: palette.dangerBg }
      : kind === 'warn'
        ? { fg: palette.warn, bg: palette.warnBg }
        : kind === 'ok'
          ? { fg: palette.ok, bg: palette.okBg }
          : { fg: palette.textDim, bg: palette.surface2 };

  return (
    <View
      style={{
        backgroundColor: colours.bg,
        borderRadius: RADIUS.sm,
        paddingHorizontal: SPACE.sm,
        paddingVertical: 3,
      }}
    >
      <Text style={{ color: colours.fg, fontSize: 11, fontWeight: '700' }}>{children}</Text>
    </View>
  );
}

export function Callout({
  title,
  children,
  kind = 'info',
}: {
  title: string;
  children?: ReactNode;
  kind?: 'info' | 'ok' | 'warn' | 'error';
}): React.JSX.Element {
  const palette = usePalette();

  const colours =
    kind === 'error'
      ? { fg: palette.danger, bg: palette.dangerBg }
      : kind === 'warn'
        ? { fg: palette.warn, bg: palette.warnBg }
        : kind === 'ok'
          ? { fg: palette.ok, bg: palette.okBg }
          : { fg: palette.textDim, bg: palette.surface2 };

  return (
    <View
      style={{
        backgroundColor: colours.bg,
        borderLeftWidth: 3,
        borderLeftColor: colours.fg,
        borderRadius: RADIUS.sm,
        padding: SPACE.md,
        gap: SPACE.xs,
      }}
    >
      <Text style={{ color: colours.fg, fontSize: 13, fontWeight: '700' }}>{title}</Text>
      {typeof children === 'string' ? (
        <Text style={{ color: palette.text, fontSize: 13, lineHeight: 19 }}>{children}</Text>
      ) : (
        children
      )}
    </View>
  );
}

/**
 * A labelled input, with the character budget beside the label.
 *
 * The count is shown always rather than on overflow, for the reason the web
 * Manager gives: a title has 60 characters, and finding that out by being
 * refused is worse than knowing.
 */
export function Field({
  label,
  hint,
  error,
  count,
  limit,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  count?: number;
  limit?: number;
  children: ReactNode;
}): React.JSX.Element {
  const palette = usePalette();
  const over = count !== undefined && limit !== undefined && count > limit;

  return (
    <View style={{ gap: SPACE.xs, marginBottom: SPACE.md }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: palette.textDim, fontSize: 12, fontWeight: '600' }}>{label}</Text>
        {count !== undefined && limit !== undefined ? (
          <Text
            style={{
              color: over ? palette.danger : palette.textFaint,
              fontSize: 12,
              fontVariant: ['tabular-nums'],
            }}
          >
            {count}/{limit}
          </Text>
        ) : null}
      </View>

      {children}

      {hint ? <Hint>{hint}</Hint> : null}
      {error ? (
        <Text style={{ color: palette.danger, fontSize: 12 }}>{error}</Text>
      ) : null}
    </View>
  );
}

export function Input(props: TextInputProps & { invalid?: boolean }): React.JSX.Element {
  const palette = usePalette();
  const { invalid, style, multiline, ...rest } = props;

  return (
    <TextInput
      placeholderTextColor={palette.textFaint}
      {...rest}
      multiline={multiline}
      style={[
        {
          minHeight: multiline ? 96 : TOUCH_TARGET,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: invalid ? palette.danger : palette.borderStrong,
          borderRadius: RADIUS.sm,
          backgroundColor: palette.bg,
          color: palette.text,
          paddingHorizontal: SPACE.md,
          paddingVertical: SPACE.sm,
          fontSize: 15,
          textAlignVertical: multiline ? 'top' : 'center',
        },
        style,
      ]}
    />
  );
}

/**
 * A picker, as a bottom sheet.
 *
 * React Native has no `<select>`, and the platform `Picker` is a separate
 * dependency that looks different on every OEM. A sheet of full-width rows is
 * bigger than a dropdown on purpose: these choose things like the delivery
 * surface, where the option's meaning matters more than the space it costs.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string; detail?: string }[];
  onChange: (value: T) => void;
  label?: string;
}): React.JSX.Element {
  const palette = usePalette();
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();

  const current = useMemo(
    () => options.find((option) => option.value === value),
    [options, value],
  );

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}: ${current?.label ?? value}` : undefined}
        style={{
          minHeight: TOUCH_TARGET,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: palette.borderStrong,
          borderRadius: RADIUS.sm,
          backgroundColor: palette.bg,
          paddingHorizontal: SPACE.md,
          justifyContent: 'center',
        }}
      >
        <Text style={{ color: palette.text, fontSize: 15 }}>{current?.label ?? value}</Text>
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        // Android's back button closes the sheet rather than the screen behind
        // it. Without this, back would navigate away with the sheet still up.
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' }}
          onPress={() => setOpen(false)}
        >
          <Pressable
            style={{
              backgroundColor: palette.surface,
              borderTopLeftRadius: RADIUS.lg,
              borderTopRightRadius: RADIUS.lg,
              paddingTop: SPACE.md,
              paddingBottom: insets.bottom + SPACE.md,
            }}
            // Swallow the tap so choosing does not also hit the backdrop.
            onPress={() => undefined}
          >
            {label ? (
              <Text
                style={{
                  color: palette.textDim,
                  fontSize: 12,
                  fontWeight: '700',
                  paddingHorizontal: SPACE.lg,
                  paddingBottom: SPACE.sm,
                }}
              >
                {label.toUpperCase()}
              </Text>
            ) : null}

            <ScrollView style={{ maxHeight: 420 }}>
              {options.map((option) => (
                <Pressable
                  key={option.value}
                  onPress={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  style={({ pressed }) => ({
                    minHeight: TOUCH_TARGET,
                    paddingHorizontal: SPACE.lg,
                    paddingVertical: SPACE.md,
                    backgroundColor: pressed ? palette.surface2 : 'transparent',
                    gap: 2,
                  })}
                >
                  <Text
                    style={{
                      color: option.value === value ? palette.accent : palette.text,
                      fontSize: 15,
                      fontWeight: option.value === value ? '700' : '400',
                    }}
                  >
                    {option.label}
                  </Text>
                  {option.detail ? (
                    <Text style={{ color: palette.textFaint, fontSize: 12, lineHeight: 17 }}>
                      {option.detail}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export function Toggle({
  value,
  onChange,
  label,
  disabled,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}): React.JSX.Element {
  const palette = usePalette();

  return (
    <Pressable
      onPress={disabled ? undefined : () => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: disabled === true }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: SPACE.md,
        minHeight: TOUCH_TARGET,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 4,
          borderWidth: 2,
          borderColor: value ? palette.accent : palette.borderStrong,
          backgroundColor: value ? palette.accent : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {value ? (
          <Text style={{ color: palette.accentText, fontSize: 14, fontWeight: '900' }}>✓</Text>
        ) : null}
      </View>
      <Text style={{ color: palette.text, fontSize: 14, flex: 1 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * A confirmation that has to be read.
 *
 * `onRequestClose` is wired to cancel so Android's back button dismisses it
 * safely rather than leaving it up, and the destructive action is never the
 * first button — an operator tapping through a dialog should land on Cancel.
 */
export function Confirm({
  visible,
  title,
  children,
  confirmLabel,
  confirmKind = 'danger',
  onConfirm,
  onCancel,
  busy,
  confirmDisabled,
}: {
  visible: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  confirmKind?: 'primary' | 'danger' | 'alarm';
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /**
   * Blocks the confirm, visibly.
   *
   * Used where a dialog asks for something to be typed before it will act. The
   * alternative — accepting the tap and doing nothing — is a button that looks
   * broken, on the one screen where the operator most needs to trust what the
   * buttons do.
   */
  confirmDisabled?: boolean;
}): React.JSX.Element {
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View
        style={{
          flex: 1,
          backgroundColor: '#000000aa',
          justifyContent: 'center',
          padding: SPACE.lg,
        }}
      >
        <View
          style={{
            backgroundColor: palette.surface,
            borderRadius: RADIUS.lg,
            padding: SPACE.lg,
            gap: SPACE.md,
            maxHeight: '85%',
            marginBottom: insets.bottom,
          }}
        >
          <Text style={{ color: palette.text, fontSize: 17, fontWeight: '700' }}>{title}</Text>

          <ScrollView style={{ flexGrow: 0 }}>
            <View style={{ gap: SPACE.sm }}>{children}</View>
          </ScrollView>

          <View style={{ gap: SPACE.sm }}>
            <Button onPress={onCancel} full>
              Cancel
            </Button>
            <Button
              kind={confirmKind}
              onPress={onConfirm}
              busy={busy}
              disabled={confirmDisabled}
              full
            >
              {confirmLabel}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function Loading({ what }: { what: string }): React.JSX.Element {
  const palette = usePalette();

  return (
    <View style={{ padding: SPACE.xl, alignItems: 'center', gap: SPACE.md }}>
      <ActivityIndicator color={palette.accent} />
      <Text style={{ color: palette.textDim, fontSize: 13 }}>{what}</Text>
    </View>
  );
}

export function Empty({ children }: { children: string }): React.JSX.Element {
  const palette = usePalette();

  return (
    <View style={{ padding: SPACE.xl, alignItems: 'center' }}>
      <Text style={{ color: palette.textFaint, fontSize: 14, textAlign: 'center' }}>
        {children}
      </Text>
    </View>
  );
}

/** Validation issues, in the same shape both other front ends print them. */
export function Issues({
  issues,
  severity,
}: {
  issues: readonly { path: string; message: string }[];
  severity: 'error' | 'warning';
}): React.JSX.Element | null {
  if (issues.length === 0) return null;

  return (
    <Callout
      kind={severity === 'error' ? 'error' : 'warn'}
      title={`${issues.length} ${severity}${issues.length === 1 ? '' : 's'}`}
    >
      <View style={{ gap: SPACE.xs }}>
        {issues.map((issue, index) => (
          <Body key={`${issue.path}-${index}`}>
            {issue.path ? `${issue.path}: ${issue.message}` : issue.message}
          </Body>
        ))}
      </View>
    </Callout>
  );
}

export function Stat({ label, value }: { label: string; value: string | number }): React.JSX.Element {
  const palette = usePalette();

  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: '30%',
        backgroundColor: palette.surface2,
        borderRadius: RADIUS.sm,
        padding: SPACE.md,
        gap: 2,
      }}
    >
      <Text style={{ color: palette.text, fontSize: 22, fontWeight: '700' }}>{value}</Text>
      <Text style={{ color: palette.textDim, fontSize: 11, textTransform: 'uppercase' }}>
        {label}
      </Text>
    </View>
  );
}

/** The toast stack, rendered once by the shell above every screen. */
export function Toasts({
  toasts,
}: {
  toasts: readonly { id: number; message: string; kind: 'ok' | 'error' }[];
}): React.JSX.Element | null {
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  if (toasts.length === 0) return null;

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: SPACE.md,
        right: SPACE.md,
        bottom: insets.bottom + SPACE.xl * 2,
        gap: SPACE.sm,
      }}
    >
      {toasts.map((toast) => (
        <View
          key={toast.id}
          style={{
            backgroundColor: toast.kind === 'error' ? palette.dangerBg : palette.okBg,
            borderLeftWidth: 3,
            borderLeftColor: toast.kind === 'error' ? palette.danger : palette.ok,
            borderRadius: RADIUS.sm,
            padding: SPACE.md,
          }}
        >
          <Text style={{ color: palette.text, fontSize: 13, lineHeight: 19 }}>
            {toast.message}
          </Text>
        </View>
      ))}
    </View>
  );
}
