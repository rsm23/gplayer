import { renderPublicPage, type PublicNavigationOptions } from './public-page.js'

export type SharerPageOptions = Readonly<{
  recaptchaSiteKey?: string
  bannerTopFrameUrl?: string
  bannerBottomFrameUrl?: string
  publicPage?: PublicNavigationOptions
}>

export function renderSharerPage(options: SharerPageOptions = {}): string {
  const siteKey = safeSiteKey(options.recaptchaSiteKey ?? '')
  const captcha = siteKey === ''
    ? ''
    : `<div class="sharer-captcha"><div class="g-recaptcha" data-sitekey="${escapeHtml(siteKey)}"></div></div>
      <script src="https://www.google.com/recaptcha/api.js" async defer></script>`
  return renderPublicPage({
    title: 'Google Drive Bypass Engine',
    heading: 'Google Drive Bypass Engine',
    description: 'Generate a clean, shareable Google Drive link by copying an accessible file through a configured Drive account.',
    eyebrow: 'Drive / Sharer',
    body: `${renderAdFrame(options.bannerTopFrameUrl, 'Top sponsor')}
<div class="sharer-grid">
  <section class="sharer-card" aria-labelledby="sharer-configuration-title">
    <p class="sharer-card-kicker">01 / Input</p>
    <h2 id="sharer-configuration-title">Configuration</h2>
    <form id="frmBypassLimit" method="post" action="/ajax/public/">
      <input type="hidden" name="action" value="gdriveBypassLimit">
      <label for="gdrive_id">Google Drive URL or File ID</label>
      <input type="text" name="gdrive_id" id="gdrive_id" class="sharer-input" placeholder="Paste a Drive ID or full drive.google.com link" autocomplete="off" inputmode="url" maxlength="2048" required>
      ${captcha}
      <button id="sharer-submit" type="submit" class="public-button sharer-submit">
        <span>Get bypassed URL</span><span aria-hidden="true">↗</span>
      </button>
      <p id="sharer-status" class="sharer-status" role="status" aria-live="polite"></p>
    </form>
  </section>
  <section class="sharer-card" aria-labelledby="sharer-result-title">
    <p class="sharer-card-kicker">02 / Output</p>
    <h2 id="sharer-result-title">Direct output link</h2>
    <div class="sharer-note"><strong>Heads up.</strong> A copied file can use a different filename. Rename it after download if needed.</div>
    <label for="txtGDriveDL">Generated straight link field</label>
    <input id="txtGDriveDL" data-id="" type="text" class="sharer-input" placeholder="Your bypassed Drive link will appear here" readonly>
  </section>
</div>
${renderAdFrame(options.bannerBottomFrameUrl, 'Bottom sponsor')}
<script src="/assets/js/gplayer-sharer.js" defer></script>`
  }, options.publicPage)
}

function renderAdFrame(url: string | undefined, title: string): string {
  return url === undefined ? '' : `<iframe class="sharer-ad" src="${escapeHtml(url)}" title="${escapeHtml(title)}" loading="lazy" referrerpolicy="no-referrer"></iframe>`
}

function safeSiteKey(value: string): string {
  const normalized = value.trim()
  return normalized.length <= 4_096 && /^[A-Za-z0-9_-]*$/.test(normalized) ? normalized : ''
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
