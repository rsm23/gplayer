import type { AuthUser } from '../auth/auth-service.js'
import type { AdminSession } from '../auth/session-admin-service.js'
import { userRoleLabel, type AdminUserRecord } from '../auth/user-admin-service.js'

export type AdminMessage = Readonly<{
  kind: 'error' | 'success' | 'info'
  text: string
}>

export function renderAdminLoginPage(adminBase: string, message?: AdminMessage): string {
  const loginUrl = `${adminBase}/login/`
  return adminDocument('Login', `<main class="admin-auth-main">
  <section class="admin-auth-copy" aria-labelledby="login-heading">
    <a class="wordmark" href="/" aria-label="GPlayer home">
      <span class="wordmark-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
      <span>G<span>PLAYER</span><small>NODE</small></span>
    </a>
    <p class="eyebrow"><span></span>Secure administration</p>
    <h1 id="login-heading">Welcome back.</h1>
    <p>Manage sources, users, settings, and delivery from the Node.js control plane.</p>
  </section>
  <section class="admin-auth-panel" aria-label="Administrator login">
    <div><p class="panel-kicker">Account access</p><h2>Sign in</h2></div>
    ${renderMessage(message)}
    <form class="admin-login-form" action="${escapeHtml(loginUrl)}" method="post">
      <div class="field"><label for="username">Username or email</label><input id="username" name="username" type="text" autocomplete="username" maxlength="254" required></div>
      <div class="field"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="1024" required></div>
      <label class="admin-check"><input name="remember" type="checkbox" value="1"><span>Keep me signed in for 7 days</span></label>
      <button class="generate-button" type="submit"><span>Sign in</span><span aria-hidden="true">↗</span></button>
    </form>
  </section>
</main>`)
}

export function renderAdminDashboard(adminBase: string, user: AuthUser): string {
  const role = ['Admin', 'User', 'Premium'][user.role] ?? 'User'
  return adminDocument('Dashboard', `<header class="admin-bar">
  <a class="wordmark" href="${escapeHtml(adminBase)}/dashboard/" aria-label="GPlayer dashboard">
    <span class="wordmark-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
    <span>G<span>PLAYER</span><small>NODE</small></span>
  </a>
  <form action="${escapeHtml(adminBase)}/logout/" method="post"><button class="admin-logout" type="submit">Sign out</button></form>
</header>
<main class="admin-dashboard">
  <p class="eyebrow"><span></span>Control plane</p>
  <div class="admin-dashboard-heading"><div><h1>Good to see you, ${escapeHtml(user.name)}.</h1><p>The authenticated Node.js administration boundary is active.</p></div><span class="admin-role">${escapeHtml(role)}</span></div>
  <section class="admin-status-grid" aria-label="Administration status">
    <article><span>Session</span><strong>Authenticated</strong><p>Bound to this browser user agent and backed by the legacy-compatible session table.</p></article>
    <article><span>Runtime</span><strong>Node 24</strong><p>No PHP process is loaded by the application runtime.</p></article>
    <article><span>Account</span><strong>${escapeHtml(user.username)}</strong><p>${escapeHtml(user.email)}</p></article>
  </section>
  <section class="admin-next"><p class="section-index">Management</p><h2>Session control is online.</h2><p>Inspect active and historical browser sessions, then revoke individual records without exposing authentication tokens.</p><a class="hero-link-primary" href="${escapeHtml(adminBase)}/users/sessions/">Manage sessions <span aria-hidden="true">↗</span></a></section>
</main>`)
}

export function renderAdminSessions(input: Readonly<{
  adminBase: string
  sessions: readonly AdminSession[]
  recordsTotal: number
  csrfToken: string
  message?: AdminMessage
}>): string {
  const rows = input.sessions.map((session) => `<tr>
    <td><span class="session-id">#${escapeHtml(session.id)}</span></td>
    <td><strong>${escapeHtml(session.username || 'Unknown')}</strong></td>
    <td><code>${escapeHtml(session.ip)}</code></td>
    <td class="session-agent" title="${escapeHtml(session.useragent)}">${escapeHtml(session.useragent || 'Unknown browser')}</td>
    <td>${renderTimestamp(session.created, 'Not recorded')}</td>
    <td>${renderTimestamp(session.expires, 'Expired')}</td>
    <td><form action="${escapeHtml(input.adminBase)}/users/sessions/delete/" method="post">
      <input type="hidden" name="id" value="${escapeHtml(session.id)}">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
      <button class="session-revoke" type="submit" aria-label="Revoke session ${escapeHtml(session.id)}">Revoke</button>
    </form></td>
  </tr>`).join('')

  return adminDocument('Sessions', `<header class="admin-bar">
  <a class="wordmark" href="${escapeHtml(input.adminBase)}/dashboard/" aria-label="GPlayer dashboard">
    <span class="wordmark-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
    <span>G<span>PLAYER</span><small>NODE</small></span>
  </a>
  <nav class="admin-nav" aria-label="Administration"><a href="${escapeHtml(input.adminBase)}/dashboard/">Dashboard</a><a href="${escapeHtml(input.adminBase)}/users/">Users</a><a aria-current="page" href="${escapeHtml(input.adminBase)}/users/sessions/">Sessions</a></nav>
  <form action="${escapeHtml(input.adminBase)}/logout/" method="post"><button class="admin-logout" type="submit">Sign out</button></form>
</header>
<main class="admin-dashboard admin-sessions-page">
  <p class="eyebrow"><span></span>Access control</p>
  <div class="admin-dashboard-heading"><div><h1>Session list.</h1><p>Review the legacy-compatible session ledger. Authentication tokens are never rendered.</p></div><span class="admin-role">${input.recordsTotal} total</span></div>
  ${renderMessage(input.message)}
  <section class="session-table-shell" aria-labelledby="sessions-table-title">
    <div class="session-table-heading"><div><p class="panel-kicker">Browser access</p><h2 id="sessions-table-title">Latest sessions</h2></div><a href="${escapeHtml(input.adminBase)}/users/sessions/">Reload</a></div>
    <div class="session-table-scroll"><table class="session-table">
      <thead><tr><th>ID</th><th>Username</th><th>IP</th><th>User agent</th><th>Created</th><th>Expires</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${rows || '<tr><td class="session-empty" colspan="7">No session records found.</td></tr>'}</tbody>
    </table></div>
    ${input.recordsTotal > input.sessions.length ? `<p class="session-table-note">Showing the latest ${input.sessions.length} of ${input.recordsTotal} records. The legacy DataTables endpoint supports paginated access to the complete ledger.</p>` : ''}
  </section>
</main>`)
}

export function renderAdminUsers(input: Readonly<{
  adminBase: string
  users: readonly AdminUserRecord[]
  recordsTotal: number
  csrfToken: string
  search: string
  message?: AdminMessage
}>): string {
  const rows = input.users.map((user) => `<tr>
    <td><strong>${escapeHtml(user.name)}</strong><span class="user-email-mobile">${escapeHtml(user.email)}</span></td>
    <td><code>${escapeHtml(user.username)}</code></td>
    <td>${escapeHtml(user.email)}</td>
    <td><span class="user-state user-state-${user.status}">${escapeHtml(userStatusLabel(user.status))}</span></td>
    <td><span class="admin-role">${escapeHtml(userRoleLabel(user.role))}</span></td>
    <td><span class="user-video-count">${user.videos}</span></td>
    <td>${renderTimestamp(user.updated, 'Not updated')}</td>
    <td><div class="user-actions">
      <a href="${escapeHtml(input.adminBase)}/users/edit/?id=${escapeHtml(user.id)}">Edit</a>
      <form action="${escapeHtml(input.adminBase)}/users/delete/" method="post">
        <input type="hidden" name="id" value="${escapeHtml(user.id)}">
        <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
        <button class="session-revoke" type="submit" aria-label="Delete ${escapeHtml(user.name)}">Delete</button>
      </form>
    </div></td>
  </tr>`).join('')

  return adminDocument('Users', `${adminHeader(input.adminBase, 'users')}
<main class="admin-dashboard admin-users-page">
  <p class="eyebrow"><span></span>Identity management</p>
  <div class="admin-dashboard-heading"><div><h1>User list.</h1><p>Create, review, and update accounts backed by the legacy-compatible user table.</p></div><span class="admin-role">${input.recordsTotal} total</span></div>
  ${renderMessage(input.message)}
  <section class="user-toolbar" aria-label="User controls">
    <a class="hero-link-primary" href="${escapeHtml(input.adminBase)}/users/new/">Add user <span aria-hidden="true">+</span></a>
    <form action="${escapeHtml(input.adminBase)}/users/" method="get" role="search"><label class="sr-only" for="user-search">Search users</label><input id="user-search" name="q" type="search" value="${escapeHtml(input.search)}" placeholder="Search name, username, or email"><button type="submit">Search</button></form>
  </section>
  <section class="session-table-shell user-table-shell" aria-labelledby="users-table-title">
    <div class="session-table-heading"><div><p class="panel-kicker">Accounts</p><h2 id="users-table-title">Latest users</h2></div><a href="${escapeHtml(input.adminBase)}/users/">Reload</a></div>
    <div class="session-table-scroll"><table class="session-table user-table">
      <thead><tr><th>Name</th><th>Username</th><th>Email</th><th>Status</th><th>Role</th><th>Links</th><th>Updated</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${rows || '<tr><td class="session-empty" colspan="8">No users found.</td></tr>'}</tbody>
    </table></div>
    ${input.recordsTotal > input.users.length ? `<p class="session-table-note">Showing ${input.users.length} of ${input.recordsTotal} records. Use the legacy DataTables endpoint for complete pagination.</p>` : ''}
  </section>
</main>`)
}

export function renderAdminUserForm(input: Readonly<{
  adminBase: string
  csrfToken: string
  user?: AdminUserRecord
  values?: Readonly<Record<string, string>>
  message?: AdminMessage
}>): string {
  const edit = input.user !== undefined
  const values = input.values ?? {}
  const value = (key: string, fallback = ''): string => escapeHtml(values[key] ?? fallback)
  const role = Number(values.role ?? input.user?.role ?? -1)
  const status = Number(values.status ?? input.user?.status ?? -1)
  const action = edit ? `${input.adminBase}/users/edit/` : `${input.adminBase}/users/new/`

  return adminDocument(edit ? 'Edit user' : 'New user', `${adminHeader(input.adminBase, 'users')}
<main class="admin-dashboard admin-user-form-page">
  <p class="eyebrow"><span></span>${edit ? 'Account update' : 'Account creation'}</p>
  <div class="admin-dashboard-heading"><div><h1>${edit ? 'Edit user.' : 'New user.'}</h1><p>${edit ? 'Update account identity, access state, role, or password.' : 'Create a user in the legacy-compatible account schema.'}</p></div><a class="admin-back-link" href="${escapeHtml(input.adminBase)}/users/">Back to users</a></div>
  <section class="admin-user-form-shell">
    ${renderMessage(input.message)}
    <form class="admin-user-form" action="${escapeHtml(action)}" method="post">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
      ${edit ? `<input type="hidden" name="id" value="${escapeHtml(input.user?.id ?? '')}">` : ''}
      <div class="admin-user-form-grid">
        <div class="field"><label for="name">Full name</label><input id="name" name="name" type="text" maxlength="50" value="${value('name', input.user?.name)}" autocomplete="name" required></div>
        <div class="field"><label for="user">Username</label><input id="user" name="user" type="text" maxlength="50" value="${value('user', input.user?.username)}" autocomplete="username" required></div>
        <div class="field admin-user-form-wide"><label for="email">Email</label><input id="email" name="email" type="email" maxlength="254" value="${value('email', input.user?.email)}" autocomplete="email" required></div>
        <div class="field"><label for="role">User role</label><select id="role" name="role" required><option value="">Select role</option>${selectOption(0, 'Administrator', role)}${selectOption(1, 'User', role)}${selectOption(2, 'User Premium', role)}</select></div>
        <div class="field"><label for="status">Status</label><select id="status" name="status" required><option value="">Select status</option>${selectOption(0, 'Inactive', status)}${selectOption(1, 'Active', status)}${selectOption(2, 'Need Approval', status)}</select></div>
        <div class="field"><label for="password">${edit ? 'New password' : 'Password'}</label><input id="password" name="password" type="password" minlength="8" maxlength="1024" pattern="[^ ]{8,}" autocomplete="new-password" ${edit ? '' : 'required'}><p class="field-hint">${edit ? 'Leave blank to keep the current password.' : 'At least 8 characters without spaces.'}</p></div>
        <div class="field"><label for="retype_password">Confirm ${edit ? 'new ' : ''}password</label><input id="retype_password" name="retype_password" type="password" minlength="8" maxlength="1024" pattern="[^ ]{8,}" autocomplete="new-password" ${edit ? '' : 'required'}></div>
      </div>
      <button class="generate-button" type="submit"><span>${edit ? 'Update user' : 'Create user'}</span><span aria-hidden="true">↗</span></button>
    </form>
  </section>
</main>`)
}

export function renderAdminError(adminBase: string, status: 403 | 404 | 503, description: string): string {
  const title = status === 403 ? 'Access denied.' : status === 404 ? 'User not found.' : 'Service unavailable.'
  return adminDocument(String(status), `<main class="admin-error-main">
  <p class="eyebrow"><span></span>HTTP ${status}</p>
  <h1>${title}</h1>
  <p>${escapeHtml(description)}</p>
  <a class="hero-link-primary" href="${escapeHtml(adminBase)}/login/">Return to login <span aria-hidden="true">↗</span></a>
</main>`)
}

function adminDocument(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#0b0e0c">
  <title>${escapeHtml(title)} | GPlayer administration</title>
  <link rel="icon" href="/assets/img/logo/rr.ico">
  <link rel="stylesheet" href="/assets/css/gplayer-landing.css">
  <link rel="stylesheet" href="/assets/css/gplayer-public.css">
</head>
<body class="admin-body">${body}</body>
</html>`
}

function renderMessage(message?: AdminMessage): string {
  return message === undefined ? '' : `<div class="admin-message admin-message-${message.kind}" role="alert">${escapeHtml(message.text)}</div>`
}

function renderTimestamp(value: number, fallback: string): string {
  if (!Number.isSafeInteger(value) || value <= 0) return `<span class="session-time-muted">${escapeHtml(fallback)}</span>`
  const date = new Date(value * 1_000)
  if (Number.isNaN(date.getTime())) return `<span class="session-time-muted">${escapeHtml(fallback)}</span>`
  const iso = date.toISOString()
  return `<time datetime="${iso}">${iso.slice(0, 16).replace('T', ' ')} UTC</time>`
}

function adminHeader(adminBase: string, current: 'users' | 'sessions'): string {
  return `<header class="admin-bar">
  <a class="wordmark" href="${escapeHtml(adminBase)}/dashboard/" aria-label="GPlayer dashboard">
    <span class="wordmark-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
    <span>G<span>PLAYER</span><small>NODE</small></span>
  </a>
  <nav class="admin-nav" aria-label="Administration"><a href="${escapeHtml(adminBase)}/dashboard/">Dashboard</a><a${current === 'users' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/users/">Users</a><a${current === 'sessions' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/users/sessions/">Sessions</a></nav>
  <form action="${escapeHtml(adminBase)}/logout/" method="post"><button class="admin-logout" type="submit">Sign out</button></form>
</header>`
}

function userStatusLabel(status: number): string {
  return ['Inactive', 'Active', 'Need Approval'][status] ?? 'Unknown'
}

function selectOption(value: number, label: string, selected: number): string {
  return `<option value="${value}"${selected === value ? ' selected' : ''}>${escapeHtml(label)}</option>`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
