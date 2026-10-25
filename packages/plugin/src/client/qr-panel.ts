import QRCode from 'qrcode'
import type { LocalizedMessage, Translate } from '../client-locale.js'
import type { ClientReact } from './types.js'

/** Seconds the comparison code stays locked so it cannot be clicked past. */
const COMPARE_DWELL_SECONDS = 8

interface PendingPairing {
  peerDeviceId: string
  code: string
  attemptsLeft: number
  expiresAt: number
}

/**
 * The single pairing surface for the Host.
 *
 * QR-only, plus two ways to confirm the Controller's key:
 *
 * - compare: this screen shows the code derived from the key that arrived and
 *   the operator compares it with the Controller. The confirm action stays
 *   locked for a few seconds so the comparison cannot be clicked past.
 * - manual: type the code shown on the Controller instead.
 *
 * The two are mutually exclusive on purpose: showing the expected code next to
 * an input box would turn the check into a copy.
 */
export function createPairingPanel(React: ClientReact) {
  return function PairingPanel(props: {
    control: <T>(endpoint: string, payload?: unknown) => Promise<T>
    t: Translate
    disabled?: boolean
  }): unknown {
    const { t } = props
    const [open, setOpen] = React.useState(false)
    const [image, setImage] = React.useState<string | undefined>(undefined)
    const [expiresAt, setExpiresAt] = React.useState<number | undefined>(undefined)
    const [code, setCode] = React.useState('')
    const [pending, setPending] = React.useState<PendingPairing | undefined>(undefined)
    const [compare, setCompare] = React.useState(true)
    const [remaining, setRemaining] = React.useState(COMPARE_DWELL_SECONDS)
    const [busy, setBusy] = React.useState(false)
    const [notice, setNotice] = React.useState<LocalizedMessage | undefined>(undefined)
    const [error, setError] = React.useState<string | undefined>(undefined)

    const readPending = async (): Promise<void> => {
      const next = await props.control<PendingPairing | null>('host.pair.status')
      setPending(next ?? undefined)
    }

    React.useEffect(() => {
      if (!open) return
      let active = true
      void props.control<PendingPairing | null>('host.pair.status')
        .then(next => { if (active) setPending(next ?? undefined) })
        .catch(() => undefined)
      return () => { active = false }
    }, [open])

    // Poll while an offer is live so a Controller that connects is noticed.
    React.useEffect(() => {
      if (image === undefined) return
      const timer = setInterval(() => { void readPending().catch(() => undefined) }, 2000)
      return () => clearInterval(timer)
    }, [image])

    // Restart the dwell whenever a new Controller shows up.
    React.useEffect(() => {
      if (pending === undefined || !compare) return
      setRemaining(COMPARE_DWELL_SECONDS)
      const timer = setInterval(() => {
        setRemaining(value => (value <= 1 ? 0 : value - 1))
      }, 1000)
      return () => clearInterval(timer)
    }, [pending?.peerDeviceId, compare])

    const begin = async (): Promise<void> => {
      setBusy(true)
      setError(undefined)
      setNotice(undefined)
      setCode('')
      setPending(undefined)
      try {
        const session = await props.control<{ uri: string; expiresAt: number }>('host.pair.begin')
        setImage(await QRCode.toDataURL(session.uri, { width: 184, margin: 1, errorCorrectionLevel: 'L' }))
        setExpiresAt(session.expiresAt)
        setNotice({ key: 'pairScanHint' })
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    }

    const confirm = async (): Promise<void> => {
      const submitted = compare ? pending?.code ?? '' : code.trim()
      if (submitted === '') return
      setBusy(true)
      setError(undefined)
      setNotice(undefined)
      try {
        const result = await props.control<{ status: string; peerDeviceId: string }>('host.pair.confirm', { code: submitted })
        setImage(undefined)
        setCode('')
        setExpiresAt(undefined)
        setPending(undefined)
        setNotice({ key: 'pairPaired', params: { device: result.peerDeviceId } })
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
        await readPending().catch(() => undefined)
      } finally {
        setBusy(false)
      }
    }

    const cancel = async (): Promise<void> => {
      setBusy(true)
      try {
        await props.control('host.pair.cancel')
      } catch {
        // Cancelling is best effort; the offer expires on its own.
      } finally {
        setImage(undefined)
        setExpiresAt(undefined)
        setPending(undefined)
        setCode('')
        setNotice(undefined)
        setBusy(false)
      }
    }

    const sections: unknown[] = [
      React.createElement('button', {
        key: 'begin',
        type: 'button',
        disabled: props.disabled === true || busy,
        onClick: () => void begin(),
      }, t('pairGenerate')),
    ]

    if (image !== undefined) {
      sections.push(React.createElement('img', {
        key: 'qr',
        className: 'dshRemotePairingQr',
        src: image,
        alt: t('pairTitle'),
        width: 184,
        height: 184,
      }))
      if (expiresAt !== undefined) {
        sections.push(React.createElement('small', { key: 'exp' },
          t('pairExpires', { time: new Date(expiresAt).toLocaleTimeString() })))
      }
    }

    if (pending !== undefined && compare) {
      sections.push(React.createElement('div', { key: 'compare', className: 'dshRemotePairingCompare' },
        React.createElement('small', null, t('pairWaitCountdown', {
          device: pending.peerDeviceId,
          seconds: String(remaining),
        })),
        React.createElement('code', { className: 'dshRemotePairingCode' }, pending.code),
        React.createElement('div', { className: 'dshRemotePairingActions' },
          React.createElement('button', {
            type: 'button',
            disabled: busy || remaining > 0,
            onClick: () => void confirm(),
          }, t('pairConfirmMatch')),
          React.createElement('button', {
            type: 'button',
            className: 'dshRemoteLinkButton',
            disabled: busy,
            onClick: () => { setCompare(false); setRemaining(0) },
          }, t('pairUseManual')))))
    } else if (pending !== undefined) {
      sections.push(React.createElement('div', { key: 'manual', className: 'dshRemotePairingConfirm' },
        React.createElement('input', {
          // Manual mode: never render the expected value, or the operator would
          // copy it instead of reading the Controller screen.
          value: code,
          maxLength: 32,
          placeholder: t('pairCodePlaceholder'),
          'aria-label': t('pairCodePlaceholder'),
          disabled: props.disabled === true || busy,
          onChange: (event: Event) => setCode((event.target as HTMLInputElement).value.toUpperCase()),
        }),
        React.createElement('button', {
          type: 'button',
          disabled: props.disabled === true || busy || code.trim() === '',
          onClick: () => void confirm(),
        }, t('pairConfirm'))))
      sections.push(React.createElement('button', {
        key: 'switch',
        type: 'button',
        className: 'dshRemoteLinkButton',
        disabled: busy,
        onClick: () => setCompare(true),
      }, t('pairUseCompare')))
    }

    if (pending === undefined && image !== undefined) {
      sections.push(React.createElement('small', { key: 'wait' }, t('pairWaitingPeer')))
    }

    if (image !== undefined) {
      sections.push(React.createElement('button', {
        key: 'cancel',
        type: 'button',
        className: 'dshRemoteDiscard',
        disabled: busy,
        onClick: () => void cancel(),
      }, t('pairCancel')))
    }
    if (error !== undefined) {
      sections.push(React.createElement('p', { key: 'error', className: 'dshRemoteError', role: 'alert' }, error))
    }
    if (notice !== undefined) {
      sections.push(React.createElement('p', { key: 'notice', className: 'dshRemoteNotice', role: 'status' },
        t(notice.key, notice.params)))
    }

    return React.createElement('details', { className: 'dshRemoteAuthorizationSetting dshRemotePairingSetting' },
      React.createElement('summary', { onClick: () => setOpen(value => !value) },
        React.createElement('div', null,
          React.createElement('strong', null, t('pairTitle')),
          React.createElement('p', null, t('pairHint')))),
      React.createElement('div', { className: 'dshRemotePairingBody' }, ...sections))
  }
}
