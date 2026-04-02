import { useState, useEffect, useRef } from 'react'
import cmgLogo from './cmg_logo.png'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8000'

// Step definitions — order matters
const STEPS = [
  { key: 'idle',       label: 'Search'   },
  { key: 'reviewing',  label: 'Review'   },
  { key: 'enriching',  label: 'Enrich'   },
  { key: 'drafting',   label: 'Draft'    },
  { key: 'editing',    label: 'Edit'     },
  { key: 'committing', label: 'Commit'   },
  { key: 'done',       label: 'Done'     },
]

// Map transient "working" states to their display step
const STEP_DISPLAY = {
  idle:       'idle',
  searching:  'idle',
  reviewing:  'reviewing',
  enriching:  'enriching',
  approving:  'reviewing',
  drafting:   'drafting',
  editing:    'editing',
  committing: 'committing',
  done:       'done',
}

function stepIndex(step) {
  const display = STEP_DISPLAY[step] || step
  return STEPS.findIndex(s => s.key === display)
}

// ── Week helpers ───────────────────────────────────────────────────────────────
function getWeekStart(date = new Date()) {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()) // back to Sunday
  return d.toISOString().slice(0, 10)
}

function weekLabel(weekStr, index) {
  const thisWeek = getWeekStart()
  const lastWeekDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const lastWeek = getWeekStart(lastWeekDate)
  if (weekStr === thisWeek) return 'This Week'
  if (weekStr === lastWeek) return 'Last Week'
  const start = new Date(weekStr + 'T00:00:00')
  const end   = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000)
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${fmt(start)} – ${fmt(end)}`
}

// ── Step Progress Bar ──────────────────────────────────────────────────────────
function StepBar({ step }) {
  const current = stepIndex(step)
  const isWorking = ['searching', 'enriching', 'drafting', 'committing'].includes(step)

  return (
    <div className="step-bar">
      {STEPS.map((s, i) => {
        const done    = i < current
        const active  = i === current
        const upcoming = i > current
        return (
          <div key={s.key} className="step-item">
            <div className={`step-node ${done ? 'done' : active ? 'active' : 'upcoming'}`}>
              {done ? '✓' : (active && isWorking) ? <span className="step-spinner" /> : i + 1}
            </div>
            <span className={`step-label ${done ? 'done' : active ? 'active' : 'upcoming'}`}>
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <div className={`step-connector ${done ? 'done' : 'upcoming'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function App() {
  const [step, setStep] = useState('idle')
  const [form, setForm] = useState({
    sender_name: '',
    industry: '',
    target_title: '',
    website: '',
    limit: 5,
  })
  const [error, setError] = useState(null)

  // Data at each stage
  const [rawContacts, setRawContacts] = useState([])
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [drafts, setDrafts] = useState([])             // per-contact drafts from /api/draft
  const [commitResults, setCommitResults] = useState([])
  const [scheduledDate, setScheduledDate] = useState('')  // YYYY-MM-DD
  const [scheduledSlot, setScheduledSlot] = useState('')  // HH:MM local
  const scheduledTime = scheduledDate && scheduledSlot ? `${scheduledDate}T${scheduledSlot}` : ''

  // Carousel index for draft editing
  const [currentDraftIndex, setCurrentDraftIndex] = useState(0)

  // Manual contact entry
  const [showAddContact, setShowAddContact] = useState(false)
  const [addContactForm, setAddContactForm] = useState({ first_name: '', last_name: '', email: '', title: '', company: '' })

  // Logo fallback
  const [logoError, setLogoError] = useState(false)

  // User menu
  const [showUserMenu, setShowUserMenu] = useState(false)

  // Leaderboard
  const [leaderboard, setLeaderboard] = useState([])
  const [showLeaderboard, setShowLeaderboard] = useState(false)
  const [availableWeeks, setAvailableWeeks] = useState([])
  const [selectedWeek, setSelectedWeek] = useState('') // '' = all time

  // Fetch available weeks whenever leaderboard opens or after a commit
  useEffect(() => {
    fetch(`${API_BASE}/api/leaderboard/weeks`)
      .then(r => r.ok ? r.json() : [])
      .then(weeks => {
        setAvailableWeeks(weeks)
        // Default to this week if available, otherwise all time
        const thisWeek = getWeekStart(new Date())
        if (weeks.includes(thisWeek)) setSelectedWeek(thisWeek)
        else if (weeks.length > 0) setSelectedWeek(weeks[0])
      })
      .catch(() => {})
  }, [commitResults, showLeaderboard])

  useEffect(() => {
    const url = selectedWeek
      ? `${API_BASE}/api/leaderboard?week_start=${selectedWeek}`
      : `${API_BASE}/api/leaderboard`
    fetch(url)
      .then(r => r.ok ? r.json() : [])
      .then(setLeaderboard)
      .catch(() => {})
  }, [selectedWeek, commitResults])

  const [googleToken, setGoogleToken] = useState(null)
  const [user, setUser] = useState(null)
  const userMenuRef = useRef(null)

  useEffect(() => {
    function handleClickOutside(e) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setShowUserMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Handle OAuth redirect callback params + restore session from localStorage
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const authError = params.get('auth_error')
    const accessToken = params.get('access_token')
    const email = params.get('email')
    const name = params.get('name')
    const picture = params.get('picture')
    const expiresIn = params.get('expires_in')

    if (authError) {
      setError(`Google sign-in failed: ${authError}`)
      window.history.replaceState({}, '', window.location.pathname)
      return
    }

    if (accessToken && email) {
      const expiresAt = Date.now() + (parseInt(expiresIn, 10) || 3600) * 1000
      const userInfo = { email, name, picture }
      setGoogleToken(accessToken)
      setUser(userInfo)
      localStorage.setItem('cmg_session', JSON.stringify({ token: accessToken, user: userInfo, expiresAt }))
      window.history.replaceState({}, '', window.location.pathname)
      return
    }

    // Restore from localStorage
    try {
      const saved = localStorage.getItem('cmg_session')
      if (!saved) return
      const { token, user: savedUser, expiresAt } = JSON.parse(saved)
      if (Date.now() < expiresAt) {
        setGoogleToken(token)
        setUser(savedUser)
      } else {
        localStorage.removeItem('cmg_session')
      }
    } catch {
      localStorage.removeItem('cmg_session')
    }
  }, [])

  function handleSignIn() { window.location.href = `${API_BASE}/auth/google` }
  function handleSignOut() {
    setGoogleToken(null)
    setUser(null)
    localStorage.removeItem('cmg_session')
  }

  function handleChange(e) {
    const { name, value } = e.target
    setForm(prev => ({ ...prev, [name]: name === 'limit' ? parseInt(value, 10) || 1 : value }))
  }

  // ── Step 2: Search ────────────────────────────────────────────────────────
  async function handleSearch(e) {
    e.preventDefault()
    setError(null)
    setStep('searching')
    try {
      const res = await fetch(`${API_BASE}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `Server error ${res.status}`)
      }
      const contacts = await res.json()
      setRawContacts(contacts)
      setSelectedIds(new Set(contacts.map((_, i) => i))   )  // all selected by default
      setStep('reviewing')
    } catch (err) {
      setError(err.message)
      setStep('idle')
    }
  }

  // ── Step 4: Enrich selected contacts without emails ───────────────────────
  async function handleEnrich() {
    const toEnrich = rawContacts
      .map((c, i) => ({ ...c, _idx: i }))
      .filter(c => selectedIds.has(c._idx) && !c.email)

    if (!toEnrich.length) return
    setStep('enriching')
    try {
      const res = await fetch(`${API_BASE}/api/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
        body: JSON.stringify({
          contacts: toEnrich.map(c => ({
            apollo_id: c.apollo_id,
            first_name: c.first_name,
          })),
        }),
      })
      if (!res.ok) throw new Error(`Enrich error ${res.status}`)
      const enriched = await res.json()

      // Merge enriched emails back into rawContacts
      setRawContacts(prev => {
        const updated = [...prev]
        toEnrich.forEach((c, ri) => {
          const result = enriched[ri]
          if (result && result.email) {
            updated[c._idx] = { ...updated[c._idx], email: result.email, has_email: true, enriched: true }
          } else {
            updated[c._idx] = { ...updated[c._idx], enriched: true, enrichment_failed: true }
          }
        })
        return updated
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setStep('reviewing')
    }
  }

  // ── Step 6: Generate drafts (one Claude call per company) ─────────────────
  async function handleDraft() {
    const approved = rawContacts
      .filter((c, i) => selectedIds.has(i) && c.email)
    if (!approved.length) { setError('No contacts with emails selected.'); return }

    setStep('drafting')
    try {
      const res = await fetch(`${API_BASE}/api/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${googleToken}` },
        body: JSON.stringify({
          industry: form.industry,
          sender_name: form.sender_name,
          contacts: approved.map(c => ({
            apollo_id: c.apollo_id,
            first_name: c.first_name,
            last_name: c.last_name,
            email: c.email,
            title: c.title,
            company: c.company,
          })),
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `Draft error ${res.status}`)
      }
      const results = await res.json()
      setDrafts(results.map(d => ({ ...d, approved: false })))
      setCurrentDraftIndex(0)
      setShowAddContact(false)
      setStep('editing')
    } catch (err) {
      setError(err.message)
      setStep('reviewing')
    }
  }

  // ── Step 8: Commit approved drafts ────────────────────────────────────────
  async function handleCommit() {
    const approved = drafts.filter(d => d.approved)
    if (!approved.length) { setError('Approve at least one draft first.'); return }
    if (!scheduledTime) { setError('Pick a send date and time first.'); return }

    // Convert local datetime-local value to UTC ISO string
    const isoTime = new Date(scheduledTime).toISOString()

    setStep('committing')
    const headers = { 'Content-Type': 'application/json' }
    if (googleToken) headers['Authorization'] = `Bearer ${googleToken}`

    try {
      const res = await fetch(`${API_BASE}/api/commit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ contacts: approved, scheduled_time: isoTime }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `Commit error ${res.status}`)
      }
      const results = await res.json()
      setCommitResults(results)
      setStep('done')
    } catch (err) {
      setError(err.message)
      setStep('editing')
    }
  }

  function handleReset() {
    setStep('idle')
    setRawContacts([])
    setSelectedIds(new Set())
    setDrafts([])
    setCommitResults([])
    setError(null)
  }

  function toggleContact(i) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  function updateDraft(i, field, value) {
    setDrafts(prev => prev.map((d, idx) => idx === i ? { ...d, [field]: value } : d))
  }

  function toggleDraftApproval(i) {
    const wasApproved = drafts[i].approved
    setDrafts(prev => prev.map((d, idx) => idx === i ? { ...d, approved: !d.approved } : d))
    // auto-advance to next card when approving (not when un-approving)
    if (!wasApproved && i < drafts.length - 1) {
      setCurrentDraftIndex(i + 1)
    }
  }

  function addManualContact() {
    const { first_name, last_name, email, title, company } = addContactForm
    if (!email) { setError('Email is required.'); return }
    const newDraft = { apollo_id: '', first_name, last_name, email, title, company, subject: '', body: '', approved: false }
    setDrafts(prev => {
      const next = [...prev, newDraft]
      setCurrentDraftIndex(next.length - 1)
      return next
    })
    setAddContactForm({ first_name: '', last_name: '', email: '', title: '', company: '' })
    setShowAddContact(false)
  }

  const isWorking = ['searching', 'enriching', 'drafting', 'committing'].includes(step)
  const selectedWithEmail = rawContacts.filter((c, i) => selectedIds.has(i) && c.email).length
  const selectedWithoutEmail = rawContacts.filter((c, i) => selectedIds.has(i) && !c.email).length

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          background: #111111;
          min-height: 100vh;
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          color: #e2e8f0;
        }

        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes fadeUp  { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
        @keyframes pulseDot { 0%,100% { opacity:1; } 50% { opacity:0.3; } }

        .app-wrap {
          max-width: 1200px;
          margin: 0 auto;
          padding: 36px 28px 80px;
          animation: fadeUp 0.4s ease both;
        }

        /* ── Step Bar ──────────────────────────────────────────────────── */
        .step-bar {
          display: flex;
          align-items: center;
          padding: 16px 24px;
          background: rgba(255,255,255,0.02);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 14px;
          margin-bottom: 32px;
          overflow-x: auto;
        }
        .step-item {
          display: flex;
          align-items: center;
          flex-shrink: 0;
        }
        .step-node {
          width: 28px; height: 28px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          font-size: 11px; font-weight: 700; flex-shrink: 0;
          transition: background 0.2s, border-color 0.2s;
        }
        .step-node.done {
          background: rgba(255,255,255,0.12);
          border: 1.5px solid rgba(255,255,255,0.4);
          color: #fff;
        }
        .step-node.active {
          background: rgba(255,255,255,0.15);
          border: 1.5px solid rgba(255,255,255,0.7);
          color: #fff;
        }
        .step-node.upcoming {
          background: rgba(255,255,255,0.03);
          border: 1.5px solid rgba(255,255,255,0.1);
          color: #334155;
        }
        .step-label {
          margin-left: 8px; font-size: 12px; font-weight: 500; white-space: nowrap;
        }
        .step-label.done    { color: #fff; }
        .step-label.active  { color: #fff; }
        .step-label.upcoming { color: #334155; }
        .step-connector {
          width: 32px; height: 1.5px; margin: 0 10px; flex-shrink: 0;
          transition: background 0.2s;
        }
        .step-connector.done    { background: rgba(255,255,255,0.25); }
        .step-connector.upcoming { background: rgba(255,255,255,0.06); }
        .step-spinner {
          display: block;
          width: 11px; height: 11px;
          border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
          border-radius: 50%; animation: spin 0.65s linear infinite;
        }

        /* ── Header ────────────────────────────────────────────────────── */
        .header {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 28px;
        }
        .logo-row { display: flex; align-items: center; gap: 12px; margin-bottom: 5px; }
        .logo-icon {
          width: 34px; height: 34px; border-radius: 8px;
          background: #222;
          display: flex; align-items: center; justify-content: center; font-size: 16px;
        }
        .logo-img { height: 52px; width: auto; object-fit: contain; }
        .app-title {
          font-size: 22px; font-weight: 700; letter-spacing: -0.3px;
          color: #f0f0f0;
        }
        .app-subtitle { font-size: 13px; color: #475569; }

        .auth-area { display: flex; align-items: center; gap: 10px; }

        .btn-google {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 8px 16px;
          background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
          border-radius: 8px; color: #cbd5e1; font-size: 13px; font-weight: 500;
          cursor: pointer; font-family: inherit;
          transition: background 0.15s, border-color 0.15s;
        }
        .btn-google:hover { background: rgba(255,255,255,0.09); border-color: rgba(255,255,255,0.18); }
        .google-icon { width: 16px; height: 16px; }

        .user-pill {
          display: flex; align-items: center; gap: 9px;
          background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
          border-radius: 24px; padding: 5px 14px 5px 6px;
          cursor: pointer; transition: background 0.15s, border-color 0.15s;
        }
        .user-pill:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.15); }
        .user-avatar { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; }
        .user-name { font-size: 13px; color: #cbd5e1; font-weight: 500; }
        .user-menu-wrap { position: relative; }
        .user-menu-dropdown {
          position: absolute; top: calc(100% + 8px); right: 0;
          background: #1a1a1a; border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px; padding: 6px; min-width: 140px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.4); z-index: 100;
        }
        .user-menu-item {
          width: 100%; text-align: left; background: none; border: none;
          color: #cbd5e1; font-size: 13px; font-family: inherit;
          padding: 8px 12px; border-radius: 6px; cursor: pointer;
          transition: background 0.15s;
        }
        .user-menu-item:hover { background: rgba(255,255,255,0.07); }
        .user-menu-item.danger { color: #fca5a5; }
        .user-menu-item.danger:hover { background: rgba(239,68,68,0.08); }

        .btn-signout {
          background: none; border: none; color: #475569; font-size: 12px;
          cursor: pointer; font-family: inherit; padding: 4px 6px; border-radius: 4px;
          transition: color 0.15s;
        }
        .btn-signout:hover { color: #94a3b8; }

        .no-auth-note { font-size: 12px; color: #334155; display: flex; align-items: center; gap: 6px; }

        .status-pill {
          display: flex; align-items: center; gap: 7px;
          background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);
          border-radius: 20px; padding: 5px 12px; font-size: 12px; color: #ccc; font-weight: 500;
        }
        .status-dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: #fff; animation: pulseDot 2s ease infinite;
        }

        /* ── Card ──────────────────────────────────────────────────────── */
        .card {
          background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px; padding: 28px 32px; margin-bottom: 24px;
          backdrop-filter: blur(12px);
        }
        .section-label {
          font-size: 11px; font-weight: 600; letter-spacing: 0.1em;
          text-transform: uppercase; color: #475569; margin-bottom: 20px;
        }

        /* ── Form ──────────────────────────────────────────────────────── */
        .form-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px 20px; }
        .form-group { display: flex; flex-direction: column; gap: 7px; }
        .form-label { font-size: 12px; font-weight: 500; color: #94a3b8; letter-spacing: 0.02em; }
        .form-input {
          background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.09);
          border-radius: 9px; padding: 10px 14px; font-size: 13.5px; color: #e2e8f0;
          outline: none; transition: border-color 0.2s, box-shadow 0.2s;
          font-family: inherit; width: 100%;
        }
        .form-input::placeholder { color: #334155; }
        .form-input:focus {
          border-color: rgba(255,255,255,0.5);
          box-shadow: 0 0 0 3px rgba(255,255,255,0.06);
          background: rgba(255,255,255,0.04);
        }
        input[type=number]::-webkit-inner-spin-button { opacity: 0.3; }

        .form-actions { margin-top: 24px; display: flex; align-items: center; gap: 16px; }

        /* ── Buttons ───────────────────────────────────────────────────── */
        .btn-primary {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 10px 24px;
          background: #f5f5f5;
          color: #111; border: none; border-radius: 9px;
          font-size: 13.5px; font-weight: 600; cursor: pointer; font-family: inherit;
          transition: opacity 0.15s, transform 0.15s;
        }
        .btn-primary:hover:not(:disabled) {
          opacity: 0.9; transform: translateY(-1px);
        }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

        .btn-secondary {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 9px 20px;
          background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);
          color: #cbd5e1; border-radius: 9px;
          font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit;
          transition: background 0.15s, border-color 0.15s;
        }
        .btn-secondary:hover:not(:disabled) {
          background: rgba(255,255,255,0.09); border-color: rgba(255,255,255,0.2);
        }
        .btn-secondary:disabled { opacity: 0.4; cursor: not-allowed; }

        .btn-ghost {
          background: none; border: none; color: #475569; font-size: 12px;
          cursor: pointer; font-family: inherit; padding: 4px 8px; border-radius: 4px;
          transition: color 0.15s;
        }
        .btn-ghost:hover { color: #94a3b8; }

        .spinner {
          width: 13px; height: 13px;
          border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
          border-radius: 50%; animation: spin 0.65s linear infinite; flex-shrink: 0;
        }

        /* ── Error ─────────────────────────────────────────────────────── */
        .error-bar {
          display: flex; align-items: flex-start; gap: 10px;
          background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2);
          border-radius: 10px; padding: 12px 16px; font-size: 13px; color: #fca5a5;
          margin-bottom: 20px;
        }

        /* ── Contacts review table ─────────────────────────────────────── */
        .results-header { display: flex; align-items: center; justify-content: space-between; }
        .lead-count {
          font-size: 12px; background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.12); color: #ccc;
          border-radius: 20px; padding: 3px 10px; font-weight: 500;
        }
        .empty-state { text-align: center; padding: 52px 0 40px; }
        .empty-icon  { font-size: 36px; margin-bottom: 12px; opacity: 0.4; }
        .empty-text  { font-size: 14px; color: #475569; }

        .table-wrap { overflow-x: auto; margin-top: 16px; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        thead th {
          padding: 10px 14px; text-align: left;
          font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
          color: #475569; border-bottom: 1px solid rgba(255,255,255,0.06); white-space: nowrap;
        }
        tbody tr { transition: background 0.12s; }
        tbody tr:hover { background: rgba(255,255,255,0.025); }
        tbody tr.deselected { opacity: 0.4; }
        tbody td {
          padding: 11px 14px; border-bottom: 1px solid rgba(255,255,255,0.04);
          vertical-align: middle; color: #cbd5e1;
        }
        .cell-name  { font-weight: 500; color: #e2e8f0; }
        .cell-email { color: #ccc; font-size: 12.5px; }
        .cell-title { color: #94a3b8; font-size: 12.5px; }

        .no-email {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 12px; color: #64748b; font-style: italic;
        }
        .no-email-failed { color: #ef4444; font-style: normal; font-size: 12px; }

        .badge {
          display: inline-block; padding: 3px 9px; border-radius: 20px;
          font-size: 11px; font-weight: 600;
          background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15);
          color: #ccc;
        }
        .badge-success {
          background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.15); color: #ccc;
        }

        /* checkbox */
        input[type=checkbox] { accent-color: #fff; width: 15px; height: 15px; cursor: pointer; }

        /* ── Draft carousel ─────────────────────────────────────────────── */
        .carousel-wrap {
          margin-top: 16px;
        }
        .carousel-nav {
          display: flex; align-items: center; gap: 10px; margin-bottom: 20px;
        }
        .carousel-arrow {
          width: 34px; height: 34px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.04); color: #ccc; font-size: 16px;
          cursor: pointer; display: flex; align-items: center; justify-content: center;
          transition: background 0.15s; font-family: inherit;
        }
        .carousel-arrow:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
        .carousel-arrow:disabled { opacity: 0.25; cursor: not-allowed; }
        .carousel-counter {
          font-size: 13px; color: #888; font-weight: 500;
        }

        /* ── Draft editor fields ─────────────────────────────────────────── */
        .draft-person {
          display: flex; flex-direction: column; gap: 2px;
        }
        .draft-name { font-size: 14px; font-weight: 600; color: #e2e8f0; }
        .draft-meta { font-size: 12px; color: #64748b; }

        .draft-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
        .draft-field:last-child { margin-bottom: 0; }
        .draft-field-label { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #475569; }
        .draft-input {
          background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.09);
          border-radius: 8px; padding: 9px 13px; font-size: 13px; color: #e2e8f0;
          outline: none; font-family: inherit; width: 100%;
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .draft-input:focus {
          border-color: rgba(255,255,255,0.5);
          box-shadow: 0 0 0 3px rgba(255,255,255,0.06);
        }
        .draft-textarea {
          min-height: 360px; resize: vertical; line-height: 1.55; white-space: pre-wrap;
        }

        .placeholder-hint {
          font-size: 11px; color: #334155; margin-top: 4px;
        }

        /* ── Done screen ────────────────────────────────────────────────── */
        .done-list { display: flex; flex-direction: column; gap: 10px; margin-top: 16px; }
        .done-item {
          display: flex; align-items: center; justify-content: space-between;
          background: rgba(255,255,255,0.025); border-radius: 8px; padding: 12px 16px;
        }
        .draft-link {
          display: inline-flex; align-items: center; gap: 4px;
          color: #ccc; font-size: 12.5px; font-weight: 500;
          text-decoration: none; transition: color 0.15s;
        }
        .draft-link:hover { color: #fff; }
        .na { color: #1e293b; }

        .gmail-warning { font-size: 12px; color: #64748b; display: flex; align-items: center; gap: 6px; }

        .action-row {
          display: flex; align-items: center; gap: 12px; margin-top: 20px; flex-wrap: wrap;
        }
        .enrichment-note { font-size: 12px; color: #64748b; }

        /* ── Week select ────────────────────────────────────────────────── */
        .week-select {
          background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12);
          border-radius: 8px; padding: 5px 10px; font-size: 12px; color: #cbd5e1;
          font-family: inherit; cursor: pointer; outline: none;
          transition: border-color 0.15s;
        }
        .week-select:hover { border-color: rgba(255,255,255,0.25); }
        .week-select option { background: #1a1a1a; color: #e2e8f0; }

        /* ── Leaderboard page ───────────────────────────────────────────── */
        .leaderboard-page { }
        .leaderboard-row {
          display: flex; align-items: center; gap: 16px;
          padding: 16px 20px;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          transition: background 0.12s;
        }
        .leaderboard-row:last-child { border-bottom: none; }
        .leaderboard-row:hover { background: rgba(255,255,255,0.02); }
        .leaderboard-rank {
          font-size: 13px; font-weight: 700; color: #555;
          width: 28px; flex-shrink: 0; text-align: center;
        }
        .leaderboard-rank.top { color: #fff; }
        .leaderboard-name {
          font-size: 14px; font-weight: 600; color: #e2e8f0; flex: 1;
        }
        .leaderboard-email { font-size: 12px; color: #475569; }
        .leaderboard-count {
          font-size: 13px; font-weight: 700; color: #fff;
          background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12);
          border-radius: 12px; padding: 3px 12px; flex-shrink: 0;
        }
        .leaderboard-empty-state {
          text-align: center; padding: 52px 0; color: #475569; font-size: 14px;
        }
      `}</style>

      <div className="app-wrap">

        {/* Header */}
        <div className="header">
          <div>
            <div className="logo-row">
              {logoError ? (
                <div className="logo-icon">⚡</div>
              ) : (
                <img
                  src={cmgLogo}
                  alt="CMG"
                  className="logo-img"
                  onError={() => setLogoError(true)}
                />
              )}
              <span className="app-title">Magic Outreach</span>
            </div>
            <p className="app-subtitle">Automated client outreach</p>
          </div>
          <div className="auth-area">
            {user ? (
              <div className="user-menu-wrap" ref={userMenuRef}>
                <div className="user-pill" onClick={() => setShowUserMenu(v => !v)}>
                  {user.picture && <img src={user.picture} alt="" className="user-avatar" />}
                  <span className="user-name">{user.name || user.email}</span>
                </div>
                {showUserMenu && (
                  <div className="user-menu-dropdown">
                    <button className="user-menu-item danger" onClick={() => { handleSignOut(); setShowUserMenu(false) }}>
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button className="btn-google" onClick={handleSignIn}>
                <svg className="google-icon" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                  <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                  <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
                  <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
                  <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
                </svg>
                Sign in with Google
              </button>
            )}
            {user && (
              <button
                className={showLeaderboard ? 'btn-primary' : 'btn-secondary'}
                style={{ padding: '7px 16px', fontSize: 12 }}
                onClick={() => setShowLeaderboard(v => !v)}
              >
                {showLeaderboard ? '← Source' : '🏆 Leaderboard'}
              </button>
            )}
            <div className="status-pill"><span className="status-dot" />Live</div>
          </div>
        </div>

        {/* Step Progress Bar */}
        <StepBar step={step} />

        {/* Error */}
        {error && (
          <div className="error-bar">
            <span>✕</span>
            <span>{error}</span>
            <button className="btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => setError(null)}>dismiss</button>
          </div>
        )}

        {/* ── Leaderboard page ── */}
        {showLeaderboard && (
          <div className="card leaderboard-page">
            <div className="results-header" style={{ marginBottom: 20 }}>
              <div className="section-label" style={{ marginBottom: 0 }}>Leaderboard</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="lead-count">{leaderboard.reduce((s, e) => s + e.count, 0)} sends</span>
                <select
                  className="week-select"
                  value={selectedWeek}
                  onChange={e => setSelectedWeek(e.target.value)}
                >
                  {availableWeeks.map((w, i) => (
                    <option key={w} value={w}>{weekLabel(w, i)}</option>
                  ))}
                  <option value="">All Time</option>
                </select>
              </div>
            </div>
            {leaderboard.length === 0 ? (
              <div className="leaderboard-empty-state">No emails sent yet — go find some leads!</div>
            ) : (
              leaderboard.map((entry, i) => (
                <div key={entry.email} className="leaderboard-row">
                  <span className={`leaderboard-rank ${i < 3 ? 'top' : ''}`}>
                    {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div className="leaderboard-name">{entry.email.split('@')[0]}</div>
                    <div className="leaderboard-email">{entry.email}</div>
                  </div>
                  <span className="leaderboard-count">{entry.count} sent</span>
                </div>
              ))
            )}
          </div>
        )}

        {/* ── Step: idle / searching — Search Form ── */}
        {!showLeaderboard && (step === 'idle' || step === 'searching') && !googleToken && (
          <div className="card" style={{ textAlign: 'center', padding: '60px 32px' }}>
            <div style={{ fontSize: 32, marginBottom: 16, opacity: 0.4 }}>🔒</div>
            <p style={{ fontSize: 15, fontWeight: 600, color: '#e2e8f0', marginBottom: 8 }}>Sign in required</p>
            <p style={{ fontSize: 13, color: '#475569', marginBottom: 24 }}>
              Connect your Google account to search for leads and schedule emails.
            </p>
            <button className="btn-google" onClick={handleSignIn} style={{ margin: '0 auto' }}>
              <svg className="google-icon" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
                <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </button>
          </div>
        )}
        {!showLeaderboard && (step === 'idle' || step === 'searching') && googleToken && (
          <div className="card">
            <div className="section-label">Search Parameters</div>
            <form onSubmit={handleSearch}>
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label">Your Name</label>
                  <input className="form-input" name="sender_name" placeholder="e.g. Brian"
                    value={form.sender_name} onChange={handleChange} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Industry</label>
                  <input className="form-input" name="industry" placeholder="e.g. Fintech"
                    value={form.industry} onChange={handleChange} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Target Title</label>
                  <input className="form-input" name="target_title" placeholder="e.g. VP of Strategy"
                    value={form.target_title} onChange={handleChange} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Website / Domain</label>
                  <input className="form-input" name="website" placeholder="e.g. stripe.com"
                    value={form.website} onChange={handleChange} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Number of Leads</label>
                  <input className="form-input" type="number" name="limit" min={1} max={1000}
                    value={form.limit} onChange={handleChange} required />
                </div>
              </div>
              <div className="form-actions">
                <button type="submit" disabled={isWorking} className="btn-primary">
                  {step === 'searching' ? <span className="spinner" /> : '→'}
                  {step === 'searching' ? 'Searching…' : 'Find Leads'}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ fontSize: 12 }}
                  onClick={() => { setDrafts([]); setShowAddContact(true); setStep('editing') }}
                >
                  + Manual send
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ── Step: reviewing / enriching — Contact Review ── */}
        {!showLeaderboard && (step === 'reviewing' || step === 'enriching' || step === 'approving') && (
          <div className="card">
            <div className="results-header">
              <div className="section-label" style={{ marginBottom: 0 }}>Review Contacts</div>
              {rawContacts.length > 0 && (
                <span className="lead-count">{rawContacts.length} found · {[...selectedIds].length} selected</span>
              )}
            </div>

            {rawContacts.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">◎</div>
                <p className="empty-text">No contacts returned.</p>
              </div>
            ) : (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th></th>
                        <th>Name</th>
                        <th>Title</th>
                        <th>Company</th>
                        <th>Email</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rawContacts.map((c, i) => (
                        <tr key={i} className={selectedIds.has(i) ? '' : 'deselected'}>
                          <td>
                            <input type="checkbox" checked={selectedIds.has(i)}
                              onChange={() => toggleContact(i)} />
                          </td>
                          <td className="cell-name">{c.first_name} {c.last_name}</td>
                          <td className="cell-title">{c.title}</td>
                          <td>{c.company}</td>
                          <td className="cell-email">
                            {c.email
                              ? c.email
                              : c.enrichment_failed
                                ? <span className="no-email-failed">not found</span>
                                : <span className="no-email">— needs enrichment</span>
                            }
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="action-row">
                  {selectedWithoutEmail > 0 && (
                    <button
                      className="btn-secondary"
                      onClick={handleEnrich}
                      disabled={step === 'enriching'}
                    >
                      {step === 'enriching' ? <span className="spinner" style={{ borderTopColor: '#cbd5e1' }} /> : '⬇'}
                      {step === 'enriching'
                        ? 'Enriching…'
                        : `Enrich ${selectedWithoutEmail} email${selectedWithoutEmail !== 1 ? 's' : ''}`}
                    </button>
                  )}
                  <button
                    className="btn-primary"
                    onClick={handleDraft}
                    disabled={selectedWithEmail === 0 || step === 'enriching'}
                  >
                    ✦ Generate Draft
                    {selectedWithEmail > 0 && ` (${selectedWithEmail})`}
                  </button>
                  {selectedWithoutEmail > 0 && (
                    <span className="enrichment-note">
                      {selectedWithoutEmail} selected contact{selectedWithoutEmail !== 1 ? 's' : ''} missing email — enrich or deselect before drafting
                    </span>
                  )}
                  <button className="btn-ghost" onClick={handleReset}>← New search</button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── Step: drafting — spinner while Claude works ── */}
        {!showLeaderboard && step === 'drafting' && (
          <div className="card">
            <div className="section-label">Generating Draft</div>
            <div className="empty-state">
              <span className="spinner" style={{ width: 28, height: 28, borderWidth: 3, margin: '0 auto 16px', display: 'block' }} />
              <p className="empty-text">Cooking up a draft for you…</p>
            </div>
          </div>
        )}

        {/* ── Step: editing — Draft Carousel ── */}
        {!showLeaderboard && step === 'editing' && (
          <div className="card">
            <div className="results-header">
              <div className="section-label" style={{ marginBottom: 0 }}>Review & Edit Drafts</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {drafts.length > 0 && (
                  <span className="lead-count">
                    {drafts.filter(d => d.approved).length} / {drafts.length} approved
                  </span>
                )}
                <button
                  className="btn-secondary"
                  style={{ padding: '5px 12px', fontSize: 12 }}
                  onClick={() => setShowAddContact(s => !s)}
                >
                  + Add contact
                </button>
              </div>
            </div>

            {drafts.length > 0 && (() => {
              const d = drafts[currentDraftIndex]
              const i = currentDraftIndex
              return (
                <div className="carousel-wrap">
                  {/* navigation header */}
                  <div className="carousel-nav">
                    <button
                      className="carousel-arrow"
                      onClick={() => setCurrentDraftIndex(n => Math.max(0, n - 1))}
                      disabled={currentDraftIndex === 0}
                    >←</button>
                    <span className="carousel-counter">{i + 1} of {drafts.length}</span>
                    <button
                      className="carousel-arrow"
                      onClick={() => setCurrentDraftIndex(n => Math.min(drafts.length - 1, n + 1))}
                      disabled={currentDraftIndex === drafts.length - 1}
                    >→</button>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                      <button
                        className="btn-secondary"
                        style={{ padding: '7px 14px', fontSize: 12 }}
                        onClick={() => setShowAddContact(s => !s)}
                      >
                        + Add contact
                      </button>
                      <button
                        className="btn-secondary"
                        style={{ padding: '7px 18px', fontSize: 12 }}
                        onClick={() => setDrafts(prev => prev.map(dr => ({ ...dr, approved: true })))}
                        disabled={drafts.every(dr => dr.approved)}
                      >
                        Approve All
                      </button>
                      <button
                        className={d.approved ? 'btn-primary' : 'btn-secondary'}
                        style={{ padding: '7px 18px', fontSize: 12 }}
                        onClick={() => toggleDraftApproval(i)}
                      >
                        {d.approved ? '✓ Approved' : 'Approve'}
                      </button>
                    </div>
                  </div>

                  {/* person info */}
                  <div className="draft-person" style={{ marginBottom: 18 }}>
                    <span className="draft-name">{d.first_name} {d.last_name}</span>
                    <span className="draft-meta">{d.title} · {d.company} · {d.email}</span>
                  </div>

                  {/* subject */}
                  <div className="draft-field">
                    <label className="draft-field-label">Subject</label>
                    <input className="draft-input" value={d.subject}
                      onChange={e => updateDraft(i, 'subject', e.target.value)} />
                  </div>

                  {/* body */}
                  <div className="draft-field">
                    <label className="draft-field-label">Body</label>
                    <textarea className="draft-input draft-textarea" value={d.body}
                      onChange={e => updateDraft(i, 'body', e.target.value)} />
                  </div>
                </div>
              )
            })()}

            {showAddContact && (
              <div style={{ marginTop: 16, padding: 16, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, background: 'rgba(255,255,255,0.02)' }}>
                <div style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>Add contact manually</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                  <input className="form-input" placeholder="First name" value={addContactForm.first_name}
                    onChange={e => setAddContactForm(p => ({ ...p, first_name: e.target.value }))} />
                  <input className="form-input" placeholder="Last name" value={addContactForm.last_name}
                    onChange={e => setAddContactForm(p => ({ ...p, last_name: e.target.value }))} />
                  <input className="form-input" placeholder="Email *" value={addContactForm.email}
                    onChange={e => setAddContactForm(p => ({ ...p, email: e.target.value }))} />
                  <input className="form-input" placeholder="Title" value={addContactForm.title}
                    onChange={e => setAddContactForm(p => ({ ...p, title: e.target.value }))} />
                  <input className="form-input" style={{ gridColumn: 'span 2' }} placeholder="Company" value={addContactForm.company}
                    onChange={e => setAddContactForm(p => ({ ...p, company: e.target.value }))} />
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-primary" style={{ fontSize: 12, padding: '6px 16px' }} onClick={addManualContact}>Add</button>
                  <button className="btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowAddContact(false)}>Cancel</button>
                </div>
              </div>
            )}

            <div className="action-row">
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Schedule Send</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="date"
                    className="form-input"
                    style={{ width: 'auto' }}
                    value={scheduledDate}
                    min={new Date().toISOString().slice(0, 10)}
                    max={new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}
                    onChange={e => { setScheduledDate(e.target.value); setScheduledSlot('') }}
                  />
                  <select
                    className="form-input"
                    style={{ width: 'auto' }}
                    value={scheduledSlot}
                    onChange={e => setScheduledSlot(e.target.value)}
                    disabled={!scheduledDate}
                  >
                    <option value="">Pick a time…</option>
                    {(() => {
                      const slots = []
                      const now = new Date()
                      const isToday = scheduledDate === now.toISOString().slice(0, 10)
                      for (let h = 6; h < 17; h++) {
                        for (let m = 0; m < 60; m += 15) {
                          // If today, skip slots in the past or within 15 mins
                          if (isToday) {
                            const slotDate = new Date(`${scheduledDate}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)
                            if (slotDate.getTime() < now.getTime() + 15 * 60 * 1000) continue
                          }
                          const hh = String(h).padStart(2, '0')
                          const mm = String(m).padStart(2, '0')
                          const value = `${hh}:${mm}`
                          const label = new Date(`${scheduledDate || '2000-01-01'}T${hh}:${mm}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                          slots.push(<option key={value} value={value}>{label}</option>)
                        }
                      }
                      return slots
                    })()}
                  </select>
                </div>
              </div>
              <button
                className="btn-primary"
                onClick={handleCommit}
                disabled={drafts.filter(d => d.approved).length === 0 || !scheduledTime || step === 'committing'}
              >
                {step === 'committing' ? <span className="spinner" /> : '↑'}
                {step === 'committing' ? 'Scheduling…' : `Schedule ${drafts.filter(d => d.approved).length} email${drafts.filter(d => d.approved).length !== 1 ? 's' : ''}`}
              </button>
              <button className="btn-ghost" onClick={() => setStep('reviewing')}>← Back to contacts</button>
            </div>
          </div>
        )}

        {/* ── Step: committing ── */}
        {!showLeaderboard && step === 'committing' && (
          <div className="card">
            <div className="section-label">Scheduling</div>
            <div className="empty-state">
              <span className="spinner" style={{ width: 28, height: 28, borderWidth: 3, margin: '0 auto 16px', display: 'block' }} />
              <p className="empty-text">Scheduling emails via Gmail…</p>
            </div>
          </div>
        )}

        {/* ── Step: done ── */}
        {!showLeaderboard && step === 'done' && (
          <div className="card">
            <div className="results-header">
              <div className="section-label" style={{ marginBottom: 0 }}>Scheduled</div>
              <span className="lead-count badge-success">{commitResults.length} scheduled</span>
            </div>
            <p style={{ fontSize: 12, color: '#475569', margin: '8px 0 16px' }}>
              Emails will send at {scheduledTime ? new Date(scheduledTime).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' }) + ' PT' : '—'}. Check your <strong>Sent</strong> folder in Gmail to confirm.
            </p>
            <div className="done-list">
              {commitResults.map((r, i) => (
                <div key={i} className="done-item">
                  <span className="cell-email">{r.email}</span>
                  <span className={`badge ${r.status === 'Scheduled' ? 'badge-success' : ''}`}>{r.status}</span>
                </div>
              ))}
            </div>
            <div className="action-row" style={{ marginTop: 24 }}>
              <button className="btn-primary" onClick={handleReset}>Start new search</button>
            </div>
          </div>
        )}

      </div>
    </>
  )
}
