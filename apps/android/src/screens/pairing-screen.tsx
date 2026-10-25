import { CameraView, useCameraPermissions } from 'expo-camera'
import { useEffect, useRef, useState } from 'react'
import { Modal, StyleSheet, Text, View } from 'react-native'
import { strings } from '../locales/i18n'
import { pairingCodeFor, pairingErrorText, pairWithOffer, type PairingResult } from '../services/pairing'
import { retryUntilConfirmed } from '../services/pairing-retry'
import { loadOrCreateIdentity } from '../services/storage'
import { Button } from '../ui/components'
import { radius, spacing, type } from '../ui/theme'
import { useTheme, type ThemeColors } from '../ui/theme-context'
import { useThemedStyles } from '../ui/use-themed-styles'

/**
 * Controller-side pairing.
 *
 * Scans the QR the Harness renders locally, pins that identity key, and keeps
 * the confirmation code on screen while the real connection runs. The code has
 * to stay visible: the operator compares it with the Host screen, and only the
 * Host can let the tunnel through, so nothing here may navigate away first.
 */
/** Gap between connection attempts while the Host confirmation is pending. */
const PAIRING_RETRY_PAUSE_MS = 2_000

export function PairingScreen({ visible, onClose, onDone, onConnect, expectedDeviceId, expectedDeviceName }: {
  visible: boolean
  onClose: () => void
  /** Runs the encrypted connection; true once the Host routed traffic. */
  onConnect: (hostDeviceId: string) => Promise<boolean>
  onDone: () => void
  /** Set when the operator started from a specific device row. */
  expectedDeviceId?: string
  expectedDeviceName?: string
}) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createStyles)
  const [permission, requestPermission] = useCameraPermissions()
  const [result, setResult] = useState<PairingResult | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [linking, setLinking] = useState(false)
  // `onBarcodeScanned` fires repeatedly while the code stays in frame.
  const handled = useRef(false)
  // The retry loop is async, so the state value is stale by the next iteration.
  const linkingRef = useRef(false)

  useEffect(() => {
    if (!visible) {
      handled.current = false
      setResult(undefined)
      setError(undefined)
      setBusy(false)
      setLinking(false)
    }
  }, [visible])

  const handleScan = async (data: string): Promise<void> => {
    if (handled.current || busy) return
    handled.current = true
    setBusy(true)
    setError(undefined)
    try {
      const identity = await loadOrCreateIdentity()
      // Check the target before pinning: `pairWithOffer` writes the scanned key
      // into the trust store, so a code from another Host has to be rejected
      // while it is still just a parsed payload.
      const preview = pairingCodeFor(data, { publicKey: identity.publicKey })
      if (expectedDeviceId !== undefined && preview.hostDeviceId !== expectedDeviceId) {
        throw new Error(strings.pairing.wrongDevice)
      }
      const paired = await pairWithOffer(data, { publicKey: identity.publicKey })
      setResult(paired)
      // Start immediately: the code stays visible while the Host waits, so the
      // operator never has to guess that a second tap is required.
      void runConnect(paired)
    } catch (reason) {
      setError(pairingErrorText(reason))
      handled.current = false
    } finally {
      setBusy(false)
    }
  }

  const rescan = (): void => {
    handled.current = false
    setResult(undefined)
    setError(undefined)
  }

  const runConnect = async (paired: PairingResult): Promise<void> => {
    if (linkingRef.current) return
    linkingRef.current = true
    setLinking(true)
    setError(undefined)
    try {
      // The Host keeps the tunnel out of the connection controller until the
      // operator confirms, and it drops an idle tunnel well before a human gets
      // there. Keep retrying so one scan covers the whole wait.
      const outcome = await retryUntilConfirmed({
        attempt: () => onConnect(paired.hostDeviceId),
        deadline: paired.expiresAt,
        pauseMs: PAIRING_RETRY_PAUSE_MS,
      })
      if (outcome === 'confirmed') { onDone(); return }
      setError(strings.pairing.failed)
    } catch (reason) {
      setError(pairingErrorText(reason))
    } finally {
      linkingRef.current = false
      setLinking(false)
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent={false}>
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title}>{strings.pairing.title}</Text>
          <Button label={strings.common.close} variant="quiet" onPress={onClose} />
        </View>

        {result !== undefined ? (
          <View style={styles.result}>
            <Text style={styles.hint}>{strings.pairing.codeTitle}</Text>
            <Text style={styles.code} selectable>{result.confirmationCode}</Text>
            <Text style={styles.meta}>
              {result.hostDeviceName ?? result.hostDeviceId} · {result.fingerprint}
            </Text>
            <Text style={styles.ok}>{strings.pairing.pinned}</Text>
            <Text style={styles.meta}>{strings.pairing.confirmOnComputer}</Text>
            <Button
              label={linking ? strings.pairing.connecting : strings.pairing.connect}
              disabled={linking}
              onPress={() => void runConnect(result)}
            />
          </View>
        ) : permission?.granted !== true ? (
          <View style={styles.result}>
            <Text style={styles.hint}>{strings.pairing.permission}</Text>
            <Button label={strings.pairing.grant} onPress={() => void requestPermission()} />
          </View>
        ) : (
          <View style={styles.cameraWrap}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => void handleScan(data)}
            />
            <View style={styles.overlay} pointerEvents="none">
              <Text style={styles.overlayText}>
                {expectedDeviceName === undefined
                  ? strings.pairing.hint
                  : strings.pairing.hintFor(expectedDeviceName)}
              </Text>
            </View>
          </View>
        )}

        {error === undefined ? null : (
          <View style={styles.footer}>
            <Text style={styles.error}>{strings.pairing.failed}</Text>
            <Text style={styles.meta}>{error}</Text>
            <Button label={strings.pairing.retry} onPress={rescan} />
          </View>
        )}
      </View>
    </Modal>
  )
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    header: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    },
    title: { ...type.title, color: colors.ink, flexShrink: 1 },
    cameraWrap: { flex: 1, overflow: 'hidden', backgroundColor: colors.surface },
    overlay: { position: 'absolute', left: 0, right: 0, bottom: spacing.xl, alignItems: 'center' },
    overlayText: {
      color: '#fff', backgroundColor: 'rgba(0,0,0,0.55)',
      paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: radius.sm,
    },
    result: { flex: 1, padding: spacing.lg, gap: spacing.md, justifyContent: 'center' },
    hint: { ...type.body, color: colors.muted },
    code: {
      ...type.title, color: colors.ink, fontVariant: ['tabular-nums'],
      letterSpacing: 2, textAlign: 'center', paddingVertical: spacing.md,
    },
    meta: { ...type.caption, color: colors.muted },
    ok: { ...type.body, color: colors.success },
    footer: { padding: spacing.md, gap: spacing.sm },
    error: { ...type.body, color: colors.danger },
  })
}
