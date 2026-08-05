import type { AuthUser } from '../auth/auth-service.js'
import type { AdminSession } from '../auth/session-admin-service.js'
import { userRoleLabel, type AdminUserRecord, type UserOption } from '../auth/user-admin-service.js'
import type { CustomHeaderRule } from '../settings/custom-headers.js'
import { MISC_COUNTRY_OPTIONS, MISC_RESOLUTION_OPTIONS, miscHostOptions, type MiscSettings } from '../settings/misc-settings.js'
import type { HostingSettings } from '../settings/hosting-settings.js'
import { PLAYER_CHOICES, PLAYER_EDGE_STYLES, PLAYER_FONTS, PLAYER_LANGUAGE_OPTIONS, PLAYER_LOADERS, PLAYER_LOGO_POSITIONS, PLAYER_PRELOAD, PLAYER_RESOLUTIONS, PLAYER_SKINS, PLAYER_STRETCHING, type PlayerSettings } from '../settings/player-settings.js'
import { shortenerProviderList, timezoneList, type AdsSettings, type GeneralSettingKey, type GeneralSettings, type PublicSettings, type ShortlinkSettings, type SiteSettings, type SmtpSettings } from '../settings/settings-admin-service.js'
import type { VastAsset } from '../settings/vast-assets-service.js'
import type { SubtitleAdminRecord } from '../subtitles/subtitle-admin-service.js'
import type { StoredVideoDetail, VideoAdminRecord } from '../videos/video-admin-service.js'

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
  return adminDocument('Dashboard', `${adminHeader(adminBase, 'dashboard', user.role === 0)}
<main class="admin-dashboard">
  <p class="eyebrow"><span></span>Control plane</p>
  <div class="admin-dashboard-heading"><div><h1>Good to see you, ${escapeHtml(user.name)}.</h1><p>The authenticated Node.js administration boundary is active.</p></div><span class="admin-role">${escapeHtml(role)}</span></div>
  <section class="admin-status-grid" aria-label="Administration status">
    <article><span>Session</span><strong>Authenticated</strong><p>Bound to this browser user agent and backed by the legacy-compatible session table.</p></article>
    <article><span>Runtime</span><strong>Node 24</strong><p>No PHP process is loaded by the application runtime.</p></article>
    <article><span>Account</span><strong>${escapeHtml(user.username)}</strong><p>${escapeHtml(user.email)}</p></article>
  </section>
  <section class="admin-next"><p class="section-index">Management</p><h2>Your media control plane is online.</h2><p>Create stable saved-video links, attach fallback sources and captions, and maintain uploaded subtitle assets from the authenticated Node.js administration surface.</p><div class="admin-next-actions"><a class="hero-link-primary" href="${escapeHtml(adminBase)}/videos/list/">Manage videos <span aria-hidden="true">↗</span></a><a class="admin-back-link" href="${escapeHtml(adminBase)}/videos/subtitles/">Subtitle Manager</a>${user.role === 0 ? `<a class="admin-back-link" href="${escapeHtml(adminBase)}/users/sessions/">Sessions</a>` : ''}</div></section>
</main>`)
}

export function renderAdminSubtitles(input: Readonly<{
  adminBase: string
  subtitles: readonly SubtitleAdminRecord[]
  recordsTotal: number
  search: string
  isAdmin: boolean
  hosts: readonly string[]
  uploadCsrfToken: string
  renameCsrfToken: string
  deleteCsrfToken: string
  migrateCsrfToken: string
  message?: AdminMessage
}>): string {
  const languageOptions = ['Unknown CC', ...PLAYER_LANGUAGE_OPTIONS.map((item) => item.value)]
    .filter((value, index, values) => values.indexOf(value) === index)
    .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join('')
  const rows = input.subtitles.map((subtitle) => `<tr>
    <td><span class="session-id">#${escapeHtml(subtitle.id)}</span></td>
    <td><a class="subtitle-file-link" href="${escapeHtml(subtitle.link)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(subtitle.fileName)}</strong><span>Open subtitle ↗</span></a></td>
    <td><span class="subtitle-language">${escapeHtml(subtitle.language)}</span></td>
    <td>${escapeHtml(subtitle.userName)}</td>
    <td><code class="subtitle-host" title="${escapeHtml(subtitle.host)}">${escapeHtml(subtitle.host)}</code></td>
    <td>${renderTimestamp(subtitle.created, 'Not recorded')}</td>
    <td>${renderTimestamp(subtitle.updated, 'Not updated')}</td>
    <td><div class="subtitle-actions">
      <form action="${escapeHtml(input.adminBase)}/videos/subtitles/rename/" method="post">
        <input type="hidden" name="csrf" value="${escapeHtml(input.renameCsrfToken)}"><input type="hidden" name="id" value="${escapeHtml(subtitle.id)}">
        <label class="sr-only" for="subtitle-name-${escapeHtml(subtitle.id)}">Rename subtitle ${escapeHtml(subtitle.id)}</label><input id="subtitle-name-${escapeHtml(subtitle.id)}" name="name" type="text" value="${escapeHtml(subtitle.fileName)}" maxlength="255" required>
        <button type="submit">Rename</button>
      </form>
      <form action="${escapeHtml(input.adminBase)}/videos/subtitles/delete/" method="post">
        <input type="hidden" name="csrf" value="${escapeHtml(input.deleteCsrfToken)}"><input type="hidden" name="id" value="${escapeHtml(subtitle.id)}">
        <button class="session-revoke" type="submit" aria-label="Delete ${escapeHtml(subtitle.fileName)}">Delete</button>
      </form>
    </div></td>
  </tr>`).join('')
  const hostOptions = input.hosts.map((host) => `<option value="${escapeHtml(host)}">${escapeHtml(host)}</option>`).join('')
  const migration = !input.isAdmin ? '' : `<section class="settings-section subtitle-migration" aria-labelledby="subtitle-migration-title">
    <div class="settings-section-heading"><p class="panel-kicker">Admin tool</p><h2 id="subtitle-migration-title">Migrate location</h2><p>Rewrite persisted subtitle URLs and manager hosts when this installation moves to a new public base URL.</p></div>
    <form class="settings-grid" action="${escapeHtml(input.adminBase)}/videos/subtitles/migrate/" method="post">
      <input type="hidden" name="csrf" value="${escapeHtml(input.migrateCsrfToken)}">
      <div class="field"><label for="oldLocation">Old location</label><select id="oldLocation" name="oldLocation" required><option value="">Select location</option>${hostOptions}</select></div>
      <div class="field"><label for="newLocation">New location</label><input id="newLocation" name="newLocation" type="url" maxlength="2048" placeholder="https://player.example/" required></div>
      <button class="generate-button settings-wide" type="submit"><span>Migrate subtitle URLs</span><span aria-hidden="true">↗</span></button>
    </form>
  </section>`

  return adminDocument('Subtitle Manager', `${adminHeader(input.adminBase, 'subtitles', input.isAdmin)}
<main class="admin-dashboard admin-subtitles-page">
  <p class="eyebrow"><span></span>Media library</p>
  <div class="admin-dashboard-heading"><div><h1>Subtitle Manager.</h1><p>Upload, review, rename, and remove caption assets through the legacy-compatible per-user library.</p></div><span class="admin-role">${input.recordsTotal} total</span></div>
  ${renderMessage(input.message)}
  <section class="subtitle-upload-shell" aria-labelledby="subtitle-upload-title">
    <div><p class="panel-kicker">Upload</p><h2 id="subtitle-upload-title">Add a subtitle file</h2><p>Up to 2 MiB. SRT, VTT, ASS, SUB, STL, DFXP, TTML, SBV, and TXT are accepted.</p></div>
    <form action="${escapeHtml(input.adminBase)}/videos/subtitles/upload/" method="post" enctype="multipart/form-data">
      <input type="hidden" name="csrf" value="${escapeHtml(input.uploadCsrfToken)}">
      <div class="field"><label for="uploadSubLang">Language</label><select id="uploadSubLang" name="uploadSubLang">${languageOptions}</select></div>
      <div class="field"><label for="uploadSubFile">Subtitle file</label><input id="uploadSubFile" name="uploadSubFile" type="file" accept=".srt,.vtt,.ass,.sub,.stl,.dfxp,.ttml,.sbv,.txt" required></div>
      <button class="generate-button" type="submit"><span>Upload subtitle</span><span aria-hidden="true">↗</span></button>
    </form>
  </section>
  <section class="user-toolbar subtitle-toolbar" aria-label="Subtitle controls">
    <form action="${escapeHtml(input.adminBase)}/videos/subtitles/" method="get" role="search"><label class="sr-only" for="subtitle-search">Search subtitles</label><input id="subtitle-search" name="q" type="search" value="${escapeHtml(input.search)}" placeholder="Search filename, language, user, or host"><button type="submit">Search</button></form>
    <a class="admin-back-link" href="${escapeHtml(input.adminBase)}/videos/subtitles/">Reload</a>
  </section>
  <section class="session-table-shell subtitle-table-shell" aria-labelledby="subtitles-table-title">
    <div class="session-table-heading"><div><p class="panel-kicker">Caption assets</p><h2 id="subtitles-table-title">Stored files</h2></div><span>${input.isAdmin ? 'All users' : 'Your files'} · scroll →</span></div>
    <div class="session-table-scroll"><table class="session-table subtitle-table"><thead><tr><th>ID</th><th>File name</th><th>Language</th><th>User</th><th>Host</th><th>Created</th><th>Updated</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows || '<tr><td class="session-empty" colspan="8">No subtitle files found.</td></tr>'}</tbody></table></div>
    ${input.recordsTotal > input.subtitles.length ? `<p class="session-table-note">Showing ${input.subtitles.length} of ${input.recordsTotal} records. The legacy DataTables endpoint provides complete pagination.</p>` : ''}
  </section>
  ${migration}
</main>`)
}

export function renderAdminVideos(input: Readonly<{
  adminBase: string
  videos: readonly VideoAdminRecord[]
  recordsTotal: number
  search: string
  status: string
  dmca: string
  isAdmin: boolean
  mutationCsrfToken: string
  bulkCsrfToken: string
  transferCsrfToken: string
  importFileSizeKiB: number
  message?: AdminMessage
}>): string {
  const rows = input.videos.map((video) => `<tr>
    <td><label class="video-export-choice"><input type="checkbox" name="ids[]" value="${escapeHtml(video.id)}" form="video-export-form" data-video-selection aria-label="Select ${escapeHtml(video.title || `video ${video.id}`)}"><span class="session-id">#${escapeHtml(video.id)}</span></label></td>
    <td><a class="video-title-link" href="${escapeHtml(input.adminBase)}/videos/edit/?id=${escapeHtml(video.id)}"><strong>${escapeHtml(video.title || 'Untitled video')}</strong><span>${escapeHtml(video.slug)}</span></a></td>
    <td><a class="video-host-link" href="${escapeHtml(video.mainUrl)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(video.host)}</strong><span>Open source ↗</span></a></td>
    <td><span class="video-state video-state-${video.status}" data-video-status="${escapeHtml(video.id)}">${escapeHtml(videoStatusLabel(video.status))}</span>${video.dmca > 0 ? '<span class="video-dmca">DMCA</span>' : ''}</td>
    <td>${video.views.toLocaleString('en-US')}</td>
    <td>${escapeHtml(video.userName)}</td>
    <td>${renderTimestamp(video.updated, 'Not updated')}</td>
    <td><div class="video-row-actions">
      <a href="${escapeHtml(video.embedUrl)}" target="_blank" rel="noopener noreferrer">Embed</a>
      <a href="${escapeHtml(input.adminBase)}/videos/edit/?id=${escapeHtml(video.id)}">Edit</a>
      ${input.isAdmin ? `<form action="${escapeHtml(input.adminBase)}/videos/dmca/" method="post"><input type="hidden" name="csrf" value="${escapeHtml(input.mutationCsrfToken)}"><input type="hidden" name="id" value="${escapeHtml(video.id)}"><input type="hidden" name="takedown" value="${video.dmca > 0 ? '0' : '1'}"><button type="submit">${video.dmca > 0 ? 'Restore' : 'DMCA'}</button></form>` : ''}
      <form action="${escapeHtml(input.adminBase)}/videos/delete/" method="post"><input type="hidden" name="csrf" value="${escapeHtml(input.mutationCsrfToken)}"><input type="hidden" name="id" value="${escapeHtml(video.id)}"><button class="session-revoke" type="submit" aria-label="Delete ${escapeHtml(video.title || `video ${video.id}`)}">Delete</button></form>
    </div></td>
  </tr>`).join('')

  return adminDocument('Video Manager', `${adminHeader(input.adminBase, 'videos', input.isAdmin)}
<main class="admin-dashboard admin-videos-page">
  <p class="eyebrow"><span></span>Saved playback</p>
  <div class="admin-dashboard-heading"><div><h1>Video Manager.</h1><p>Create stable player links backed by the legacy-compatible video, alternative, subtitle, and source-cache tables.</p></div><span class="admin-role">${input.recordsTotal} total</span></div>
  ${renderMessage(input.message)}
  <section class="user-toolbar video-toolbar" aria-label="Video controls">
    <a class="hero-link-primary" href="${escapeHtml(input.adminBase)}/videos/new/">Add video <span aria-hidden="true">+</span></a>
    <form action="${escapeHtml(input.adminBase)}/videos/list/" method="get" role="search">
      <label class="sr-only" for="video-search">Search videos</label><input id="video-search" name="q" type="search" value="${escapeHtml(input.search)}" placeholder="Search title, host, source ID, slug, or user">
      <label class="sr-only" for="video-status-filter">Status</label><select id="video-status-filter" name="status"><option value="">Any status</option>${selectStringOption('0', 'Good', input.status)}${selectStringOption('1', 'Broken', input.status)}${selectStringOption('2', 'Warning', input.status)}</select>
      ${input.isAdmin ? `<label class="sr-only" for="video-dmca-filter">DMCA</label><select id="video-dmca-filter" name="dmca"><option value="">Any DMCA state</option>${selectStringOption('0', 'Available', input.dmca)}${selectStringOption('1', 'Takedown', input.dmca)}</select>` : ''}
      <button type="submit">Filter</button>
    </form>
  </section>
  <section class="video-transfer-grid" aria-label="Video import and export">
    <form class="video-transfer-card" action="${escapeHtml(input.adminBase)}/videos/import/" method="post" enctype="multipart/form-data">
      <input type="hidden" name="csrf" value="${escapeHtml(input.transferCsrfToken)}">
      <div><p class="panel-kicker">Import CSV</p><h2>Add a video list</h2><p>Legacy-compatible repeated video and subtitle columns. Maximum ${input.importFileSizeKiB.toLocaleString('en-US')} KiB.</p></div>
      <div class="field"><label for="video-import-file">Comma-separated file</label><input id="video-import-file" name="importVideos" type="file" accept=".csv,text/csv" required></div>
      <button class="admin-back-link" type="submit">Import videos</button>
    </form>
    <form id="video-export-form" class="video-transfer-card" action="${escapeHtml(input.adminBase)}/videos/export/" method="post">
      <input type="hidden" name="csrf" value="${escapeHtml(input.transferCsrfToken)}">
      <div><p class="panel-kicker">Export CSV</p><h2>Download selected videos</h2><p>Select rows below. Main sources, ordered alternatives, and attached subtitle labels are preserved.</p></div>
      <button class="admin-back-link" type="submit">Export selection</button>
    </form>
    <form class="video-transfer-card video-checker-card" action="${escapeHtml(input.adminBase)}/videos/check/" method="post" data-video-checker data-max-videos="100">
      <input type="hidden" name="csrf" value="${escapeHtml(input.mutationCsrfToken)}">
      <div><p class="panel-kicker">Video checker</p><h2>Validate selected videos</h2><p>Resolve each selected video and its ordered alternatives. Results are saved as Good or Broken.</p></div>
      <button class="admin-back-link" type="submit">Check selection</button>
      <div class="video-checker-progress" data-video-checker-progress hidden><progress max="1" value="0"></progress><output aria-live="polite">Ready</output></div>
    </form>
  </section>
  <section class="video-bulk-panel" aria-labelledby="video-bulk-title">
    <form class="video-bulk-form" action="${escapeHtml(input.adminBase)}/videos/bulk/" method="post" data-video-bulk data-max-videos="1000" data-delete-url="${escapeHtml(input.adminBase)}/videos/delete/" data-edit-url="${escapeHtml(input.adminBase)}/videos/edit/" data-mutation-csrf="${escapeHtml(input.mutationCsrfToken)}">
      <input type="hidden" name="csrf" value="${escapeHtml(input.bulkCsrfToken)}">
      <div class="video-bulk-heading"><div><p class="panel-kicker">Add bulk videos</p><h2 id="video-bulk-title">Resolve and save video URLs</h2></div><span>Sequential source check</span></div>
      <p>Paste one video URL per line. Each source is checked directly, then saved with its resolved title, poster, captions, and exact Good or Broken status.</p>
      <div class="field"><label for="video-bulk-links">Video URLs</label><textarea id="video-bulk-links" name="links" rows="8" maxlength="2049000" required placeholder="https://video-host.example/watch/first&#10;https://video-host.example/watch/second"></textarea></div>
      <label class="video-bulk-title-slug"><input type="checkbox" name="useTitle" value="true"><span><strong>Use title as slug</strong><small>When a title is available, create a unique readable player slug from it.</small></span></label>
      <div class="video-bulk-actions"><button class="admin-back-link" type="submit">Add videos</button><div class="video-bulk-progress" data-video-bulk-progress hidden><progress max="1" value="0"></progress><output aria-live="polite">Ready</output></div></div>
    </form>
    <div class="video-bulk-results" data-video-bulk-results hidden>
      <div class="session-table-heading"><div><p class="panel-kicker">Bulk results</p><h3>Resolved videos</h3></div><a href="${escapeHtml(input.adminBase)}/videos/list/">Refresh manager ↗</a></div>
      <div class="session-table-scroll"><table class="session-table video-bulk-table"><thead><tr><th>Title</th><th>Source</th><th>Subtitles</th><th>Created</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody data-video-bulk-rows></tbody></table></div>
    </div>
  </section>
  <section class="session-table-shell video-table-shell" aria-labelledby="videos-table-title">
    <div class="session-table-heading"><div><p class="panel-kicker">Saved videos</p><h2 id="videos-table-title">Playback links</h2></div><span>${input.isAdmin ? 'All users' : 'Your videos'} · scroll →</span></div>
    <div class="session-table-scroll"><table class="session-table video-table"><thead><tr><th>ID</th><th>Title</th><th>Host</th><th>Status</th><th>Views</th><th>User</th><th>Updated</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows || '<tr><td class="session-empty" colspan="8">No videos found.</td></tr>'}</tbody></table></div>
    ${input.recordsTotal > input.videos.length ? `<p class="session-table-note">Showing ${input.videos.length} of ${input.recordsTotal} records. The legacy DataTables endpoint provides complete pagination.</p>` : ''}
  </section>
</main>`)
}

export function renderAdminVideoForm(input: Readonly<{
  adminBase: string
  isAdmin: boolean
  csrfToken: string
  video?: StoredVideoDetail
  mainUrl?: string
  alternativeUrls?: readonly string[]
  posterUrl?: string
  embedUrl?: string
  downloadUrl?: string
  embedCode?: string
  values?: Readonly<Record<string, unknown>>
  message?: AdminMessage
}>): string {
  const edit = input.video !== undefined
  const value = (name: string, fallback = ''): string => {
    const current = input.values?.[name]
    return typeof current === 'string' ? current : fallback
  }
  const valueArray = (primary: string, fallback: string): string[] => {
    const current = input.values?.[primary] ?? input.values?.[fallback]
    if (Array.isArray(current)) return current.filter((item): item is string => typeof item === 'string')
    return typeof current === 'string' ? [current] : []
  }
  const title = value('title', input.video?.title ?? '')
  const mainUrl = value('host_id', input.mainUrl ?? '')
  const slug = value('slug', input.video?.slug ?? '')
  const storedPosterInput = /^https?:\/\//iu.test(input.video?.poster ?? '') ? input.video?.poster ?? '' : ''
  const posterUrl = value('poster-url', storedPosterInput)
  const submittedAlternatives = valueArray('altLinks[]', 'altLinks')
  const alternatives = input.values === undefined ? input.alternativeUrls ?? [] : submittedAlternatives
  const alternativeRows = [...alternatives, ''].slice(0, 20).map((url, index) => videoAlternativeRow(url, index)).join('')
  const submittedSubtitleUrls = valueArray('sub-url[]', 'sub-url')
  const submittedSubtitleLanguages = valueArray('lang-url[]', 'lang-url')
  const storedSubtitles = input.video?.subtitles ?? []
  const existingSubtitles = input.values === undefined
    ? storedSubtitles.map((subtitle, index) => videoSubtitleRow(subtitle.link, subtitle.language, index)).join('')
    : submittedSubtitleUrls.map((url, index) => videoSubtitleRow(url, submittedSubtitleLanguages[index] ?? 'Unknown CC', index)).join('')
  const subtitleOffset = input.values === undefined ? storedSubtitles.length : submittedSubtitleUrls.length
  const newSubtitles = [0, 1].map((index) => videoSubtitleRow('', '', subtitleOffset + index, true)).join('')
  const bulkAlternatives = value('multiAltUrls')
  const bulkSubtitles = value('multiSubUrls')
  const action = edit ? `${input.adminBase}/videos/edit/?id=${encodeURIComponent(input.video?.id ?? '')}` : `${input.adminBase}/videos/new/`
  const posterPreview = !edit || input.posterUrl === undefined || input.posterUrl === '' ? '' : `<div class="video-poster-preview"><a href="${escapeHtml(input.posterUrl)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(input.posterUrl)}" alt="Current poster for ${escapeHtml(input.video?.title || 'video')}"></a></div>`
  const posterRemove = !edit || input.posterUrl === undefined || input.posterUrl === '' ? '' : `<form class="video-poster-remove" action="${escapeHtml(input.adminBase)}/videos/poster/remove/" method="post"><input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}"><input type="hidden" name="id" value="${escapeHtml(input.video?.id ?? '')}"><button class="session-revoke" type="submit">Remove current poster</button></form>`
  const generatedLinks = !edit ? '' : `<section class="settings-section video-generated-links" aria-labelledby="video-links-title"><div class="settings-section-heading"><p class="panel-kicker">Stable output</p><h2 id="video-links-title">Generated links</h2><p>The public slug resolves to the saved database record and its ordered media relationships.</p></div><div class="settings-grid"><div class="field"><label for="video-embed-url">Embed link</label><textarea id="video-embed-url" rows="3" readonly>${escapeHtml(input.embedUrl ?? '')}</textarea></div><div class="field"><label for="video-download-url">Download link</label><textarea id="video-download-url" rows="3" readonly>${escapeHtml(input.downloadUrl ?? '')}</textarea></div><div class="field settings-wide"><label for="video-embed-code">Embed code</label><textarea id="video-embed-code" rows="4" readonly>${escapeHtml(input.embedCode ?? '')}</textarea></div></div></section>`

  return adminDocument(edit ? 'Edit Video' : 'New Video', `${adminHeader(input.adminBase, 'videos', input.isAdmin)}
<main class="admin-dashboard admin-video-form-page">
  <p class="eyebrow"><span></span>${edit ? 'Update saved playback' : 'Create saved playback'}</p>
  <div class="admin-dashboard-heading"><div><h1>${edit ? 'Edit video.' : 'New video.'}</h1><p>Main and alternative providers are normalized through the same host classifier used by the Node extraction runtime.</p></div><a class="admin-back-link" href="${escapeHtml(input.adminBase)}/videos/list/">Back to videos</a></div>
  ${renderMessage(input.message)}
  <form class="settings-form video-editor-form" action="${escapeHtml(action)}" method="post" enctype="multipart/form-data" data-video-editor data-max-alternatives="20">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">${edit ? `<input type="hidden" name="id" value="${escapeHtml(input.video?.id ?? '')}">` : ''}
    <section class="settings-section" aria-labelledby="video-source-title"><div class="settings-section-heading"><p class="panel-kicker">Playback identity</p><h2 id="video-source-title">Video source</h2><p>The main URL is required. Alternatives retain their submitted order and become fallback/download choices.</p></div><div class="settings-grid"><div class="field"><label for="video-title">Video title</label><input id="video-title" name="title" type="text" maxlength="255" value="${escapeHtml(title)}" placeholder="Movie title"></div><div class="field"><label for="video-main-url">Main video URL</label><input id="video-main-url" name="host_id" type="url" maxlength="2048" value="${escapeHtml(mainUrl)}" required placeholder="https://video-host.example/watch/..."></div><div class="field"><label for="video-slug">Custom slug</label><input id="video-slug" name="slug" type="text" maxlength="50" value="${escapeHtml(slug)}" placeholder="movie-title"><p class="field-hint">Leave blank to generate a unique slug.</p></div></div></section>
    <section class="settings-section" aria-labelledby="video-alternatives-title"><div class="settings-section-heading"><p class="panel-kicker">Fallbacks</p><h2 id="video-alternatives-title">Alternative video URLs</h2><p>Invalid and duplicate URLs are ignored; up to 20 ordered alternatives are retained and tried if the main source has no playable media.</p></div><div><div class="video-repeat-list" data-video-alternative-list>${alternativeRows}</div><button class="admin-back-link video-add-row" type="button" data-add-video-alternative>Add another URL</button><div class="field video-bulk-alternatives"><label for="video-bulk-alternatives">Or paste URLs, one per line</label><textarea id="video-bulk-alternatives" name="multiAltUrls" rows="5" placeholder="https://video-host.example/watch/fallback-1&#10;https://video-host.example/watch/fallback-2">${escapeHtml(bulkAlternatives)}</textarea></div><template data-video-alternative-template>${videoAlternativeRow('', 'new')}</template></div></section>
    <section class="settings-section" aria-labelledby="video-subtitles-title"><div class="settings-section-heading"><p class="panel-kicker">Captions</p><h2 id="video-subtitles-title">Attached subtitles</h2><p>Keep, edit, or add URL captions; bulk lines support Language|URL and URL|Language. Uploaded files also enter your Subtitle Manager library.</p></div><div class="video-repeat-list">${existingSubtitles}${newSubtitles}</div><div class="settings-grid video-bulk-subtitles"><div class="field"><label for="video-bulk-subtitles">Bulk subtitle URLs</label><textarea id="video-bulk-subtitles" name="multiSubUrls" rows="6" placeholder="English|https://captions.example/movie.srt&#10;https://captions.example/movie.fr.vtt">${escapeHtml(bulkSubtitles)}</textarea></div><div class="field"><label for="video-subtitle-files">Upload subtitle files</label><input id="video-subtitle-files" name="multiSubFiles" type="file" accept=".srt,.vtt,.ass,.sub,.stl,.dfxp,.ttml,.sbv,.txt" multiple><p class="field-hint">Each file is limited to 2 MiB. Language is inferred from a two-letter filename segment when possible.</p></div></div></section>
    <section class="settings-section" aria-labelledby="video-poster-title"><div class="settings-section-heading"><p class="panel-kicker">Artwork</p><h2 id="video-poster-title">Poster</h2><p>Use a credential-free HTTP(S) URL or upload a validated JPG, PNG, WebP, or GIF up to 5 MiB.</p></div><div class="settings-grid"><div class="field"><label for="video-poster-url">Poster URL</label><input id="video-poster-url" name="poster-url" type="url" maxlength="2048" value="${escapeHtml(posterUrl)}" placeholder="https://images.example/poster.jpg"></div><div class="field"><label for="video-poster-file">Poster file</label><input id="video-poster-file" name="poster-file" type="file" accept=".jpg,.jpeg,.png,.webp,.gif"></div></div>${posterPreview}</section>
    <button class="generate-button settings-save" type="submit"><span>${edit ? 'Update video' : 'Save video'}</span><span aria-hidden="true">↗</span></button>
  </form>
  ${posterRemove}
  ${generatedLinks}
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

export function renderAdminSiteSettings(input: Readonly<{
  adminBase: string
  values: SiteSettings
  logoAvailable: boolean
  csrfToken: string
  message?: AdminMessage
}>): string {
  const displayOptions = [
    ['standalone', 'Standalone'],
    ['fullscreen', 'Fullscreen'],
    ['minimal-ui', 'Minimal UI']
  ].map(([value, label]) => stringOption(value ?? '', label ?? '', input.values.pwa_display)).join('')

  return adminDocument('Site settings', `${adminHeader(input.adminBase, 'settings')}
<main class="admin-dashboard admin-settings-page">
  <p class="eyebrow"><span></span>Identity and install</p>
  <div class="admin-dashboard-heading"><div><h1>Site settings.</h1><p>Manage public identity, brand colors, install metadata, and the generated icon family.</p></div><span class="admin-role">9 keys + logo</span></div>
  ${renderMessage(input.message)}
  ${settingsSubnav(input.adminBase, 'site')}
  <form class="admin-settings-form" action="${escapeHtml(input.adminBase)}/settings/site/" method="post" enctype="multipart/form-data">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    <section class="settings-section" aria-labelledby="site-identity-title">
      <div class="settings-section-heading"><p class="panel-kicker">01 / Identity</p><h2 id="site-identity-title">Name and brand</h2><p>Define the public name, supporting copy, color pair, and square PNG used to generate application icons.</p>${input.logoAvailable ? '<img class="settings-logo-preview" src="/assets/img/logo.png" width="76" height="76" alt="Current uploaded site logo">' : ''}</div>
      <div class="settings-grid">
        ${settingsInput('site_name', 'Site name', escapeHtml(input.values.site_name), 'text', 'GPlayer', true)}
        ${settingsInput('site_slogan', 'Slogan', escapeHtml(input.values.site_slogan), 'text', 'Universal media gateway', true)}
        <div class="field settings-wide"><label for="site_description">Site description</label><textarea id="site_description" name="site_description" maxlength="5000" required>${escapeHtml(input.values.site_description)}</textarea></div>
        <div class="field settings-wide"><label for="favicon">Logo PNG</label><input id="favicon" name="favicon" type="file" accept="image/png,.png"><p class="field-hint">Optional. Maximum 5 MB and 16.7 megapixels. The image is normalized to 512×512 and used to generate the legacy icon family and favicon.</p></div>
        ${settingsColorInput('custom_color', 'Primary color', input.values.custom_color)}
        ${settingsColorInput('custom_color2', 'Secondary color', input.values.custom_color2)}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="site-pwa-title">
      <div class="settings-section-heading"><p class="panel-kicker">02 / PWA</p><h2 id="site-pwa-title">Installed experience</h2><p>Configure the generated web-app manifest used by browsers when GPlayer is installed.</p></div>
      <div class="settings-grid">
        ${settingsInput('pwa_shortname', 'Short name', escapeHtml(input.values.pwa_shortname), 'text', 'GPlayer', true)}
        <div class="field"><label for="pwa_display">Display UI</label><select id="pwa_display" name="pwa_display" required>${displayOptions}</select></div>
        ${settingsColorInput('pwa_themecolor', 'Theme color', input.values.pwa_themecolor)}
        ${settingsColorInput('pwa_backgroundcolor', 'Background color', input.values.pwa_backgroundcolor)}
      </div>
    </section>
    <div class="settings-actions"><button class="generate-button" type="submit"><span>Update site settings</span><span aria-hidden="true">↗</span></button><p>Saving regenerates the web-app manifest. Uploading a logo also rebuilds favicon and Apple/PWA icon sizes.</p></div>
  </form>
</main>`)
}

export function renderAdminShortlinkSettings(input: Readonly<{
  adminBase: string
  values: ShortlinkSettings
  csrfToken: string
  message?: AdminMessage
}>): string {
  const checked = (value: boolean): string => value ? ' checked' : ''
  const providerOptions = shortenerProviderList()
    .map((provider) => stringOption(provider.id, provider.name, input.values.additional_url_shortener))
    .join('')
  const secretFields = input.values.providers.map((provider) => {
    const key = `additional_url_shortener_${provider.id}`
    const status = provider.configured ? 'Configured' : 'No key stored'
    return `<div class="settings-secret-card">
      <div class="settings-secret-heading"><label for="${key}">${escapeHtml(provider.name)}</label><span class="settings-secret-status${provider.configured ? ' is-configured' : ''}">${status}</span></div>
      <input id="${key}" name="${key}" type="password" value="" maxlength="4096" placeholder="${provider.configured ? 'Stored API key' : 'Provider API key'}" autocomplete="new-password">
      <p class="field-hint">${provider.configured ? 'Leave blank to preserve the stored key.' : 'Enter a key to configure this provider.'}</p>
      ${provider.configured ? `<label class="settings-clear-secret"><input name="clear_${key}" type="checkbox" value="true"><span>Remove stored key</span></label>` : ''}
    </div>`
  }).join('')

  return adminDocument('Shortlink settings', `${adminHeader(input.adminBase, 'settings')}
<main class="admin-dashboard admin-settings-page">
  <p class="eyebrow"><span></span>Outbound links</p>
  <div class="admin-dashboard-heading"><div><h1>Shortlink settings.</h1><p>Control optional URL shortening and keep every provider credential server-side.</p></div><span class="admin-role">13 keys</span></div>
  ${renderMessage(input.message)}
  ${settingsSubnav(input.adminBase, 'shortlink')}
  <form class="admin-settings-form" action="${escapeHtml(input.adminBase)}/settings/shortlink/" method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    <section class="settings-section" aria-labelledby="shortlink-policy-title">
      <div class="settings-section-heading"><p class="panel-kicker">01 / Behavior</p><h2 id="shortlink-policy-title">Selection policy</h2><p>Disable shortened links entirely or choose the provider used for generated download destinations.</p></div>
      <div class="settings-grid settings-toggle-grid">
        ${settingsToggle('disable_shortener_link', 'Disable shortener links', 'Return direct destinations instead of sending them through a configured shortener.', checked(input.values.disable_shortener_link))}
        <div class="field"><label for="additional_url_shortener">Selected provider</label><select id="additional_url_shortener" name="additional_url_shortener" required>${providerOptions}</select><p class="field-hint">Random retains the legacy provider-selection mode; only providers with a stored key can be used.</p></div>
      </div>
    </section>
    <section class="settings-section" aria-labelledby="shortlink-credentials-title">
      <div class="settings-section-heading"><p class="panel-kicker">02 / Credentials</p><h2 id="shortlink-credentials-title">Provider API keys</h2><p>Credentials are write-only. The page reports whether a key exists but never returns its value to the browser.</p></div>
      <div class="settings-secret-grid">${secretFields}</div>
    </section>
    <div class="settings-actions"><button class="generate-button" type="submit"><span>Update shortlink settings</span><span aria-hidden="true">↗</span></button><p>Configured providers are applied server-side to media and subtitle buttons on the download page; failures preserve the original destination.</p></div>
  </form>
</main>`)
}

export function renderAdminCustomHeaderSettings(input: Readonly<{
  adminBase: string
  rules: readonly CustomHeaderRule[]
  csrfToken: string
  message?: AdminMessage
}>): string {
  const rules = input.rules.length === 0 ? [{ keywords: [], headers: {} }] : input.rules
  const rows = rules.map((rule, index) => customHeaderRow(rule, index)).join('')

  return adminDocument('Custom headers', `${adminHeader(input.adminBase, 'settings')}
<main class="admin-dashboard admin-settings-page">
  <p class="eyebrow"><span></span>Upstream requests</p>
  <div class="admin-dashboard-heading"><div><h1>Custom headers.</h1><p>Attach server-controlled request headers to streaming URLs using ordered keyword rules.</p></div><span class="admin-role">1 JSON key</span></div>
  ${renderMessage(input.message)}
  ${settingsSubnav(input.adminBase, 'custom-headers')}
  <form class="admin-settings-form custom-header-editor" action="${escapeHtml(input.adminBase)}/settings/custom-headers/" method="post" data-max-rules="50">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    <section class="settings-section" aria-labelledby="custom-headers-title">
      <div class="settings-section-heading"><p class="panel-kicker">01 / Matching</p><h2 id="custom-headers-title">URL rules</h2><p>Rules run from top to bottom. The first case-insensitive keyword match supplies its headers to that validated upstream target.</p></div>
      <div>
        <div class="settings-custom-header-list" data-custom-header-list>${rows}</div>
        <button class="settings-add-rule" type="button" data-add-custom-header>+ Add header rule</button>
      </div>
    </section>
    <div class="settings-actions"><button class="generate-button" type="submit"><span>Update custom headers</span><span aria-hidden="true">↗</span></button><p>Host, connection, content-length, transfer-encoding, and other hop-by-hop header overrides are rejected.</p></div>
  </form>
  <template data-custom-header-template>${customHeaderRow({ keywords: [], headers: {} }, '__INDEX__')}</template>
</main>`)
}

export function renderAdminPlayerSettings(input: Readonly<{
  adminBase: string
  values: PlayerSettings
  csrfToken: string
  message?: AdminMessage
}>): string {
  const checked = (value: boolean): string => value ? ' checked' : ''
  const playerOptions = PLAYER_CHOICES.map(({ value, label }) => stringOption(value, label, input.values.player)).join('')
  const skinOptions = PLAYER_SKINS.map((value) => stringOption(value, value === '' ? 'Default' : playerSettingLabel(value), input.values.player_skin)).join('')
  const stretchingOptions = PLAYER_STRETCHING.map((value) => stringOption(value, playerSettingLabel(value), input.values.stretching)).join('')
  const preloadOptions = PLAYER_PRELOAD.map((value) => stringOption(value, playerSettingLabel(value), input.values.preload)).join('')
  const resolutionOptions = PLAYER_RESOLUTIONS.map((value) => stringOption(value, /^\d+$/.test(value) ? `${value}p` : value, input.values.default_resolution)).join('')
  const languageOptions = (selected: string): string => PLAYER_LANGUAGE_OPTIONS.map(({ value }) => stringOption(value, value, selected)).join('')
  const fontOptions = PLAYER_FONTS.map((value) => stringOption(value, value, input.values.font_family)).join('')
  const edgeOptions = PLAYER_EDGE_STYLES.map((value) => stringOption(value, playerSettingLabel(value), input.values.edge_style)).join('')
  const positionOptions = PLAYER_LOGO_POSITIONS.map((value) => stringOption(value, playerSettingLabel(value), input.values.logo_position)).join('')
  const loaderOptions = PLAYER_LOADERS.map((value) => stringOption(value, playerSettingLabel(value), input.values.loader)).join('')

  return adminDocument('Player settings', `${adminHeader(input.adminBase, 'settings')}
<main class="admin-dashboard admin-settings-page">
  <p class="eyebrow"><span></span>Playback experience</p>
  <div class="admin-dashboard-heading"><div><h1>Player settings.</h1><p>Control playback defaults, captions, branding, peer delivery, generated links, and legacy client compatibility.</p></div><span class="admin-role">53 keys</span></div>
  ${renderMessage(input.message)}
  ${settingsSubnav(input.adminBase, 'player')}
  <form class="admin-settings-form player-settings-editor" action="${escapeHtml(input.adminBase)}/settings/player/" method="post" data-player-settings>
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    <section class="settings-section" aria-labelledby="player-playback-title">
      <div class="settings-section-heading"><p class="panel-kicker">01 / Playback</p><h2 id="player-playback-title">Player and media defaults</h2><p>Select the legacy-compatible client presentation and the default behavior used when public query overrides are absent.</p></div>
      <div class="settings-grid settings-toggle-grid">
        <div class="field"><label for="player">Player</label><select id="player" name="player" required>${playerOptions}</select></div>
        <div class="field"><label for="player_skin">Skin</label><select id="player_skin" name="player_skin" required>${skinOptions}</select></div>
        ${settingsColorInput('player_color', 'Primary player color', input.values.player_color)}
        ${settingsColorInput('player_color2', 'Secondary player color', input.values.player_color2)}
        <div class="field"><label for="stretching">Stretching</label><select id="stretching" name="stretching" required>${stretchingOptions}</select></div>
        <div class="field"><label for="preload">Preload</label><select id="preload" name="preload" required>${preloadOptions}</select></div>
        <div class="field"><label for="default_resolution">Default resolution</label><select id="default_resolution" name="default_resolution" required>${resolutionOptions}</select></div>
        <div class="field"><label for="default_audio">Default audio language</label><select id="default_audio" name="default_audio" required>${languageOptions(input.values.default_audio)}</select></div>
        ${settingsToggle('autoplay', 'Autoplay', 'Begin playback automatically when the browser permits it.', checked(input.values.autoplay))}
        ${settingsToggle('mute', 'Start muted', 'Mute the player when it first loads.', checked(input.values.mute))}
        ${settingsToggle('repeat', 'Repeat playback', 'Loop the selected media after it ends.', checked(input.values.repeat))}
        ${settingsToggle('display_title', 'Display title', 'Show the resolved video title in the player.', checked(input.values.display_title))}
        ${settingsToggle('playback_rate', 'Playback speed', 'Expose playback-rate controls.', checked(input.values.playback_rate))}
        ${settingsToggle('enable_share_button', 'Share button', 'Expose the configured share action.', checked(input.values.enable_share_button))}
        ${settingsToggle('enable_download_button', 'Download button', 'Expose the configured download action.', checked(input.values.enable_download_button))}
        ${settingsToggle('disable_filmstrip', 'Disable filmstrip', 'Do not return or render filmstrip previews.', checked(input.values.disable_filmstrip))}
        ${settingsToggle('fake_play_button', 'Large play overlay', 'Show the legacy large play affordance over the poster.', checked(input.values.fake_play_button))}
        ${settingsToggle('continue_watching', 'Continue watching', 'Offer to resume locally remembered playback.', checked(input.values.continue_watching))}
        ${settingsToggle('pause_on_left', 'Pause when hidden', 'Pause when the page loses visibility.', checked(input.values.pause_on_left))}
        ${settingsToggle('allow_public_qry', 'Allow public query overrides', 'Accept autoplay, mute, and repeat values from public player URLs.', checked(input.values.allow_public_qry))}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="player-captions-title">
      <div class="settings-section-heading"><p class="panel-kicker">02 / Captions</p><h2 id="player-captions-title">Subtitle defaults</h2><p>Configure the default language and the caption palette returned to compatible player clients.</p></div>
      <div class="settings-grid">
        <div class="field"><label for="default_subtitle">Default subtitle language</label><select id="default_subtitle" name="default_subtitle" required>${languageOptions(input.values.default_subtitle)}</select></div>
        ${settingsColorInput('subtitle_color', 'Subtitle text color', input.values.subtitle_color)}
        <div class="field"><label for="font_family">Font family</label><select id="font_family" name="font_family" required>${fontOptions}</select></div>
        <div class="field"><label for="edge_style">Edge style</label><select id="edge_style" name="edge_style" required>${edgeOptions}</select></div>
        ${settingsInput('background_opacity', 'Background opacity', escapeHtml(input.values.background_opacity), 'number', '75', true, 'Percentage from 0 to 100.', '0', '100')}
        ${settingsColorInput('background_color', 'Background color', input.values.background_color)}
        ${settingsInput('window_opacity', 'Window opacity', escapeHtml(input.values.window_opacity), 'number', '0', true, 'Percentage from 0 to 100.', '0', '100')}
        ${settingsColorInput('window_color', 'Window color', input.values.window_color)}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="player-branding-title">
      <div class="settings-section-heading"><p class="panel-kicker">03 / Branding</p><h2 id="player-branding-title">Poster and logos</h2><p>Use credential-free HTTP(S) assets. Empty URLs disable the corresponding image.</p></div>
      <div class="settings-grid settings-toggle-grid">
        ${settingsInput('poster', 'Default poster URL', escapeHtml(input.values.poster), 'url', 'https://images.example/poster.jpg')}
        ${settingsToggle('force_default_poster', 'Force default poster', 'Prefer this poster over a source-provided poster.', checked(input.values.force_default_poster))}
        ${settingsInput('logo_file', 'Player logo URL', escapeHtml(input.values.logo_file), 'url', 'https://images.example/logo.png')}
        ${settingsInput('logo_open_link', 'Player logo link', escapeHtml(input.values.logo_open_link), 'url', 'https://brand.example/')}
        <div class="field"><label for="logo_position">Logo position</label><select id="logo_position" name="logo_position" required>${positionOptions}</select></div>
        ${settingsInput('logo_margin', 'Logo margin', escapeHtml(input.values.logo_margin), 'number', '0', true, 'Pixels from the selected corner.', '0', '1000')}
        ${settingsToggle('logo_hide', 'Hide player logo', 'Suppress the primary player logo.', checked(input.values.logo_hide))}
        <div></div>
        ${settingsInput('small_logo_file', 'Small logo URL', escapeHtml(input.values.small_logo_file), 'url', 'https://images.example/small-logo.png')}
        ${settingsInput('small_logo_link', 'Small logo link', escapeHtml(input.values.small_logo_link), 'url', 'https://brand.example/')}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="player-peer-title">
      <div class="settings-section-heading"><p class="panel-kicker">04 / P2P</p><h2 id="player-peer-title">Peer-assisted delivery</h2><p>Enable the legacy P2P flag and publish up to 100 deduplicated secure WebTorrent tracker endpoints.</p></div>
      <div class="settings-grid settings-toggle-grid">
        ${settingsToggle('p2p', 'Enable P2P', 'Allow compatible clients to use peer-assisted media delivery.', checked(input.values.p2p))}
        <div class="field settings-wide"><label for="torrent_tracker">WebTorrent trackers</label><textarea id="torrent_tracker" name="torrent_tracker" rows="7" maxlength="100000" spellcheck="false" required>${escapeHtml(input.values.torrent_tracker)}</textarea><p class="field-hint">One ws:// or wss:// endpoint per line.</p></div>
      </div>
    </section>
    <section class="settings-section" aria-labelledby="player-copy-title">
      <div class="settings-section-heading"><p class="panel-kicker">05 / Interface copy</p><h2 id="player-copy-title">Labels and loader</h2><p>Retain the legacy placeholders used by embedded and download clients.</p></div>
      <div class="settings-grid">
        ${settingsInput('text_title', 'Page title template', escapeHtml(input.values.text_title), 'text', 'Watch {title} - {siteName}', true)}
        <div class="field"><label for="loader">Loader</label><select id="loader" name="loader" required>${loaderOptions}</select></div>
        ${settingsInput('text_loading', 'Loading text', escapeHtml(input.values.text_loading), 'text', 'Preparing stream…')}
        ${settingsInput('text_download', 'Download text', escapeHtml(input.values.text_download), 'text', 'Download {title}')}
        ${settingsInput('text_resume', 'Resume prompt', escapeHtml(input.values.text_resume), 'text', 'Resume at hh:mm:ss')}
        ${settingsInput('text_resume_yes', 'Resume confirmation', escapeHtml(input.values.text_resume_yes), 'text', 'Yes')}
        ${settingsInput('text_resume_no', 'Resume rejection', escapeHtml(input.values.text_resume_no), 'text', 'No')}
        ${settingsInput('text_rewind', 'Rewind label', escapeHtml(input.values.text_rewind), 'text', 'Rewind 10 Seconds')}
        ${settingsInput('text_forward', 'Forward label', escapeHtml(input.values.text_forward), 'text', 'Forward 10 Seconds')}
        ${settingsToggle('hide_hostname', 'Hide source hostname', 'Suppress upstream hostnames in compatible player clients.', checked(input.values.hide_hostname))}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="player-routes-title">
      <div class="settings-section-heading"><p class="panel-kicker">06 / Routes</p><h2 id="player-routes-title">Public links and embed code</h2><p>Slugs are normalized without surrounding slashes and cannot collide with application routes. The template is returned as generator text only.</p></div>
      <div class="settings-grid">
        ${settingsInput('slug_embed', 'Embed slug', escapeHtml(input.values.slug_embed), 'text', 'e', true, 'Letters, numbers, underscores, and dashes.', undefined, undefined, 'off')}
        ${settingsInput('slug_download', 'Download slug', escapeHtml(input.values.slug_download), 'text', 'd', true, 'Letters, numbers, underscores, and dashes.', undefined, undefined, 'off')}
        ${settingsInput('slug_request', 'Request slug', escapeHtml(input.values.slug_request), 'text', 'r', true, 'Letters, numbers, underscores, and dashes.', undefined, undefined, 'off')}
        <div class="field settings-wide"><label for="iframe_code">Embed code template</label><textarea id="iframe_code" name="iframe_code" rows="7" maxlength="100000" spellcheck="false" required>${escapeHtml(input.values.iframe_code)}</textarea><p class="field-hint">Must contain both {embed_url} and {title}. Markup is never executed on this page.</p></div>
      </div>
    </section>
    <div class="settings-actions"><button class="generate-button" type="submit"><span>Update player settings</span><span aria-hidden="true">↗</span></button><p>The Node runtime consumes these values through the legacy-compatible player API and native playback surfaces.</p></div>
  </form>
</main>`)
}

export function renderAdminMiscSettings(input: Readonly<{
  adminBase: string
  values: MiscSettings
  supportedHosts: ReadonlySet<string>
  csrfToken: string
  message?: AdminMessage
}>): string {
  const checked = (value: boolean): string => value ? ' checked' : ''
  const bypassed = new Set(input.values.bypass_host)
  const disabled = new Set(input.values.disable_host)
  const disabledResolutions = new Set(input.values.disable_resolution)
  const bannedCountries = new Set(input.values.banned_countries)
  const hosts = miscHostOptions(input.supportedHosts)
  const hostOptions = (selected: ReadonlySet<string>): string => hosts
    .map(({ value, label }) => `<option value="${escapeHtml(value)}"${selected.has(value) ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('')
  const resolutionOptions = MISC_RESOLUTION_OPTIONS
    .map((value) => `<option value="${escapeHtml(value)}"${disabledResolutions.has(value) ? ' selected' : ''}>${escapeHtml(/^\d+$/.test(value) ? `${value}p+` : value)}</option>`)
    .join('')
  const countryOptions = MISC_COUNTRY_OPTIONS
    .map(({ code, name }) => `<option value="${escapeHtml(code)}"${bannedCountries.has(code) ? ' selected' : ''}>${escapeHtml(name)}</option>`)
    .join('')

  return adminDocument('Misc settings', `${adminHeader(input.adminBase, 'settings')}
<main class="admin-dashboard admin-settings-page">
  <p class="eyebrow"><span></span>Delivery policy</p>
  <div class="admin-dashboard-heading"><div><h1>Misc settings.</h1><p>Control host availability, source quality, outbound proxies, embed access, geography, and VPN ranges through the complete legacy contract.</p></div><span class="admin-role">13 keys</span></div>
  ${renderMessage(input.message)}
  ${settingsSubnav(input.adminBase, 'misc')}
  <form class="admin-settings-form misc-settings-editor" action="${escapeHtml(input.adminBase)}/settings/misc/" method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    <section class="settings-section" aria-labelledby="misc-hosts-title">
      <div class="settings-section-heading"><p class="panel-kicker">01 / Sources</p><h2 id="misc-hosts-title">Hosts and resolutions</h2><p>Bypassed hosts retain their legacy routing preference. Disabled hosts are rejected before extraction; quality filters use the supplied resolution buckets.</p></div>
      <div class="settings-grid">
        <div class="field"><label for="bypass_host">Bypassed hosts</label><input type="hidden" name="bypass_host[]" value=""><select class="settings-multi-select" id="bypass_host" name="bypass_host[]" multiple size="10">${hostOptions(bypassed)}</select><p class="field-hint">Selected providers are stored for VPS-bandwidth bypass routing.</p></div>
        <div class="field"><label for="disable_host">Disabled hosts</label><input type="hidden" name="disable_host[]" value=""><select class="settings-multi-select" id="disable_host" name="disable_host[]" multiple size="10">${hostOptions(disabled)}</select><p class="field-hint">Selected providers cannot resolve or play.</p></div>
        <div class="field"><label for="disable_resolution">Disabled video resolutions</label><input type="hidden" name="disable_resolution[]" value=""><select class="settings-multi-select" id="disable_resolution" name="disable_resolution[]" multiple size="8">${resolutionOptions}</select><p class="field-hint">Matching is bucketed (for example, 1080p is in the 1000p+ bucket). As in the supplied runtime, a sole source is retained.</p></div>
      </div>
    </section>
    <section class="settings-section" aria-labelledby="misc-proxy-title">
      <div class="settings-section-heading"><p class="panel-kicker">02 / Proxy</p><h2 id="misc-proxy-title">Outbound proxy pool</h2><p>Proxy endpoints and credentials are write-only. Saving a blank field preserves the current list; use the explicit clear control to remove it.</p></div>
      <div class="settings-grid settings-toggle-grid">
        ${settingsToggle('disable_proxy', 'Disable proxy', 'Do not use a configured outbound proxy for provider requests.', checked(input.values.disable_proxy))}
        ${settingsToggle('free_proxy', 'Disable free proxy', 'Do not add endpoints from the legacy free-proxy source.', checked(input.values.free_proxy))}
        <div class="field settings-wide"><label for="proxy_list">Replacement proxy list</label><textarea id="proxy_list" name="proxy_list" rows="7" maxlength="1000000" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="203.0.113.10:1080,socks5"></textarea><p class="field-hint">${input.values.proxy_list_configured ? `${input.values.proxy_count} stored ${input.values.proxy_count === 1 ? 'endpoint' : 'endpoints'}; values are not returned to this page.` : 'No proxy endpoints are stored.'} Formats: IP:PORT[,TYPE] or IP:PORT,USERNAME:PASSWORD[,TYPE]. Types: socks4, socks4a, socks5, https.</p></div>
        ${settingsToggle('clear_proxy_list', 'Clear stored proxy list', 'Delete every stored endpoint when this form is submitted.', '')}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="misc-embed-title">
      <div class="settings-section-heading"><p class="panel-kicker">03 / Embeds</p><h2 id="misc-embed-title">Referer access rules</h2><p>Allow or deny embed origins and exact referer paths. Empty allowlists permit every origin; direct visits without a referer remain available for legacy compatibility.</p></div>
      <div class="settings-grid">
        ${settingsTextarea('domain_whitelisted', 'Allowed embed domains/IPs', input.values.domain_whitelisted, 'trusted.example', 'One hostname or IP per line. Schemes are normalized away.')}
        ${settingsTextarea('domain_blacklisted', 'Blacklisted domains/IPs', input.values.domain_blacklisted, 'blocked.example', 'One hostname or IP per line.')}
        ${settingsTextarea('link_blacklisted', 'Blacklisted referer URLs', input.values.link_blacklisted, 'blocked.example/watch/video', 'One exact normalized referer URL or path per line.')}
        ${settingsTextarea('word_blacklisted', 'Blacklisted title words', input.values.word_blacklisted, 'prohibited phrase', 'Resolved source titles containing these case-insensitive words are rejected.')}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="misc-network-title">
      <div class="settings-section-heading"><p class="panel-kicker">04 / Network</p><h2 id="misc-network-title">Countries and VPN ranges</h2><p>Country decisions use the bundled MaxMind database. Client IP forwarding is accepted only from proxies explicitly configured with TRUST_PROXY.</p></div>
      <div class="settings-grid settings-toggle-grid">
        <div class="field"><label for="banned_countries">Banned countries</label><input type="hidden" name="banned_countries[]" value=""><select class="settings-multi-select" id="banned_countries" name="banned_countries[]" multiple size="12">${countryOptions}</select><p class="field-hint">Hold Command or Control to select multiple countries.</p></div>
        ${settingsToggle('block_vpn', 'Block proxy/VPN ranges', 'Reject client IPs matching the configured prefix or CIDR list.', checked(input.values.block_vpn))}
        <div class="field settings-wide"><label for="block_vpn_list">IP prefixes or IPv4/IPv6 ranges</label><textarea id="block_vpn_list" name="block_vpn_list" rows="7" maxlength="1000000" spellcheck="false" placeholder="203.0.113.0/24&#10;2001:db8::/32">${escapeHtml(input.values.block_vpn_list)}</textarea><p class="field-hint">One full IP, dotted/IPv6 prefix, or CIDR range per line. When empty, the supplied default data-center prefixes apply.</p></div>
      </div>
    </section>
    <div class="settings-actions"><button class="generate-button" type="submit"><span>Update misc settings</span><span aria-hidden="true">↗</span></button><p>Host blocks, quality filters, embed policies, title rules, country bans, and VPN ranges are enforced by the Node runtime.</p></div>
  </form>
</main>`)
}

export function renderAdminHostingSettings(input: Readonly<{
  adminBase: string
  values: HostingSettings
  csrfToken: string
  message?: AdminMessage
}>): string {
  const cards = input.values.providers.map((provider, index) => {
    const id = provider.host
    const initial = provider.label.trim().slice(0, 1).toUpperCase() || '•'
    const cookieStatus = provider.host === 'direct'
      ? '<span class="settings-secret-status">Direct</span>'
      : `<span class="settings-secret-status${provider.cookieConfigured ? ' is-configured' : ''}">${provider.cookieConfigured ? 'Cookie stored' : 'No cookie'}</span>`
    const credentials = provider.host === 'direct' ? '' : `<div class="field hosting-cookie-field">
      <div class="settings-secret-heading"><label for="cookie-${id}">Replacement cookies</label>${cookieStatus}</div>
      <input id="cookie-${id}" name="cookie_${id}" type="password" value="" maxlength="32768" autocomplete="new-password" autocapitalize="off" spellcheck="false" placeholder="session=value; preference=value">
      <p class="field-hint">${provider.cookieConfigured ? 'Leave blank to preserve the server-side cookie. Its value is never returned to this page.' : 'Optional Cookie header pairs used only for this provider.'}</p>
      ${provider.cookieConfigured ? `<label class="settings-clear-secret"><input name="clear_cookie_${id}" type="checkbox" value="true"><span>Remove stored cookie</span></label>` : ''}
    </div>
    <div class="field"><label for="hostnames-${id}">Custom domains</label><textarea id="hostnames-${id}" name="custom-hostnames[${id}]" rows="6" maxlength="1000000" spellcheck="false" placeholder="media.example.com">${escapeHtml(provider.customHostnames)}</textarea><p class="field-hint">One provider hostname or matching domain fragment per line; schemes and paths are not accepted.</p></div>`
    return `<details class="hosting-provider-card" data-hosting-provider data-hosting-search="${escapeHtml(`${provider.label} ${provider.host}`.toLowerCase())}"${index === 0 ? ' open' : ''}>
      <summary><span class="hosting-provider-mark" aria-hidden="true">${escapeHtml(initial)}</span><span><strong>${escapeHtml(provider.label)}</strong><small>${escapeHtml(provider.host)}</small></span>${cookieStatus}<span class="hosting-provider-chevron" aria-hidden="true"></span></summary>
      <div class="hosting-provider-fields settings-grid">
        ${credentials}
        <div class="field"><label for="download-url-${id}">Download URL</label><input id="download-url-${id}" name="download-urls[${id}]" type="text" value="${escapeHtml(provider.downloadUrl)}" maxlength="4096" required spellcheck="false"><p class="field-hint">Include exactly one %s placeholder for the original provider ID.</p></div>
        <div class="field"><label for="custom-name-${id}">Custom name</label><div class="hosting-name-control"><input id="custom-name-${id}" name="custom_names[${id}]" type="text" value="${escapeHtml(provider.customName)}" maxlength="100" required><button type="button" data-reset-hosting-name data-target="custom-name-${id}" data-value="${escapeHtml(provider.label)}">Original</button></div><p class="field-hint">Shown on source and download surfaces instead of the provider key.</p></div>
      </div>
    </details>`
  }).join('')

  return adminDocument('Hosting settings', `${adminHeader(input.adminBase, 'settings')}
<main class="admin-dashboard admin-settings-page">
  <p class="eyebrow"><span></span>Provider registry</p>
  <div class="admin-dashboard-heading"><div><h1>Hosting settings.</h1><p>Manage the complete dynamic provider contract: private cookies, recognized domains, outbound source-page patterns, and interface names.</p></div><span class="admin-role">${input.values.providers.length} providers</span></div>
  ${renderMessage(input.message)}
  ${settingsSubnav(input.adminBase, 'hosting')}
  <form class="admin-settings-form hosting-settings-editor" action="${escapeHtml(input.adminBase)}/settings/hosting/" method="post" data-hosting-settings>
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    <section class="hosting-settings-toolbar" aria-labelledby="hosting-search-title">
      <div><p class="panel-kicker">Provider index</p><h2 id="hosting-search-title">Find a source</h2><p>${input.values.configuredCookies} private ${input.values.configuredCookies === 1 ? 'cookie is' : 'cookies are'} configured. Secrets remain write-only.</p></div>
      <div class="field"><label for="hosting-provider-search">Search providers</label><input id="hosting-provider-search" type="search" placeholder="YouTube, Drive, direct…" autocomplete="off" data-hosting-search></div>
    </section>
    <div class="hosting-provider-list" data-hosting-list>${cards}</div>
    <p class="hosting-search-empty" data-hosting-empty hidden>No providers match this search.</p>
    <div class="settings-actions"><button class="generate-button" type="submit"><span>Update hosting settings</span><span aria-hidden="true">↗</span></button><p>Configured domains affect generator detection, URL templates and names affect download surfaces, and cookies remain server-side for provider extraction only.</p></div>
  </form>
</main>`)
}

export function renderAdminResetSettings(input: Readonly<{
  adminBase: string
  csrfToken: string
  message?: AdminMessage
}>): string {
  return adminDocument('Reset settings', `${adminHeader(input.adminBase, 'settings')}
<main class="admin-dashboard admin-settings-page admin-reset-settings-page">
  <p class="eyebrow"><span></span>Destructive operation</p>
  <div class="admin-dashboard-heading"><div><h1>Reset settings.</h1><p>Remove every saved application setting and return the Node.js runtime to its bundled defaults.</p></div><span class="admin-role">All keys</span></div>
  ${renderMessage(input.message)}
  ${settingsSubnav(input.adminBase, 'reset')}
  <form class="admin-settings-form reset-settings-form" action="${escapeHtml(input.adminBase)}/settings/reset/" method="post">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    <section class="settings-section reset-settings-warning" aria-labelledby="reset-settings-title">
      <div class="settings-section-heading"><p class="panel-kicker">Permanent reset</p><h2 id="reset-settings-title">Are you serious?</h2><p>This reproduces the supplied reset contract: all non-empty keys in the legacy settings table are deleted and in-process settings caches are invalidated.</p></div>
      <div class="reset-settings-controls">
        <div class="reset-settings-impact" role="note"><strong>What stays intact</strong><p>User accounts, sessions, video rows, generated VAST files, logos, subtitles, and other uploads are not removed by this action.</p></div>
        <div class="field"><label for="reset-confirmation">Type <code>RESET SETTINGS</code> to continue</label><input id="reset-confirmation" name="confirmation" type="text" value="" maxlength="14" pattern="RESET SETTINGS" autocomplete="off" autocapitalize="characters" spellcheck="false" required><p class="field-hint">The confirmation is case-sensitive.</p></div>
        <label class="reset-settings-acknowledgement"><input name="acknowledge" type="checkbox" value="true" required><span>I understand that every saved setting will be removed immediately.</span></label>
        <button class="generate-button reset-settings-submit" type="submit"><span>Reset all settings</span><span aria-hidden="true">↗</span></button>
      </div>
    </section>
  </form>
</main>`)
}

export function renderAdminAdsSettings(input: Readonly<{
  adminBase: string
  values: AdsSettings
  vastAssets: readonly VastAsset[]
  csrfToken: string
  vastCreateCsrfToken: string
  vastDeleteCsrfToken: string
  message?: AdminMessage
}>): string {
  const checked = (value: boolean): string => value ? ' checked' : ''
  const scheduleLength = Math.max(input.values.vast_xml.length, 1)
  const vastRows = Array.from({ length: scheduleLength }, (_value, index) => vastScheduleRow(
    input.values.vast_offset[index] ?? '',
    input.values.vast_xml[index] ?? '',
    index
  )).join('')
  const assetRows = input.vastAssets.length === 0
    ? '<p class="settings-vast-empty">No custom VAST XML files have been generated yet.</p>'
    : input.vastAssets.map((asset) => `<article class="settings-vast-asset">
      <div><strong>${escapeHtml(asset.name)}</strong><a href="${escapeHtml(asset.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(asset.url)}</a></div>
      <form action="${escapeHtml(input.adminBase)}/settings/ads/vast/delete/" method="post">
        <input type="hidden" name="csrf" value="${escapeHtml(input.vastDeleteCsrfToken)}">
        <input type="hidden" name="file_name" value="${escapeHtml(asset.name)}">
        <button type="submit">Delete</button>
      </form>
    </article>`).join('')

  return adminDocument('Ads settings', `${adminHeader(input.adminBase, 'settings')}
<main class="admin-dashboard admin-settings-page">
  <p class="eyebrow"><span></span>Monetization controls</p>
  <div class="admin-dashboard-heading"><div><h1>Ads settings.</h1><p>Configure VAST schedules, popup and direct behavior, banner placements, and generated XML assets using the legacy contract.</p></div><span class="admin-role">19 keys + assets</span></div>
  ${renderMessage(input.message)}
  ${settingsSubnav(input.adminBase, 'ads')}
  <form class="admin-settings-form ads-settings-editor" action="${escapeHtml(input.adminBase)}/settings/ads/" method="post" data-max-vast="20">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    <section class="settings-section" aria-labelledby="ads-vast-title">
      <div class="settings-section-heading"><p class="panel-kicker">01 / VAST</p><h2 id="ads-vast-title">Player advertising</h2><p>Choose the playback client, anti-adblock policy, and global skip delay.</p></div>
      <div class="settings-grid settings-toggle-grid">
        ${settingsToggle('block_adblocker', 'Require AdBlock to be disabled', 'Show the legacy anti-adblock message before playback.', checked(input.values.block_adblocker))}
        ${settingsToggle('disable_vast_ads', 'Disable VAST ads', 'Turn off all configured VAST and Google IMA schedules.', checked(input.values.disable_vast_ads))}
        <div class="field"><label for="vast_client">Publisher client</label><select id="vast_client" name="vast_client" required>${stringOption('vast', 'VAST', input.values.vast_client)}${stringOption('googima', 'Google IMA', input.values.vast_client)}</select></div>
        ${settingsInput('vast_skip', 'Skip ads after', escapeHtml(input.values.vast_skip), 'number', '5', true, 'Seconds before the player may show a skip control.', '0', '86400')}
      </div>
    </section>
    <section class="settings-section" aria-labelledby="ads-schedule-title">
      <div class="settings-section-heading"><p class="panel-kicker">02 / Schedule</p><h2 id="ads-schedule-title">VAST URLs</h2><p>Pair each HTTP(S) tag with an optional position: preroll, postroll, start, end, a percentage, seconds, or HH:MM:SS.</p></div>
      <div><div class="settings-vast-list" data-vast-list>${vastRows}</div><button class="settings-add-rule" type="button" data-add-vast>+ Add VAST URL</button></div>
    </section>
    <section class="settings-section" aria-labelledby="ads-general-title">
      <div class="settings-section-heading"><p class="panel-kicker">03 / General and direct</p><h2 id="ads-general-title">Outbound behavior</h2><p>Manage delayed popup code and direct-link actions around play and download interactions.</p></div>
      <div class="settings-grid settings-toggle-grid">
        ${settingsToggle('disable_popup_ads', 'Disable general ads', 'Do not load the configured popup JavaScript or HTML code.', checked(input.values.disable_popup_ads))}
        ${settingsToggle('disable_direct_ads', 'Disable direct ads', 'Do not open the direct advertising destination.', checked(input.values.disable_direct_ads))}
        ${settingsToggle('visitads_onplay', 'Visit direct ad on play', 'Open the direct destination on the first play interaction.', checked(input.values.visitads_onplay))}
        ${settingsToggle('show_iframeads', 'Fallback to iframe ads', 'Show iframe advertising when popup windows are blocked.', checked(input.values.show_iframeads))}
        ${settingsInput('popup_load_offset', 'Popup delay', escapeHtml(input.values.popup_load_offset), 'number', '0', true, 'Delay in seconds.', '0', '86400')}
        ${settingsInput('popup_ads_link', 'Popup JavaScript URL', escapeHtml(input.values.popup_ads_link), 'url', 'https://ads.example/script.js')}
        ${settingsInput('direct_ads_link', 'Direct ad URL', escapeHtml(input.values.direct_ads_link), 'url', 'https://ads.example/campaign')}
        <div class="field settings-wide"><label for="popup_ads_code">Popup HTML code</label><textarea id="popup_ads_code" name="popup_ads_code" maxlength="100000" rows="8" placeholder="HTML tags are retained for the player runtime.">${escapeHtml(input.values.popup_ads_code)}</textarea></div>
      </div>
    </section>
    <section class="settings-section" aria-labelledby="ads-banners-title">
      <div class="settings-section-heading"><p class="panel-kicker">04 / Banners</p><h2 id="ads-banners-title">Page placements</h2><p>Keep separate HTML placements above and below the download and sharer page content.</p></div>
      <div class="settings-grid">
        ${settingsToggle('disable_banner_ads', 'Disable banner ads', 'Hide every download and sharer banner placement.', checked(input.values.disable_banner_ads))}
        <div></div>
        ${adsTextarea('dl_banner_top', 'Download page · top', input.values.dl_banner_top)}
        ${adsTextarea('dl_banner_bottom', 'Download page · bottom', input.values.dl_banner_bottom)}
        ${adsTextarea('sh_banner_top', 'Sharer page · top', input.values.sh_banner_top)}
        ${adsTextarea('sh_banner_bottom', 'Sharer page · bottom', input.values.sh_banner_bottom)}
      </div>
    </section>
    <div class="settings-actions"><button class="generate-button" type="submit"><span>Update ads settings</span><span aria-hidden="true">↗</span></button><p>Settings are persisted now; rendering and execution in the player/download surfaces remain a separate runtime parity slice.</p></div>
  </form>
  <template data-vast-template>${vastScheduleRow('', '', '__INDEX__')}</template>
  <section class="settings-section settings-vast-assets" id="custom-vast" aria-labelledby="custom-vast-title">
    <div class="settings-section-heading"><p class="panel-kicker">05 / Custom XML</p><h2 id="custom-vast-title">VAST asset builder</h2><p>Generate the same VAST 3.0 inline XML files as the legacy modal, then use their public URLs in the schedule above.</p></div>
    <div class="settings-vast-assets-body">
      <div class="settings-vast-assets-list">${assetRows}</div>
      <form class="settings-grid settings-vast-create" action="${escapeHtml(input.adminBase)}/settings/ads/vast/create/" method="post">
        <input type="hidden" name="csrf" value="${escapeHtml(input.vastCreateCsrfToken)}">
        <div class="field"><label for="vast-asset-title">Ad title</label><input id="vast-asset-title" name="adTitle" type="text" maxlength="500" placeholder="Pre-roll campaign"></div>
        <div class="field"><label for="vast-asset-filename">XML filename</label><input id="vast-asset-filename" name="adFilename" type="text" maxlength="132" placeholder="campaign.xml" required><p class="field-hint">Letters, numbers, dots, dashes, and underscores. The final extension is normalized to .xml.</p></div>
        <div class="field settings-wide"><label for="vast-asset-click">Click-through URL</label><input id="vast-asset-click" name="adClickThrough" type="url" maxlength="4096" placeholder="https://advertiser.example/campaign" required></div>
        <div class="field settings-wide"><label for="vast-asset-media">MP4 media URL</label><input id="vast-asset-media" name="adMediaFile" type="url" maxlength="4096" placeholder="https://cdn.example/campaign.mp4" required></div>
        <div class="field"><label for="vast-asset-duration">Duration</label><input id="vast-asset-duration" name="adDuration" type="number" min="0" max="359999" step="1" placeholder="30" required><p class="field-hint">Whole seconds.</p></div>
        <div class="field"><label for="vast-asset-skip">Skip offset</label><input id="vast-asset-skip" name="adSkipOffset" type="number" min="0" max="359999" step="1" placeholder="5"><p class="field-hint">Optional whole seconds.</p></div>
        <div class="settings-vast-create-action settings-wide"><button class="generate-button" type="submit"><span>Generate VAST XML</span><span aria-hidden="true">↗</span></button><p>Existing files with the same safe filename are replaced, matching the supplied application.</p></div>
      </form>
    </div>
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
  <script src="/assets/js/gplayer-admin-settings.js" defer></script>
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

function adminHeader(adminBase: string, current: 'dashboard' | 'users' | 'sessions' | 'settings' | 'videos' | 'subtitles', isAdmin = true): string {
  return `<header class="admin-bar">
  <a class="wordmark" href="${escapeHtml(adminBase)}/dashboard/" aria-label="GPlayer dashboard">
    <span class="wordmark-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
    <span>G<span>PLAYER</span><small>NODE</small></span>
  </a>
  <nav class="admin-nav" aria-label="Administration"><a${current === 'dashboard' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/dashboard/">Dashboard</a><a${current === 'videos' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/videos/list/">Videos</a><a${current === 'subtitles' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/videos/subtitles/">Subtitles</a>${isAdmin ? `<a${current === 'users' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/users/">Users</a><a${current === 'sessions' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/users/sessions/">Sessions</a><a${current === 'settings' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/general/">Settings</a>` : ''}</nav>
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

function settingsColorInput(name: string, label: string, value: string): string {
  return `<div class="field settings-color-field"><label for="${name}">${escapeHtml(label)}</label><input id="${name}" name="${name}" type="color" value="#${escapeHtml(value)}" required><code>#${escapeHtml(value)}</code></div>`
}

function settingsSubnav(adminBase: string, current: 'general' | 'public' | 'smtp' | 'site' | 'shortlink' | 'custom-headers' | 'player' | 'hosting' | 'misc' | 'ads' | 'reset'): string {
  return `<nav class="settings-subnav" aria-label="Settings categories"><a${current === 'general' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/general/">General</a><a${current === 'public' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/public/">Public</a><a${current === 'site' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/site/">Site</a><a${current === 'smtp' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/smtp/">SMTP</a><a${current === 'shortlink' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/shortlink/">Links</a><a${current === 'custom-headers' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/custom-headers/">HTTP</a><a${current === 'player' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/player/">Player</a><a${current === 'hosting' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/hosting/">Hosting</a><a${current === 'misc' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/misc/">Misc</a><a${current === 'ads' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/ads/">Ads</a><a${current === 'reset' ? ' aria-current="page"' : ''} href="${escapeHtml(adminBase)}/settings/reset/">Reset</a></nav>`
}

function playerSettingLabel(value: string): string {
  return value.replaceAll('-', ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase())
}

function customHeaderRow(rule: Pick<CustomHeaderRule, 'keywords' | 'headers'>, index: number | string): string {
  const suffix = String(index)
  const keywords = escapeHtml(rule.keywords.join('\n'))
  const headers = escapeHtml(Object.entries(rule.headers).map(([name, value]) => `${name}: ${value}`).join('\n'))
  return `<article class="settings-custom-header-card" data-custom-header-row>
    <div class="settings-custom-header-title"><strong data-custom-header-title>Header rule ${typeof index === 'number' ? index + 1 : ''}</strong><button type="button" data-remove-custom-header>Remove</button></div>
    <div class="settings-grid">
      <div class="field"><label for="custom-header-keywords-${suffix}" data-custom-header-keywords-label>Keywords</label><textarea id="custom-header-keywords-${suffix}" name="items[${suffix}][keywords]" rows="5" placeholder="cdn.example.com" data-custom-header-keywords>${keywords}</textarea><p class="field-hint">One URL substring per line.</p></div>
      <div class="field"><label for="custom-header-values-${suffix}" data-custom-header-values-label>Headers</label><textarea id="custom-header-values-${suffix}" name="items[${suffix}][headers]" rows="5" placeholder="Referer: https://example.com/" data-custom-header-values>${headers}</textarea><p class="field-hint">One Header-Name: value pair per line.</p></div>
    </div>
  </article>`
}

function vastScheduleRow(offset: string, url: string, index: number | string): string {
  const suffix = String(index)
  return `<div class="settings-vast-row" data-vast-row>
    <div class="field"><label for="vast-offset-${suffix}" data-vast-offset-label>Position</label><input id="vast-offset-${suffix}" name="vast_offset[]" type="text" maxlength="32" value="${escapeHtml(offset)}" placeholder="preroll" data-vast-offset></div>
    <div class="field"><label for="vast-url-${suffix}" data-vast-url-label>VAST URL</label><input id="vast-url-${suffix}" name="vast_xml[]" type="url" maxlength="100000" value="${escapeHtml(url)}" placeholder="https://ads.example/vast.xml" data-vast-url></div>
    <button type="button" aria-label="Remove VAST URL" data-remove-vast>Remove</button>
  </div>`
}

function adsTextarea(name: string, label: string, value: string): string {
  return `<div class="field"><label for="${name}">${escapeHtml(label)}</label><textarea id="${name}" name="${name}" maxlength="100000" rows="5" placeholder="HTML tags are retained for the page runtime.">${escapeHtml(value)}</textarea></div>`
}

function settingsTextarea(name: string, label: string, value: string, placeholder: string, hint: string): string {
  return `<div class="field"><label for="${name}">${escapeHtml(label)}</label><textarea id="${name}" name="${name}" maxlength="1000000" rows="7" spellcheck="false" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea><p class="field-hint">${escapeHtml(hint)}</p></div>`
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

function selectStringOption(value: string, label: string, selected: string): string {
  return `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(label)}</option>`
}

function videoStatusLabel(status: number): string {
  return ['Good', 'Broken', 'Warning'][status] ?? 'Unknown'
}

function videoAlternativeRow(url: string, index: number | string): string {
  const suffix = String(index)
  const position = typeof index === 'number' ? ` ${index + 1}` : ''
  return `<div class="video-repeat-row" data-video-alt-row><div class="field"><label for="alt-link-${suffix}" data-video-alt-label>Alternative URL${position}</label><input id="alt-link-${suffix}" name="altLinks[]" type="url" maxlength="2048" value="${escapeHtml(url)}" placeholder="https://video-host.example/watch/..." data-video-alt-input></div><button type="button" data-remove-video-alternative aria-label="Remove alternative URL${position}">Remove</button></div>`
}

function videoSubtitleRow(url: string, language: string, index: number, fresh = false): string {
  const prefix = fresh ? 'New subtitle' : 'Subtitle'
  return `<div class="video-repeat-row video-subtitle-row"><div class="field"><label for="video-sub-url-${index}">${prefix} URL</label><input id="video-sub-url-${index}" name="sub-url[]" type="url" maxlength="2048" value="${escapeHtml(url)}" placeholder="https://captions.example/movie.en.vtt"></div><div class="field"><label for="video-sub-lang-${index}">Language</label><input id="video-sub-lang-${index}" name="lang-url[]" type="text" maxlength="50" value="${escapeHtml(language)}" placeholder="English"></div></div>`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
