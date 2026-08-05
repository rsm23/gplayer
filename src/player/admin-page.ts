import type { AuthUser } from '../auth/auth-service.js'
import type { AdminSession } from '../auth/session-admin-service.js'
import { userRoleLabel, type AdminUserRecord, type UserOption } from '../auth/user-admin-service.js'
import { timezoneList, type GeneralSettingKey, type GeneralSettings, type PublicSettings, type SmtpSettings } from '../settings/settings-admin-service.js'

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
  return adminDocument('Dashboard', `${adminHeader(adminBase, 'dashboard')}
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

  return adminDocument('Sessions', `${adminHeader(input.adminBase, 'sessions')}
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

export function renderAdminGeneralSettings(input: Readonly<{
  adminBase: string
  values: GeneralSettings
  csrfToken: string
  message?: AdminMessage
}>): string {
  const value = (key: GeneralSettingKey): string => escapeHtml(String(input.values[key]))
  const checked = (key: GeneralSettingKey): string => input.values[key] === true ? ' checked' : ''
  const timezoneOptions = timezoneList().map((timezone) => `<option value="${escapeHtml(timezone)}"${input.values.timezone === timezone ? ' selected' : ''}>${escapeHtml(timezone)}</option>`).join('')

  return adminDocument('General settings', `${adminHeader(input.adminBase, 'settings')}
<main class="admin-dashboard admin-settings-page">
  <p class="eyebrow"><span></span>Runtime configuration</p>
  <div class="admin-dashboard-heading"><div><h1>General settings.</h1><p>Manage the legacy-compatible configuration keys that control the Node.js runtime and connected services.</p></div><span class="admin-role">Core</span></div>
  ${renderMessage(input.message)}
  ${settingsSubnav(input.adminBase, 'general')}
  <form class="admin-settings-form" action="${escapeHtml(input.adminBase)}/settings/general/" method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    <section class="settings-section" aria-labelledby="settings-runtime-title">
      <div class="settings-section-heading"><p class="panel-kicker">01 / Runtime</p><h2 id="settings-runtime-title">Application and cache</h2><p>Origin, timezone, runtime mode, and server-side media cache behavior.</p></div>
      <div class="settings-grid">
        ${settingsInput('main_site', 'Main site URL', value('main_site'), 'url', 'https://player.example/', true)}
        <div class="field"><label for="timezone">Timezone</label><select id="timezone" name="timezone" required>${timezoneOptions}</select></div>
        <div class="field"><label for="cache_mode">Cache delivery mode</label><select id="cache_mode" name="cache_mode" required>${stringOption('php', 'Node stream (legacy default)', input.values.cache_mode)}${stringOption('apache', 'Apache X-Sendfile', input.values.cache_mode)}${stringOption('litespeed', 'LiteSpeed X-Litespeed-Location', input.values.cache_mode)}${stringOption('nginx', 'Nginx X-Accel-Redirect', input.values.cache_mode)}</select></div>
        ${settingsInput('cache_file_timeout', 'Proxy cache timeout', value('cache_file_timeout'), 'number', '3600', true, 'Seconds before cached media expires.', '0', '31536000')}
        ${settingsToggle('production_mode', 'Production mode', 'Use production error handling and optimized runtime behavior.', checked('production_mode'))}
        ${settingsToggle('enable_cache_file', 'Cache media files', 'Retain bounded upstream media responses for repeat delivery.', checked('enable_cache_file'))}
        ${settingsToggle('enable_bg_download', 'Background downloads', 'Allow the Node worker layer to continue eligible downloads asynchronously.', checked('enable_bg_download'))}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="settings-drive-title">
      <div class="settings-section-heading"><p class="panel-kicker">02 / Sources</p><h2 id="settings-drive-title">Drive and load balancing</h2><p>Compatibility flags retained for Google media and distributed delivery.</p></div>
      <div class="settings-grid settings-toggle-grid">
        ${settingsToggle('gphotos_hls', 'Google Photos HLS', 'Prefer segmented delivery for eligible Google Photos media.', checked('gphotos_hls'))}
        ${settingsToggle('gdrive_hls', 'Google Drive HLS', 'Prefer segmented delivery for eligible Drive media.', checked('gdrive_hls'))}
        ${settingsToggle('gdrive_copy', 'Drive copy fallback', 'Permit configured Drive mirrors to copy an unavailable source.', checked('gdrive_copy'))}
        ${settingsToggle('gdrive_copy_all', 'Copy every Drive source', 'Apply the copy workflow to all eligible Drive sources.', checked('gdrive_copy_all'))}
        ${settingsToggle('load_balancer_rand', 'Random load balancer', 'Randomize among eligible load-balancer targets.', checked('load_balancer_rand'))}
        ${settingsToggle('disable_validation', 'Disable source validation', 'Retain the legacy override for installations that validate upstream links elsewhere.', checked('disable_validation'))}
        ${settingsToggle('select_active_connections', 'Prefer active-connection counts', 'Use connection telemetry when selecting a load balancer.', checked('select_active_connections'))}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="settings-service-title">
      <div class="settings-section-heading"><p class="panel-kicker">03 / Services</p><h2 id="settings-service-title">API and traffic controls</h2><p>Third-party credentials stay server-side in the legacy settings table and are never bundled into public assets.</p></div>
      <div class="settings-grid">
        ${settingsInput('maxmind_license_key', 'MaxMind license key', value('maxmind_license_key'), 'password', 'Enter license key', false, 'Used for optional country and ASN database updates.')}
        ${settingsInput('anti_captcha', 'Anti-Captcha API key', value('anti_captcha'), 'password', 'Enter API key')}
        ${settingsInput('visit_counter', 'Views per video and IP', value('visit_counter'), 'number', '1', true, '', '1', '1000000')}
        ${settingsInput('visit_counter_runtime', 'Visit counter window', value('visit_counter_runtime'), 'number', '10', true, 'Runtime in seconds.', '0', '86400')}
        ${settingsInput('import_filesize', 'Import file size', value('import_filesize'), 'number', '1024', true, 'Legacy import limit value.', '1', '10000000000')}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="settings-integrations-title">
      <div class="settings-section-heading"><p class="panel-kicker">04 / Integrations</p><h2 id="settings-integrations-title">Analytics and widgets</h2><p>Optional identifiers and embedded support widgets used by public pages.</p></div>
      <div class="settings-grid">
        ${settingsInput('google_analytics_id', 'Google Analytics ID', value('google_analytics_id'), 'text', 'G- or UA- identifier')}
        ${settingsInput('google_tag_manager', 'Google Tag Manager', value('google_tag_manager'), 'text', 'GTM- identifier')}
        ${settingsInput('histats_id', 'Histats ID', value('histats_id'), 'text', 'Site identifier')}
        ${settingsInput('recaptcha_site_key', 'reCAPTCHA site key', value('recaptcha_site_key'), 'text', 'Public site key')}
        ${settingsInput('recaptcha_secret_key', 'reCAPTCHA secret key', value('recaptcha_secret_key'), 'password', 'Server secret')}
        ${settingsInput('disqus_shortname', 'Disqus shortname', value('disqus_shortname'), 'text', 'Community shortname')}
        <div class="field settings-wide"><label for="chat_widget">Chat widget code</label><textarea id="chat_widget" name="chat_widget" rows="7" maxlength="100000" placeholder="Optional HTML or script widget">${value('chat_widget')}</textarea><p class="field-hint">Stored for legacy public-page compatibility. Only trusted administrators should add executable markup.</p></div>
      </div>
    </section>
    <div class="settings-actions"><button class="generate-button" type="submit"><span>Update general settings</span><span aria-hidden="true">↗</span></button><p>Only the allowlisted General Settings keys above are written.</p></div>
  </form>
</main>`)
}

export function renderAdminPublicSettings(input: Readonly<{
  adminBase: string
  values: PublicSettings
  users: readonly UserOption[]
  csrfToken: string
  message?: AdminMessage
}>): string {
  const checked = (key: keyof PublicSettings): string => input.values[key] === true ? ' checked' : ''
  const userOptions = input.users.map((user) => `<option value="${escapeHtml(user.id)}"${input.values.public_video_user === user.id ? ' selected' : ''}>${escapeHtml(user.name)} (${escapeHtml(user.username)})</option>`).join('')

  return adminDocument('Public settings', `${adminHeader(input.adminBase, 'settings')}
<main class="admin-dashboard admin-settings-page">
  <p class="eyebrow"><span></span>Public surface</p>
  <div class="admin-dashboard-heading"><div><h1>Public settings.</h1><p>Control anonymous pages, downloads, registration, and public video ownership with the legacy key contract.</p></div><span class="admin-role">12 keys</span></div>
  ${renderMessage(input.message)}
  ${settingsSubnav(input.adminBase, 'public')}
  <form class="admin-settings-form" action="${escapeHtml(input.adminBase)}/settings/public/" method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    <section class="settings-section" aria-labelledby="public-access-title">
      <div class="settings-section-heading"><p class="panel-kicker">01 / Access</p><h2 id="public-access-title">Embeds and public pages</h2><p>Define which unauthenticated generator and request surfaces are available.</p></div>
      <div class="settings-grid settings-toggle-grid">
        ${settingsToggle('anonymous_generator', 'Enable public pages', 'Allow anonymous visitors to use the public generator and related pages.', checked('anonymous_generator'))}
        ${settingsToggle('embed_only', 'Embed-only playback', 'Restrict the player URL to iframe embedding contexts.', checked('embed_only'))}
        ${settingsToggle('enable_request_url', 'Enable request URL', 'Allow public access to legacy embed2 and request-style URLs.', checked('enable_request_url'))}
        ${settingsToggle('enable_json_subtitles', 'Allow subtitle URLs', 'Permit public embed queries to supply JSON, VTT, or SRT subtitle URLs.', checked('enable_json_subtitles'))}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="public-download-title">
      <div class="settings-section-heading"><p class="panel-kicker">02 / Delivery</p><h2 id="public-download-title">Downloads and sharing</h2><p>Configure the public download experience and optional Drive sharing surface.</p></div>
      <div class="settings-grid settings-toggle-grid">
        ${settingsToggle('enable_download_page', 'Enable download page', 'Allow eligible source files to be delivered through the public download page.', checked('enable_download_page'))}
        ${settingsToggle('show_sub_download', 'Show subtitle downloads', 'List available subtitle files alongside video downloads.', checked('show_sub_download'))}
        ${settingsToggle('show_watch_button', 'Show watch button', 'Provide a return-to-player action from the download page.', checked('show_watch_button'))}
        ${settingsToggle('enable_gsharer', 'Enable Drive sharer', 'Expose the configured Google Drive limit-bypass page.', checked('enable_gsharer'))}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="public-account-title">
      <div class="settings-section-heading"><p class="panel-kicker">03 / Accounts</p><h2 id="public-account-title">Registration and ownership</h2><p>Control public account creation and attribute anonymously generated videos to an existing user.</p></div>
      <div class="settings-grid">
        ${settingsToggle('enable_registration', 'Enable registration', 'Allow visitors to create accounts through the public registration page.', checked('enable_registration'))}
        ${settingsToggle('save_public_video', 'Save public videos', 'Persist videos generated or played by anonymous visitors.', checked('save_public_video'))}
        ${settingsInput('contact_page_link', 'Contact page URL', escapeHtml(String(input.values.contact_page_link)), 'url', 'https://example.com/contact')}
        <div class="field"><label for="public_video_user">Save public videos as</label><select id="public_video_user" name="public_video_user" required>${userOptions || '<option value="">No users available</option>'}</select><p class="field-hint">The selected account must exist when this form is submitted.</p></div>
      </div>
    </section>
    <div class="settings-actions"><button class="generate-button" type="submit"><span>Update public settings</span><span aria-hidden="true">↗</span></button><p>Public feature flags remain dormant until their corresponding Node routes and workers consume them.</p></div>
  </form>
</main>`)
}

export function renderAdminSmtpSettings(input: Readonly<{
  adminBase: string
  values: SmtpSettings
  csrfToken: string
  message?: AdminMessage
}>): string {
  const checked = (value: boolean): string => value ? ' checked' : ''
  const providerOptions = [
    ['', 'Select email provider'],
    ['gmail', 'Gmail'],
    ['ymail', 'Yahoo!'],
    ['outlook', 'Outlook'],
    ['other', 'Other']
  ].map(([value, label]) => stringOption(value ?? '', label ?? '', input.values.smtp_provider)).join('')
  const passwordHint = input.values.smtp_password_configured
    ? 'A password is stored. Leave this blank to preserve it.'
    : 'No SMTP password is currently stored.'

  return adminDocument('SMTP settings', `${adminHeader(input.adminBase, 'settings')}
<main class="admin-dashboard admin-settings-page">
  <p class="eyebrow"><span></span>Email transport</p>
  <div class="admin-dashboard-heading"><div><h1>SMTP settings.</h1><p>Configure registration and password-reset delivery using the complete legacy SMTP key contract.</p></div><span class="admin-role">10 keys</span></div>
  ${renderMessage(input.message)}
  ${settingsSubnav(input.adminBase, 'smtp')}
  <form class="admin-settings-form" action="${escapeHtml(input.adminBase)}/settings/smtp/" method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    <section class="settings-section" aria-labelledby="smtp-policy-title">
      <div class="settings-section-heading"><p class="panel-kicker">01 / Policy</p><h2 id="smtp-policy-title">Verification delivery</h2><p>Choose whether account confirmation and password-reset messages are sent.</p></div>
      <div class="settings-grid settings-toggle-grid">
        ${settingsToggle('disable_confirm', 'Disable confirmation emails', 'Skip registration verification and password-reset email delivery. New addresses will not be verified.', checked(input.values.disable_confirm))}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="smtp-server-title">
      <div class="settings-section-heading"><p class="panel-kicker">02 / Transport</p><h2 id="smtp-server-title">SMTP server</h2><p>Set the provider metadata, connection host, port, and transport encryption.</p></div>
      <div class="settings-grid">
        <div class="field"><label for="smtp_provider">Provider</label><select id="smtp_provider" name="smtp_provider">${providerOptions}</select><p class="field-hint">Provider is retained for legacy compatibility; host and port remain explicit.</p></div>
        ${settingsInput('smtp_host', 'Host', escapeHtml(input.values.smtp_host), 'text', 'smtp.example.com', false, 'Enter a hostname without a scheme or port.')}
        ${settingsInput('smtp_port', 'Port', escapeHtml(input.values.smtp_port), 'number', '587', false, 'Valid TCP port: 1–65535.', '1', '65535')}
        ${settingsToggle('smtp_tls', 'Use TLS', 'Use the legacy TLS transport flag for the SMTP connection.', checked(input.values.smtp_tls))}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="smtp-identity-title">
      <div class="settings-section-heading"><p class="panel-kicker">03 / Identity</p><h2 id="smtp-identity-title">Credentials and sender</h2><p>Keep authentication secrets server-side and define the visible sender and reply-to identity.</p></div>
      <div class="settings-grid">
        ${settingsInput('smtp_email', 'Account email', escapeHtml(input.values.smtp_email), 'email', 'mailer@example.com', false, '', undefined, undefined, 'email')}
        ${settingsInput('smtp_password', 'Password', '', 'password', input.values.smtp_password_configured ? 'Stored password' : 'SMTP password', false, passwordHint, undefined, undefined, 'new-password')}
        ${settingsToggle('clear_smtp_password', 'Remove stored password', 'Explicitly clear the saved SMTP password. Do not combine this with a new password.', '')}
        ${settingsInput('smtp_sender', 'Sender name', escapeHtml(input.values.smtp_sender), 'text', 'No-Reply')}
        ${settingsInput('smtp_reply_email', 'Reply-to email', escapeHtml(input.values.smtp_reply_email), 'email', 'support@example.com', false, '', undefined, undefined, 'email')}
        ${settingsInput('smtp_reply_name', 'Reply-to recipient', escapeHtml(input.values.smtp_reply_name), 'text', 'Support')}
      </div>
    </section>
    <div class="settings-actions"><button class="generate-button" type="submit"><span>Update SMTP settings</span><span aria-hidden="true">↗</span></button><p>The mail transport runtime will consume these values when registration and password-reset delivery is implemented.</p></div>
  </form>
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

function adminHeader(adminBase: string, current: 'dashboard' | 'users' | 'sessions' | 'settings'): string {
  return `<header class="admin-bar">
  <a class="wordmark" href="${escapeHtml(adminBase)}/dashboard/" aria-label="GPlayer dashboard">
    <span class="wordmark-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
    <span>G<span>PLAYER</span><small>NODE</small></span>
  </a>
  <nav class="admin-nav" aria-label="Administration"><a${current === 'dashboard' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/dashboard/">Dashboard</a><a${current === 'users' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/users/">Users</a><a${current === 'sessions' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/users/sessions/">Sessions</a><a${current === 'settings' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/general/">Settings</a></nav>
  <form action="${escapeHtml(adminBase)}/logout/" method="post"><button class="admin-logout" type="submit">Sign out</button></form>
</header>`
}

function settingsInput(
  name: string,
  label: string,
  value: string,
  type: 'text' | 'url' | 'number' | 'password' | 'email',
  placeholder: string,
  required = false,
  hint = '',
  minimum?: string,
  maximum?: string,
  autocomplete?: string
): string {
  const maxlength = type === 'number' ? '' : ` maxlength="${type === 'password' ? '4096' : type === 'email' ? '254' : '100000'}"`
  return `<div class="field"><label for="${name}">${escapeHtml(label)}</label><input id="${name}" name="${name}" type="${type}" value="${value}" placeholder="${escapeHtml(placeholder)}"${maxlength}${required ? ' required' : ''}${minimum === undefined ? '' : ` min="${escapeHtml(minimum)}"`}${maximum === undefined ? '' : ` max="${escapeHtml(maximum)}"`}${autocomplete === undefined ? '' : ` autocomplete="${escapeHtml(autocomplete)}"`}>${hint === '' ? '' : `<p class="field-hint">${escapeHtml(hint)}</p>`}</div>`
}

function settingsToggle(name: string, label: string, description: string, checked: string): string {
  return `<label class="settings-toggle" for="${name}"><span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span><span class="settings-switch"><input type="hidden" name="${name}" value="false"><input id="${name}" name="${name}" type="checkbox" value="true"${checked}><i aria-hidden="true"></i></span></label>`
}

function settingsSubnav(adminBase: string, current: 'general' | 'public' | 'smtp'): string {
  return `<nav class="settings-subnav" aria-label="Settings categories"><a${current === 'general' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/general/">General</a><a${current === 'public' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/public/">Public</a><a${current === 'smtp' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/smtp/">SMTP</a></nav>`
}

function stringOption(value: string, label: string, selected: string | boolean): string {
  return `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(label)}</option>`
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
