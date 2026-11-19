// @ts-nocheck
import { createSignal, createEffect, Show, onCleanup } from 'solid-js'
import { api, type MeProfile } from '../api/client'
import { toast } from './Toast'
import { useFocusTrap } from '../hooks/useFocusTrap'

export function initialsForName(name?: string | null): string {
  const clean = (name ?? '').trim()
  if (!clean || clean.toLowerCase() === 'user') return 'U'
  const parts = clean.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function displayNameForMe(me?: Pick<MeProfile, 'name'> | null): string {
  const clean = (me?.name ?? '').trim()
  if (!clean || clean.toLowerCase() === 'user') return 'User'
  return clean
}

export function MeModal(props: {
  open: boolean
  onClose: () => void
  onSaved?: (me: MeProfile) => void
}) {
  const [loading, setLoading] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [profile, setProfile] = createSignal<MeProfile | null>(null)
  const [name, setName] = createSignal('')
  const [bio, setBio] = createSignal('')
  const [error, setError] = createSignal('')

  let dialogRef!: HTMLDivElement
  let nameInputRef!: HTMLInputElement
  let previouslyFocused: HTMLElement | null = null

  useFocusTrap(
    () => props.open,
    () => dialogRef,
    () => props.onClose(),
  )

  createEffect(() => {
    if (!props.open) return
    previouslyFocused = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    setError('')
    setLoading(true)
    void api
      .getMe()
      .then((me) => {
        setProfile(me)
        const currentName = (me?.name ?? '').trim()
        setName(currentName && currentName.toLowerCase() !== 'user' ? currentName : '')
        setBio(typeof me?.profile?.bio === 'string' ? me.profile.bio : '')
        queueMicrotask(() => nameInputRef?.focus())
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load profile')
      })
      .finally(() => setLoading(false))

    onCleanup(() => {
      document.body.style.overflow = prevOverflow
      queueMicrotask(() => previouslyFocused?.focus())
    })
  })

  const handleSave = async (e?: Event) => {
    e?.preventDefault()
    const trimmedName = name().trim()
    if (!trimmedName) {
      setError('Please enter your name so Mira knows how to address you.')
      nameInputRef?.focus()
      return
    }
    if (trimmedName.length > 50) {
      setError('Display name must be at most 50 characters.')
      nameInputRef?.focus()
      return
    }

    setError('')
    setSaving(true)
    try {
      const trimmedBio = bio().trim()
      const updated = await api.updateMe({
        name: trimmedName,
        profile: { bio: trimmedBio },
      })
      setProfile(updated)
      window.dispatchEvent(new CustomEvent('mira:me-updated', { detail: updated }))
      props.onSaved?.(updated)
      toast.success(`Mira will remember you as ${updated.name}`)
      props.onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error(`Failed to update profile: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Show when={props.open}>
      <div
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose()
        }}
        style={{
          position: 'fixed',
          inset: '0',
          background: 'rgba(5, 7, 12, 0.72)',
          'backdrop-filter': 'blur(6px)',
          display: 'grid',
          'place-items': 'center',
          padding: '16px',
          'z-index': '1300',
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="mira-me-title"
          style={{
            width: 'min(460px, calc(100vw - 32px))',
            background: '#0D111E',
            border: '1px solid #2B3552',
            'border-radius': '16px',
            'box-shadow': '0 24px 60px rgba(0, 0, 0, 0.72)',
            padding: '22px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '16px',
            color: '#F1F3FA',
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', 'align-items': 'center', 'justify-content': 'space-between', gap: '12px' }}>
            <div style={{ display: 'flex', 'align-items': 'center', gap: '12px' }}>
              <div
                aria-hidden="true"
                style={{
                  width: '42px',
                  height: '42px',
                  'border-radius': '50%',
                  background: 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)',
                  color: '#07090E',
                  'font-weight': '800',
                  'font-size': '15px',
                  display: 'grid',
                  'place-items': 'center',
                  border: '2px solid rgba(245, 208, 97, 0.45)',
                  'flex-shrink': '0',
                }}
              >
                {initialsForName(name() || profile()?.name)}
              </div>
              <div>
                <h2
                  id="mira-me-title"
                  style={{ margin: '0', 'font-size': '16px', 'font-weight': '700', color: '#F1F3FA' }}
                >
                  Your Identity (Me)
                </h2>
                <p style={{ margin: '2px 0 0', 'font-size': '12px', color: '#8F9BB3' }}>
                  Mira remembers your name across every session and agent.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => props.onClose()}
              aria-label="Close profile dialog"
              class="btn btn-ghost"
              style={{
                width: '32px',
                height: '32px',
                padding: '0',
                'border-radius': '8px',
                border: '1px solid #1F273E',
                color: '#9CA3AF',
                display: 'grid',
                'place-items': 'center',
              }}
            >
              ✕
            </button>
          </div>

          {/* Identity metadata badges */}
          <Show when={profile()}>
            {(me) => (
              <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '6px' }}>
                <span
                  style={{
                    padding: '3px 8px',
                    'border-radius': '6px',
                    background: '#14192B',
                    border: '1px solid #1F273E',
                    'font-size': '11px',
                    'font-family': 'var(--font-mono)',
                    color: '#A5B0C7',
                  }}
                >
                  owner: {me().owner}
                </span>
                <Show when={me().role}>
                  <span
                    style={{
                      padding: '3px 8px',
                      'border-radius': '6px',
                      background: 'rgba(229, 184, 66, 0.12)',
                      border: '1px solid rgba(229, 184, 66, 0.3)',
                      'font-size': '11px',
                      'font-family': 'var(--font-mono)',
                      color: '#F5D061',
                    }}
                  >
                    role: {me().role}
                  </span>
                </Show>
                <Show when={me().org}>
                  {(org) => (
                    <span
                      style={{
                        padding: '3px 8px',
                        'border-radius': '6px',
                        background: '#14192B',
                        border: '1px solid #1F273E',
                        'font-size': '11px',
                        'font-family': 'var(--font-mono)',
                        color: '#A5B0C7',
                      }}
                    >
                      org: {org().name || org().id} ({org().role})
                    </span>
                  )}
                </Show>
              </div>
            )}
          </Show>

          <form onSubmit={handleSave} style={{ display: 'flex', 'flex-direction': 'column', gap: '12px' }}>
            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
              <label
                for="mira-me-name"
                style={{ 'font-size': '12px', 'font-weight': '600', color: '#D1D5DB' }}
              >
                Display Name
              </label>
              <input
                ref={nameInputRef}
                id="mira-me-name"
                type="text"
                maxLength={50}
                disabled={loading() || saving()}
                value={name()}
                placeholder={loading() ? 'Loading…' : 'Enter your name (e.g. Saheed)'}
                onInput={(e) => {
                  setName(e.currentTarget.value)
                  if (error()) setError('')
                }}
                style={{
                  background: '#14192B',
                  border: '1px solid #2B3552',
                  'border-radius': '8px',
                  padding: '10px 12px',
                  'font-size': '14px',
                  color: '#F1F3FA',
                  outline: 'none',
                }}
              />
              <span style={{ 'font-size': '11px', color: '#7A859E' }}>
                {name().trim().length}/50 characters · You can also tell Mira “My name is …” in chat.
              </span>
            </div>

            <div style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
              <label
                for="mira-me-bio"
                style={{ 'font-size': '12px', 'font-weight': '600', color: '#D1D5DB' }}
              >
                Role & Preferences <span style={{ color: '#7A859E', 'font-weight': '400' }}>(optional)</span>
              </label>
              <textarea
                id="mira-me-bio"
                rows={3}
                maxLength={500}
                disabled={loading() || saving()}
                value={bio()}
                placeholder="e.g. Full-stack TypeScript engineer, prefer concise explanations"
                onInput={(e) => setBio(e.currentTarget.value)}
                style={{
                  background: '#14192B',
                  border: '1px solid #2B3552',
                  'border-radius': '8px',
                  padding: '10px 12px',
                  'font-size': '13px',
                  color: '#F1F3FA',
                  resize: 'vertical',
                  'font-family': 'inherit',
                  outline: 'none',
                }}
              />
            </div>

            <Show when={error()}>
              <div
                role="alert"
                style={{
                  padding: '8px 10px',
                  'border-radius': '8px',
                  background: 'rgba(239, 68, 68, 0.12)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  color: '#FCA5A5',
                  'font-size': '12px',
                }}
              >
                {error()}
              </div>
            </Show>

            <div style={{ display: 'flex', 'justify-content': 'flex-end', gap: '8px', 'margin-top': '4px' }}>
              <button
                type="button"
                onClick={() => props.onClose()}
                class="btn btn-ghost"
                style={{
                  padding: '8px 14px',
                  'border-radius': '8px',
                  border: '1px solid #2B3552',
                  color: '#D1D5DB',
                  'font-size': '13px',
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading() || saving()}
                style={{
                  padding: '8px 18px',
                  'border-radius': '8px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #F5D061 0%, #D4AF37 100%)',
                  color: '#07090E',
                  'font-weight': '700',
                  'font-size': '13px',
                  cursor: loading() || saving() ? 'wait' : 'pointer',
                  opacity: loading() || saving() ? '0.7' : '1',
                }}
              >
                {saving() ? 'Saving…' : 'Save Name'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Show>
  )
}

export const Me = MeModal
export default MeModal
