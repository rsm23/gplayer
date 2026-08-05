export type AdFrameContent = Readonly<{
  html: string
  scriptUrl?: string
}>

export function renderAdFrameDocument(content: AdFrameContent): string {
  const externalScript = content.scriptUrl === undefined || content.scriptUrl.length === 0
    ? ''
    : `<script src="${escapeHtmlAttribute(content.scriptUrl)}" data-cfasync="false" async></script>`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="referrer" content="no-referrer">
  <title>Advertisement</title>
  <style>html,body{min-height:100%;margin:0}body{display:grid;place-items:center;overflow:auto;background:transparent}.ad-slot{max-width:100%;overflow-wrap:anywhere}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style>
</head>
<body tabindex="0">
  <main class="ad-slot" aria-label="Advertisement"><h1 class="sr-only">Advertisement</h1>${content.html}</main>
  ${externalScript}
</body>
</html>`
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
