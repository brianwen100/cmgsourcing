import { useState, useEffect, useRef } from 'react'

const API_BASE = 'http://localhost:8000'
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/spreadsheets',
  'email',
  'profile',
].join(' ')

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

  const [googleToken, setGoogleToken] = useState(null)
  const [user, setUser] = useState(null)
  const tokenClientRef = useRef(null)

  // Load GIS
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => {
      tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: SCOPES,
        callback: async (response) => {
          if (response.error) { setError(`Google sign-in failed: ${response.error}`); return }
          const token = response.access_token
          setGoogleToken(token)
          const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (res.ok) setUser(await res.json())
        },
      })
    }
    document.body.appendChild(script)
    return () => document.body.removeChild(script)
  }, [])

  function handleSignIn()  { tokenClientRef.current?.requestAccessToken() }
  function handleSignOut() {
    if (googleToken) window.google?.accounts.oauth2.revoke(googleToken)
    setGoogleToken(null); setUser(null)
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
        headers: { 'Content-Type': 'application/json' },
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
      .filter(c => selectedIds.has(c._idx) && !c.has_email)

    if (!toEnrich.length) return
    setStep('enriching')
    try {
      const res = await fetch(`${API_BASE}/api/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contacts: toEnrich.map(c => ({
            first_name: c.first_name,
            last_name: c.last_name,
            organization_name: c.company,
            domain: c.domain,
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          industry: form.industry,
          contacts: approved.map(c => ({
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

    setStep('committing')
    const headers = { 'Content-Type': 'application/json' }
    if (googleToken) headers['Authorization'] = `Bearer ${googleToken}`

    try {
      const res = await fetch(`${API_BASE}/api/commit`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ contacts: approved }),
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
    setDrafts(prev => prev.map((d, idx) => idx === i ? { ...d, approved: !d.approved } : d))
  }

  const isWorking = ['searching', 'enriching', 'drafting', 'committing'].includes(step)
  const selectedWithEmail = rawContacts.filter((c, i) => selectedIds.has(i) && c.email).length
  const selectedWithoutEmail = rawContacts.filter((c, i) => selectedIds.has(i) && !c.email).length

  return (
    <>
      <style>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        body {
          background: #060b18;
          min-height: 100vh;
          font-family: 'Inter', system-ui, -apple-system, sans-serif;
          color: #e2e8f0;
          background-image:
            radial-gradient(ellipse 80% 50% at 50% -20%, rgba(59,130,246,0.12) 0%, transparent 60%),
            radial-gradient(ellipse 60% 40% at 80% 80%, rgba(124,58,237,0.07) 0%, transparent 50%);
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
          background: rgba(16,185,129,0.15);
          border: 1.5px solid rgba(16,185,129,0.4);
          color: #34d399;
        }
        .step-node.active {
          background: rgba(59,130,246,0.2);
          border: 1.5px solid rgba(59,130,246,0.6);
          color: #93c5fd;
          box-shadow: 0 0 10px rgba(59,130,246,0.3);
        }
        .step-node.upcoming {
          background: rgba(255,255,255,0.03);
          border: 1.5px solid rgba(255,255,255,0.1);
          color: #334155;
        }
        .step-label {
          margin-left: 8px; font-size: 12px; font-weight: 500; white-space: nowrap;
        }
        .step-label.done    { color: #34d399; }
        .step-label.active  { color: #93c5fd; }
        .step-label.upcoming { color: #334155; }
        .step-connector {
          width: 32px; height: 1.5px; margin: 0 10px; flex-shrink: 0;
          transition: background 0.2s;
        }
        .step-connector.done    { background: rgba(16,185,129,0.3); }
        .step-connector.upcoming { background: rgba(255,255,255,0.06); }
        .step-spinner {
          display: block;
          width: 11px; height: 11px;
          border: 2px solid rgba(147,197,253,0.3); border-top-color: #93c5fd;
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
          background: linear-gradient(135deg, #3b82f6 0%, #7c3aed 100%);
          display: flex; align-items: center; justify-content: center; font-size: 16px;
        }
        .app-title {
          font-size: 22px; font-weight: 700; letter-spacing: -0.3px;
          background: linear-gradient(90deg, #e2e8f0 30%, #94a3b8);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
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
        }
        .user-avatar { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; }
        .user-name { font-size: 13px; color: #cbd5e1; font-weight: 500; }

        .btn-signout {
          background: none; border: none; color: #475569; font-size: 12px;
          cursor: pointer; font-family: inherit; padding: 4px 6px; border-radius: 4px;
          transition: color 0.15s;
        }
        .btn-signout:hover { color: #94a3b8; }

        .no-auth-note { font-size: 12px; color: #334155; display: flex; align-items: center; gap: 6px; }

        .status-pill {
          display: flex; align-items: center; gap: 7px;
          background: rgba(16,185,129,0.08); border: 1px solid rgba(16,185,129,0.2);
          border-radius: 20px; padding: 5px 12px; font-size: 12px; color: #34d399; font-weight: 500;
        }
        .status-dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: #10b981; animation: pulseDot 2s ease infinite;
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
          border-color: rgba(59,130,246,0.5);
          box-shadow: 0 0 0 3px rgba(59,130,246,0.1);
          background: rgba(59,130,246,0.04);
        }
        input[type=number]::-webkit-inner-spin-button { opacity: 0.3; }

        .form-actions { margin-top: 24px; display: flex; align-items: center; gap: 16px; }

        /* ── Buttons ───────────────────────────────────────────────────── */
        .btn-primary {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 10px 24px;
          background: linear-gradient(135deg, #3b82f6 0%, #6366f1 100%);
          color: #fff; border: none; border-radius: 9px;
          font-size: 13.5px; font-weight: 600; cursor: pointer; font-family: inherit;
          transition: opacity 0.15s, transform 0.15s, box-shadow 0.15s;
          box-shadow: 0 0 20px rgba(59,130,246,0.25);
        }
        .btn-primary:hover:not(:disabled) {
          opacity: 0.9; transform: translateY(-1px);
          box-shadow: 0 0 28px rgba(59,130,246,0.4);
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
          font-size: 12px; background: rgba(59,130,246,0.12);
          border: 1px solid rgba(59,130,246,0.2); color: #93c5fd;
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
        .cell-email { color: #7dd3fc; font-size: 12.5px; }
        .cell-title { color: #94a3b8; font-size: 12.5px; }

        .no-email {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 12px; color: #64748b; font-style: italic;
        }
        .no-email-failed { color: #ef4444; font-style: normal; font-size: 12px; }

        .badge {
          display: inline-block; padding: 3px 9px; border-radius: 20px;
          font-size: 11px; font-weight: 600;
          background: rgba(59,130,246,0.1); border: 1px solid rgba(59,130,246,0.2);
          color: #93c5fd;
        }
        .badge-success {
          background: rgba(16,185,129,0.1); border-color: rgba(16,185,129,0.25); color: #34d399;
        }

        /* checkbox */
        input[type=checkbox] { accent-color: #3b82f6; width: 15px; height: 15px; cursor: pointer; }

        /* ── Draft editor cards ─────────────────────────────────────────── */
        .draft-cards { display: flex; flex-direction: column; gap: 20px; margin-top: 8px; }
        .draft-card {
          background: rgba(255,255,255,0.025);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 12px; padding: 20px 24px;
          transition: border-color 0.2s;
        }
        .draft-card.approved {
          border-color: rgba(16,185,129,0.3);
          background: rgba(16,185,129,0.03);
        }
        .draft-card-header {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 16px;
        }
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
          border-color: rgba(59,130,246,0.5);
          box-shadow: 0 0 0 3px rgba(59,130,246,0.08);
        }
        .draft-textarea {
          min-height: 120px; resize: vertical; line-height: 1.55; white-space: pre-wrap;
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
          color: #818cf8; font-size: 12.5px; font-weight: 500;
          text-decoration: none; transition: color 0.15s;
        }
        .draft-link:hover { color: #a5b4fc; }
        .na { color: #1e293b; }

        .gmail-warning { font-size: 12px; color: #64748b; display: flex; align-items: center; gap: 6px; }

        .action-row {
          display: flex; align-items: center; gap: 12px; margin-top: 20px; flex-wrap: wrap;
        }
        .enrichment-note { font-size: 12px; color: #64748b; }
      `}</style>

      <div className="app-wrap">

        {/* Header */}
        <div className="header">
          <div>
            <div className="logo-row">
              <div className="logo-icon">⚡</div>
              <span className="app-title">CMG Lead Gen</span>
            </div>
            <p className="app-subtitle">CMG Strategy Consulting · UC Berkeley — Automated client sourcing & outreach</p>
          </div>
          <div className="auth-area">
            {user ? (
              <>
                <div className="user-pill">
                  {user.picture && <img src={user.picture} alt="" className="user-avatar" />}
                  <span className="user-name">{user.name || user.email}</span>
                </div>
                <button className="btn-signout" onClick={handleSignOut}>Sign out</button>
              </>
            ) : (
              GOOGLE_CLIENT_ID ? (
                <button className="btn-google" onClick={handleSignIn}>
                  <svg className="google-icon" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                    <path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
                    <path d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" fill="#FBBC05"/>
                    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
                  </svg>
                  Sign in with Google
                </button>
              ) : (
                <div className="no-auth-note">⚠ VITE_GOOGLE_CLIENT_ID not set</div>
              )
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

        {/* ── Step: idle / searching — Search Form ── */}
        {(step === 'idle' || step === 'searching') && (
          <div className="card">
            <div className="section-label">Search Parameters</div>
            <form onSubmit={handleSearch}>
              <div className="form-grid">
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
                  <input className="form-input" type="number" name="limit" min={1} max={20}
                    value={form.limit} onChange={handleChange} required />
                </div>
              </div>
              <div className="form-actions">
                <button type="submit" disabled={isWorking} className="btn-primary">
                  {step === 'searching' ? <span className="spinner" /> : '→'}
                  {step === 'searching' ? 'Searching…' : 'Find Leads'}
                </button>
                {!googleToken && (
                  <span className="gmail-warning">
                    Sign in with Google to enable Gmail drafts & Sheets export
                  </span>
                )}
              </div>
            </form>
          </div>
        )}

        {/* ── Step: reviewing / enriching — Contact Review ── */}
        {(step === 'reviewing' || step === 'enriching' || step === 'approving') && (
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
        {step === 'drafting' && (
          <div className="card">
            <div className="section-label">Generating Draft</div>
            <div className="empty-state">
              <span className="spinner" style={{ width: 28, height: 28, borderWidth: 3, margin: '0 auto 16px', display: 'block' }} />
              <p className="empty-text">Claude is writing one email template per company…</p>
            </div>
          </div>
        )}

        {/* ── Step: editing — Draft Editor ── */}
        {step === 'editing' && (
          <div className="card">
            <div className="results-header">
              <div className="section-label" style={{ marginBottom: 0 }}>Review & Edit Drafts</div>
              <span className="lead-count">
                {drafts.filter(d => d.approved).length} / {drafts.length} approved
              </span>
            </div>

            <p style={{ fontSize: 12, color: '#475569', marginTop: 8, marginBottom: 4 }}>
              Edit subject and body below. <code style={{ color: '#7dd3fc' }}>{'{first_name}'}</code> and <code style={{ color: '#7dd3fc' }}>{'{title}'}</code> are substituted per contact at send time.
            </p>

            <div className="draft-cards">
              {drafts.map((d, i) => (
                <div key={i} className={`draft-card ${d.approved ? 'approved' : ''}`}>
                  <div className="draft-card-header">
                    <div className="draft-person">
                      <span className="draft-name">{d.first_name} {d.last_name}</span>
                      <span className="draft-meta">{d.title} · {d.company} · {d.email}</span>
                    </div>
                    <button
                      className={d.approved ? 'btn-primary' : 'btn-secondary'}
                      style={{ padding: '7px 16px', fontSize: 12 }}
                      onClick={() => toggleDraftApproval(i)}
                    >
                      {d.approved ? '✓ Approved' : 'Approve'}
                    </button>
                  </div>

                  <div className="draft-field">
                    <label className="draft-field-label">Subject</label>
                    <input
                      className="draft-input"
                      value={d.subject}
                      onChange={e => updateDraft(i, 'subject', e.target.value)}
                    />
                  </div>

                  <div className="draft-field">
                    <label className="draft-field-label">Body</label>
                    <textarea
                      className="draft-input draft-textarea"
                      value={d.body}
                      onChange={e => updateDraft(i, 'body', e.target.value)}
                    />
                    <p className="placeholder-hint">
                      Tip: <code>{'{first_name}'}</code> and <code>{'{title}'}</code> will be substituted for each recipient.
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="action-row">
              <button
                className="btn-primary"
                onClick={handleCommit}
                disabled={drafts.filter(d => d.approved).length === 0 || step === 'committing'}
              >
                {step === 'committing' ? <span className="spinner" /> : '↑'}
                {step === 'committing' ? 'Committing…' : `Commit ${drafts.filter(d => d.approved).length} draft${drafts.filter(d => d.approved).length !== 1 ? 's' : ''}`}
              </button>
              {!googleToken && (
                <span className="gmail-warning">Sign in with Google to create Gmail drafts & Sheets rows</span>
              )}
              <button className="btn-ghost" onClick={() => setStep('reviewing')}>← Back to contacts</button>
            </div>
          </div>
        )}

        {/* ── Step: committing ── */}
        {step === 'committing' && (
          <div className="card">
            <div className="section-label">Committing</div>
            <div className="empty-state">
              <span className="spinner" style={{ width: 28, height: 28, borderWidth: 3, margin: '0 auto 16px', display: 'block' }} />
              <p className="empty-text">Creating Gmail drafts and updating Google Sheet…</p>
            </div>
          </div>
        )}

        {/* ── Step: done ── */}
        {step === 'done' && (
          <div className="card">
            <div className="results-header">
              <div className="section-label" style={{ marginBottom: 0 }}>Done</div>
              <span className="lead-count badge-success">{commitResults.length} committed</span>
            </div>
            <div className="done-list">
              {commitResults.map((r, i) => (
                <div key={i} className="done-item">
                  <span className="cell-email">{r.email}</span>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span className="badge badge-success">Draft</span>
                    {r.gmail_draft_url
                      ? <a href={r.gmail_draft_url} target="_blank" rel="noopener noreferrer" className="draft-link">Open in Gmail ↗</a>
                      : <span className="na">—</span>
                    }
                  </div>
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
