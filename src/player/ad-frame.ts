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
  <style>html,body{min-height:100%;margin:0}body{display:grid;place-items:center;overflow:auto;background:transparent}.ad-slot{max-width:100%;overflow-wrap:anywhere}</style>
</head>
<body tabindex="0">
  <div class="ad-slot">${content.html}</div>
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
