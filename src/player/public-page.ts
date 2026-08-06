import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../settings/settings-admin-service.js'
import { withShadcnUi } from '../ui/shadcn-html.js'

export type PublicPageOptions = Readonly<{
  title: string
  heading?: string
  description: string
  eyebrow: string
  body: string
  robots?: 'index, follow' | 'noindex, nofollow'
}>

export type PublicNavigationOptions = Readonly<{
  contactUrl?: string
  site?: SiteSettings
  sharerEnabled?: boolean
  account?: Readonly<{
    adminBase: string
    authenticated: boolean
    registrationEnabled: boolean
  }>
}>

export type PublicError = Readonly<{
  status: 400 | 401 | 403 | 404 | 500 | 503
  title: string
  description: string
}>

export const publicErrors: Readonly<Record<PublicError['status'], PublicError>> = Object.freeze({
  400: Object.freeze({ status: 400, title: '400 Bad Request', description: 'The page is disabled.' }),
  401: Object.freeze({ status: 401, title: '401 Unauthorized', description: 'You are not allowed to access the page.' }),
  403: Object.freeze({ status: 403, title: '403 Forbidden', description: 'You are not allowed to access the page.' }),
  404: Object.freeze({ status: 404, title: '404 Page Not Found', description: 'The page you are looking for was not found.' }),
  500: Object.freeze({ status: 500, title: '500 Internal Server Error', description: 'Sorry, the server is currently unavailable. Please contact admin.' }),
  503: Object.freeze({ status: 503, title: '503 Service Unavailable', description: 'Sorry, the server is currently unavailable. Please try again later.' })
})

export function renderPublicPage(options: PublicPageOptions, navigation: PublicNavigationOptions = {}): string {
  const site = publicSiteSettings(navigation.site)
  const title = escapeHtml(options.title)
  const heading = escapeHtml(options.heading ?? options.title)
  const description = escapeHtml(options.description)
  const eyebrow = escapeHtml(options.eyebrow)
  const robots = options.robots ?? 'index, follow'

  return withShadcnUi(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${description}">
  <meta name="robots" content="${robots}">
  <meta name="theme-color" content="#${safeHex(site.pwa_themecolor, DEFAULT_SITE_SETTINGS.pwa_themecolor)}">
  <title>${title} | ${escapeHtml(site.site_name)}</title>
  <link rel="icon" href="/assets/img/logo/rr.ico">
  <link rel="manifest" href="/manifest.json">
  <script src="/assets/js/gplayer-theme.js"></script>
  <link rel="stylesheet" href="/assets/css/gplayer-landing.css">
  <link rel="stylesheet" href="/runtime-site.css">
  <link rel="stylesheet" href="/assets/css/gplayer-public.css">
  <script src="/assets/js/gplayer-landing.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  ${renderHeader(site, navigation)}
  <main id="main-content" class="public-main">
    <header class="public-hero">
      <p class="eyebrow"><span></span>${eyebrow}</p>
      <h1>${heading}</h1>
      <p>${description}</p>
    </header>
    <article class="public-article">${options.body}</article>
  </main>
  ${renderFooter(navigation, site)}
  ${renderPublicUtilities()}
</body>
</html>`)
}

export function renderPublicError(error: PublicError, navigation: PublicNavigationOptions = {}): string {
  const homeLabel = error.status >= 500 ? 'Try the homepage' : 'Return home'
  return renderPublicPage({
    title: error.title,
    description: error.description,
    eyebrow: `HTTP ${error.status}`,
    robots: 'noindex, nofollow',
    body: `<div class="error-action"><a class="public-button" href="/">${homeLabel}<span aria-hidden="true">↗</span></a></div>`
  }, navigation)
}

export function renderTermsPage(navigation: PublicNavigationOptions = {}): string {
  return renderPublicPage({
    title: 'Terms & Conditions',
    heading: 'Terms and Conditions',
    description: 'Terms and conditions that must be met between the website owner and the users of the services provided on this website.',
    eyebrow: 'Legal / Terms',
    body: `<p><strong>Effective date: 07 Aug 2025</strong></p>
<p>These Terms and Conditions govern your use of our file and video hosting platform (the "Service"). By accessing or using our Service, you agree to be bound by these Terms.</p>
<ol class="legal-list">
  <li><h2>Eligibility</h2><p>You must be at least 18 years old or the age of majority in your jurisdiction to use this Service.</p></li>
  <li><h2>Account registration</h2><p>You are responsible for maintaining the confidentiality of your account credentials. You agree to provide accurate and complete information and to update it as necessary.</p></li>
  <li><h2>User content</h2><p>You retain ownership of files or videos you upload. You grant us a worldwide, non-exclusive, royalty-free license to host, store, and deliver that content as necessary to operate the Service. You must have all necessary rights and permissions to upload and share it.</p></li>
  <li><h2>Prohibited content and conduct</h2><p>You may not use the Service to store or distribute:</p><ul><li>Copyright-infringing materials</li><li>Child exploitation content</li><li>Malware, viruses, or other harmful software</li><li>Hate speech or content inciting violence</li></ul></li>
  <li><h2>DMCA and copyright complaints</h2><p>We comply with the Digital Millennium Copyright Act. If you believe your copyright has been infringed, follow our <a href="/dmca/">DMCA policy</a>.</p></li>
  <li><h2>Termination</h2><p>We reserve the right to suspend or terminate your access without notice if you violate these Terms.</p></li>
  <li><h2>Limitation of liability</h2><p>We provide the Service "as is" without warranties. We are not liable for loss of data, profits, or damages resulting from use of the Service.</p></li>
  <li><h2>Privacy</h2><p>Our <a href="/privacy/">Privacy Policy</a> governs how we handle information. We do not sell user data.</p></li>
  <li><h2>Governing law</h2><p>These Terms are governed by the laws of the USA.</p></li>
  <li><h2>Changes to terms</h2><p>We may update these Terms at any time. Continued use of the Service after changes constitutes acceptance.</p></li>
</ol>`
  }, navigation)
}

export function renderPrivacyPage(navigation: PublicNavigationOptions = {}): string {
  return renderPublicPage({
    title: 'Privacy Policy',
    description: 'By using this site, you agree to follow all the privacy policies set out on this page.',
    eyebrow: 'Legal / Privacy',
    body: `<p><strong>Last updated: 07 Aug 2025</strong></p>
<section><h2>1. Definitions</h2><p><strong>Personal Information</strong> is information that identifies you as an individual. <strong>Non-Personal Information</strong> includes anonymous or aggregated data not linked to you personally.</p></section>
<section><h2>2. Information we collect</h2><p>We do not collect personal information through the public player generator. We may process non-personal technical data such as browser type, device model, anonymized network data, and usage patterns to operate and secure the Service.</p></section>
<section><h2>3. Cookies and preferences</h2><p>The Service may use cookies or local browser storage to remember display and player preferences. Third-party media or advertising integrations may set their own cookies.</p></section>
<section><h2>4. Third-party services</h2><p>Media hosts, analytics providers, or advertising networks may process data under their own privacy policies. This policy does not cover their independent practices.</p></section>
<section><h2>5. Your data rights</h2><p>If the Service begins collecting personal data, applicable law may give you rights to access, correct, or delete it. Contact the site operator to exercise those rights.</p></section>
<section><h2>6. Data security</h2><p>We take reasonable technical measures to protect service data, including HTTPS in production. No method of transmission over the Internet is completely secure.</p></section>
<section><h2>7. International data transfers</h2><p>Non-personal service data may be processed in countries with different data-protection laws.</p></section>
<section><h2>8. Changes to this policy</h2><p>We may update this policy and publish the current version on this page. Continued use after an update constitutes acceptance.</p></section>
<section><h2>9. Contact</h2><p>Contact the site operator if you have questions about this policy.</p></section>`
  }, navigation)
}

export function renderDmcaPage(navigation: PublicNavigationOptions = {}): string {
  const siteName = escapeHtml(publicSiteSettings(navigation.site).site_name)
  return renderPublicPage({
    title: 'DMCA Takedown Policy',
    description: 'DMCA Takedown Policy',
    eyebrow: 'Legal / Copyright',
    body: `<section><h2>Introduction</h2><p>${siteName} respects the intellectual-property rights of others and expects users to do the same. The site operator responds to clear notices of alleged infringement that comply with the Digital Millennium Copyright Act.</p></section>
<section><h2>Reporting copyright infringement</h2><p>A written notice should include:</p><ol><li>A physical or electronic signature of a person authorized to act for the copyright owner.</li><li>Identification of the copyrighted work, or a representative list of works.</li><li>Identification and location of the material claimed to be infringing.</li><li>Your address, telephone number, and email address.</li><li>A statement of good-faith belief that the disputed use is not authorized.</li><li>A statement, under penalty of perjury, that the notice is accurate and that you are authorized to act.</li></ol></section>
<section><h2>Submit your notice</h2><p>Send the notice to the designated DMCA contact published by the operator of this deployment with the subject <strong>DMCA Takedown Request</strong>. A deployment must configure its real legal contact before operating publicly.</p></section>
<section><h2>Counter-notification</h2><p>A counter-notification should identify the removed material and its prior location; include your signature and contact information; state under penalty of perjury that removal resulted from mistake or misidentification; and include the jurisdiction and service-of-process consent required by 17 U.S.C. § 512(g).</p></section>
<section><h2>Repeat infringers</h2><p>The operator may terminate access for repeat infringers in appropriate circumstances.</p></section>
<section><h2>Disclaimer</h2><p>This policy is informational and is not legal advice. Seek advice from a qualified attorney if you are unsure of your rights or obligations.</p></section>`
  }, navigation)
}

export function renderChangelogPage(navigation: PublicNavigationOptions = {}): string {
  return renderPublicPage({
    title: 'Change Log',
    description: 'These change logs indicate that this website is being kept up to date.',
    eyebrow: 'Release history',
    body: `<div class="changelog-intro"><p>Release notes for GPlayer's media delivery, administration, and public player features.</p></div>
<ol class="changelog-list">
  <li><div><time datetime="2026-08-06">06 Aug 2026</time><span class="release-tag">Host catalog</span></div><h2>Expanded public provider coverage</h2><ul><li><strong>Added</strong> verified adapters for every provider in the current public catalog.</li><li><strong>Improved</strong> deterministic provider fixtures and live-support documentation.</li><li><strong>Improved</strong> server-side handling for provider credentials, cookies, headers, and referers.</li></ul></li>
  <li><div><time datetime="2026-08-05">05 Aug 2026</time><span class="release-tag">Core platform</span></div><h2>Streaming and public delivery</h2><ul><li><strong>Added</strong> authenticated HLS, DASH, poster, subtitle, download, and ranged-video routes.</li><li><strong>Added</strong> DNS-pinned upstream connections and strict player-query authentication.</li><li><strong>Added</strong> the public generator, legal pages, status pages, deployment redirects, and installable-web-app metadata.</li></ul></li>
  <li><div><time datetime="2026-08-02">02 Aug 2026</time><span class="release-tag">Administration</span></div><h2>Operations and extension tools</h2><ul><li><strong>Added</strong> administration alerts and system diagnostics.</li><li><strong>Improved</strong> plugin loading, background execution, and asset pipelines.</li><li><strong>Improved</strong> custom-header management and deployment documentation.</li></ul></li>
  <li><div><time datetime="2026-07-29">29 Jul 2026</time><span class="release-tag">Streaming</span></div><h2>Player and delivery updates</h2><ul><li><strong>Improved</strong> live-stream cache bypass, MPD trailing-slash preservation, and static poster and subtitle delivery.</li><li><strong>Fixed</strong> cross-origin preflight behavior across routes and static assets.</li><li><strong>Fixed</strong> HLS player state, database indexes, admin responsiveness, and multiple provider adapters.</li></ul></li>
</ol>`
  }, navigation)
}

export function renderPublicThemeCss(input: SiteSettings = DEFAULT_SITE_SETTINGS): string {
  const site = publicSiteSettings(input)
  const primary = safeHex(site.custom_color, DEFAULT_SITE_SETTINGS.custom_color)
  const secondary = safeHex(site.custom_color2, DEFAULT_SITE_SETTINGS.custom_color2)
  return `:root,\n:root[data-theme] {\n  --brand: #${primary};\n  --brand-soft: #${secondary};\n  --success: #${primary};\n  --focus: #${secondary};\n}\n`
}

export function renderPublicNavigationItems(navigation: PublicNavigationOptions): string {
  const sharer = navigation.sharerEnabled === true ? '<a href="/sharer/">Drive sharer</a>' : ''
  const account = navigation.account
  if (account === undefined) return sharer
  const adminBase = safeAdminBase(account.adminBase)
  if (account.authenticated) {
    return `${sharer}<details class="site-account-nav"><summary>User panel</summary><div class="site-account-menu">
      <a href="${adminBase}/dashboard/">Dashboard</a>
      <a href="${adminBase}/videos/list/">My videos</a>
      <a href="${adminBase}/profile/">My account</a>
      <a href="${adminBase}/login/?logout=true">Sign out</a>
    </div></details>`
  }
  return account.registrationEnabled
    ? `${sharer}<a href="${adminBase}/login/">Sign in</a><a href="${adminBase}/register/">Register</a>`
    : sharer
}

export function renderPublicThemeNavigation(): string {
  return `<details class="site-theme-nav"><summary><span data-theme-label>Theme</span></summary><div class="site-theme-menu">
    <button type="button" data-theme-choice="light">Light</button>
    <button type="button" data-theme-choice="dark">Dark</button>
  </div></details>`
}

function renderHeader(site: SiteSettings, navigation: PublicNavigationOptions): string {
  const siteName = escapeHtml(site.site_name)
  return `<header class="site-header">
  <a class="wordmark" href="/" aria-label="${siteName} home">
    <span class="wordmark-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
    <span>${siteName}</span>
  </a>
  <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-navigation">Menu</button>
  <nav id="site-navigation" class="site-navigation" aria-label="Primary navigation">
    <a href="/">Home</a>
    <a href="/changelog/">Changelog</a>
    <a href="/terms/">Terms</a>
    <a href="/privacy/">Privacy</a>
    ${renderPublicNavigationItems(navigation)}
    ${renderPublicThemeNavigation()}
    <a class="nav-cta" href="/#generator">Build a player</a>
  </nav>
</header>`
}

function renderFooter(navigation: PublicNavigationOptions, site: SiteSettings): string {
  const contactUrl = safePublicContactUrl(navigation.contactUrl)
  const contact = contactUrl === '' ? '' : `<a href="${escapeHtml(contactUrl)}">Contact</a>`
  const siteName = escapeHtml(site.site_name)
  return `<footer class="site-footer public-footer">
  <div>
    <a class="wordmark wordmark-footer" href="/" aria-label="${siteName} home">
      <span class="wordmark-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></span>
      <span>${siteName}</span>
    </a>
    <p>${escapeHtml(site.site_slogan)}</p>
  </div>
  <nav aria-label="Legal navigation">
    <a href="/terms/">Terms</a><a href="/privacy/">Privacy</a><a href="/dmca/">DMCA</a><a href="/changelog/">Changelog</a>${contact}
  </nav>
  <p class="copyright">© <span id="copyright-year">2026</span> ${siteName}</p>
</footer>`
}

function renderPublicUtilities(): string {
  return `<aside class="public-share-rail" aria-label="Share this page">
  <a href="#" data-share-network="facebook" target="_blank" rel="nofollow noopener noreferrer" aria-label="Share on Facebook"><span aria-hidden="true">f</span></a>
  <a href="#" data-share-network="x" target="_blank" rel="nofollow noopener noreferrer" aria-label="Share on X"><span aria-hidden="true">X</span></a>
  <a href="#" data-share-network="whatsapp" target="_blank" rel="nofollow noopener noreferrer" aria-label="Share on WhatsApp"><span aria-hidden="true">WA</span></a>
  <a href="#" data-share-network="telegram" target="_blank" rel="nofollow noopener noreferrer" aria-label="Share on Telegram"><span aria-hidden="true">TG</span></a>
  <button type="button" data-share-more aria-label="Share this page or copy its link"><span aria-hidden="true">↗</span></button>
  <span class="sr-only" data-share-status aria-live="polite"></span>
</aside>
<button type="button" id="gotoTop" class="goto-top" aria-label="Go to top" title="Go to top" hidden><span aria-hidden="true">↑</span></button>`
}

function publicSiteSettings(value: SiteSettings | undefined): SiteSettings {
  return value ?? DEFAULT_SITE_SETTINGS
}

function safeHex(value: string, fallback: string): string {
  const normalized = value.trim().replace(/^#/u, '').toLowerCase()
  return /^[0-9a-f]{6}$/u.test(normalized) ? normalized : fallback
}

function safeAdminBase(value: string): string {
  return /^\/[A-Za-z0-9_-]+$/u.test(value) ? value : '/administrator'
}

function safePublicContactUrl(value: string | undefined): string {
  if (value === undefined || value === '') return ''
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' ? url.href : ''
  } catch {
    return ''
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
