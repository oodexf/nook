export type ArtifactKind = "html" | "css" | "javascript";

export type ChatArtifact = {
  id: string;
  messageId: string;
  blockIndex: number;
  codeBlockIndex: number | null;
  kind: ArtifactKind;
  language: string;
  code: string;
  complete: boolean;
};

export type ArtifactTheme = {
  colorScheme: "light" | "dark";
  variables: readonly (readonly [string, string])[];
};

const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})([^\n]*)$/;
const HTML_LIKE_RE = /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b|<(?:article|canvas|div|main|section|style|script|svg)\b)/i;
const DOCTYPE_RE = /<!doctype\s+html[^>]*>/i;
const HTML_OPEN_RE = /<html\b[^>]*>/i;
const HTML_CLOSE_RE = /<\/html\s*>/i;
const HEAD_BLOCK_RE = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i;
const BODY_BLOCK_RE = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i;
const SCRIPT_CLOSE_RE = /<\/script/gi;
const STYLE_CLOSE_RE = /<\/style/gi;
const UNSAFE_THEME_VALUE_RE = /[<>{};]/u;

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "connect-src 'none'",
  "manifest-src 'none'",
  "prefetch-src 'none'",
  "navigate-to 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'"
].join("; ");

export const ARTIFACT_IFRAME_PERMISSIONS = [
  "accelerometer 'none'",
  "autoplay 'none'",
  "camera 'none'",
  "clipboard-read 'none'",
  "clipboard-write 'none'",
  "encrypted-media 'none'",
  "fullscreen 'none'",
  "geolocation 'none'",
  "gyroscope 'none'",
  "microphone 'none'",
  "midi 'none'",
  "payment 'none'",
  "serial 'none'",
  "usb 'none'",
  "bluetooth 'none'"
].join("; ");

const ARTIFACT_THEME_VARIABLES = [
  "--bg",
  "--surface",
  "--surface-muted",
  "--text",
  "--text-strong",
  "--muted",
  "--border",
  "--border-strong",
  "--accent",
  "--accent-contrast",
  "--danger",
  "--success",
  "--warning-text",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--shadow"
] as const;

function normalizeLanguage(language: string): string {
  return language.trim().toLowerCase();
}

function parseFenceLanguage(info: string): string {
  const raw = info.trim().split(/\s+/)[0] ?? "";
  return raw.replace(/^\{?\.?/, "").replace(/\}?$/, "");
}

function isFenceClose(line: string, marker: string): boolean {
  const character = marker[0];
  if (character !== "`" && character !== "~") return false;
  const escaped = character === "`" ? "`" : "~";
  return new RegExp(`^[ \\t]*${escaped}{${marker.length},}[ \\t]*$`).test(line);
}

export function resolveArtifactKind(
  language: string,
  code: string
): ArtifactKind | null {
  const normalized = normalizeLanguage(language);
  if (["html", "htm", "xhtml"].includes(normalized)) return "html";
  if (["css", "scss", "sass", "less"].includes(normalized)) return "css";
  if (["js", "javascript", "mjs", "cjs"].includes(normalized)) {
    return "javascript";
  }
  if ((!normalized || normalized === "markdown") && HTML_LIKE_RE.test(code)) {
    return "html";
  }
  return null;
}

export function extractArtifacts(
  source: string,
  messageId: string,
  settled: boolean
): ChatArtifact[] {
  const artifacts: ChatArtifact[] = [];
  const lines = source.split(/\r?\n/);
  let openMarker = "";
  let language = "";
  let codeLines: string[] = [];
  let codeBlockIndex = 0;

  const pushArtifact = (code: string, complete: boolean, sourceBlock: number) => {
    const kind = resolveArtifactKind(language, code);
    if (kind === null || code.trim() === "" || !complete) return;
    const blockIndex = artifacts.length;
    artifacts.push({
      id: `${messageId}:artifact:${blockIndex}`,
      messageId,
      blockIndex,
      codeBlockIndex: sourceBlock,
      kind,
      language: normalizeLanguage(language) || kind,
      code,
      complete
    });
  };

  for (const line of lines) {
    if (openMarker === "") {
      const opening = line.match(FENCE_OPEN_RE);
      if (opening === null) continue;
      openMarker = opening[1] ?? "";
      language = parseFenceLanguage(opening[2] ?? "");
      codeLines = [];
      continue;
    }

    if (isFenceClose(line, openMarker)) {
      pushArtifact(codeLines.join("\n"), true, codeBlockIndex);
      codeBlockIndex += 1;
      openMarker = "";
      language = "";
      codeLines = [];
      continue;
    }
    codeLines.push(line);
  }

  // An unmatched fence remains source-only. `settled` intentionally does not
  // make incomplete model output executable.
  void settled;

  if (artifacts.length === 0 && openMarker === "") {
    const kind = resolveArtifactKind("", source);
    if (kind !== null && source.trim() !== "") {
      artifacts.push({
        id: `${messageId}:artifact:0`,
        messageId,
        blockIndex: 0,
        codeBlockIndex: null,
        kind,
        language: kind,
        code: source,
        complete: true
      });
    }
  }

  return artifacts;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeScriptContent(value: string): string {
  return value.replace(SCRIPT_CLOSE_RE, "<\\/script");
}

function escapeStyleContent(value: string): string {
  return value.replace(STYLE_CLOSE_RE, "<\\/style");
}

export function captureArtifactTheme(
  colorScheme?: "light" | "dark"
): ArtifactTheme {
  const resolved =
    colorScheme ??
    (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const computed = getComputedStyle(document.documentElement);
  const variables: Array<readonly [string, string]> = [];
  for (const name of ARTIFACT_THEME_VARIABLES) {
    const value = computed.getPropertyValue(name).trim();
    if (!value || value.length > 512 || UNSAFE_THEME_VALUE_RE.test(value)) continue;
    variables.push([name, value]);
  }
  return { colorScheme: resolved, variables };
}

function previewHead(title: string, theme: ArtifactTheme): string {
  const declarations = theme.variables
    .map(([name, value]) => `${name}:${escapeStyleContent(value)}`)
    .join(";");
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(ARTIFACT_CSP)}">`,
    `<title>${escapeHtml(title)}</title>`,
    `<style data-nook-artifact-theme>:root{color-scheme:${theme.colorScheme};${declarations}}html,body{color:var(--text,#18181b);background:var(--surface,#fff)}</style>`,
    '<style data-nook-artifact-reset>html,body{min-height:100%;width:100%;margin:0}body{overflow:auto}*,*::before,*::after{box-sizing:border-box}</style>',
    `<script>(()=>{const text=v=>{if(!v)return "Unknown preview error";if(v.stack)return String(v.stack);if(v.message)return String(v.message);return String(v)};const show=v=>{const n=document.createElement("pre");n.textContent=text(v);n.style.cssText="margin:16px;padding:12px;border:1px solid var(--danger,#b42318);border-radius:var(--radius-sm,10px);color:var(--danger,#b42318);background:var(--surface-muted,#f4f4f5);font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap";document.body.appendChild(n)};addEventListener("error",e=>show(e.error||e.message));addEventListener("unhandledrejection",e=>show(e.reason))})();</script>`
  ].join("");
}

function buildHtmlDocument(code: string, theme: ArtifactTheme): string {
  const safeHead = previewHead("Artifact Preview", theme);
  const userHead = HEAD_BLOCK_RE.exec(code)?.[1]?.trim() ?? "";
  const bodyMatch = BODY_BLOCK_RE.exec(code);
  const body = bodyMatch
    ? bodyMatch[1]
    : code
        .replace(DOCTYPE_RE, "")
        .replace(HTML_OPEN_RE, "")
        .replace(HTML_CLOSE_RE, "")
        .replace(HEAD_BLOCK_RE, "")
        .trim();
  return `<!doctype html><html><head>${safeHead}${userHead}</head><body>${body}</body></html>`;
}

function buildCssDocument(code: string, theme: ArtifactTheme): string {
  return `<!doctype html><html><head>${previewHead("CSS Preview", theme)}<style>${escapeStyleContent(code)}</style></head><body><main class="artifact-preview"><section class="preview-panel"><p class="eyebrow">NooK Artifact</p><h1>Preview Surface</h1><p>Generated CSS is applied to this isolated document.</p><div class="preview-row"><button type="button">Primary action</button><button type="button" class="secondary">Secondary</button></div><div class="preview-grid"><article><strong>Card</strong><span>Sample content</span></article><article><strong>Metric</strong><span>128</span></article></div></section></main></body></html>`;
}

function buildJavaScriptDocument(code: string, theme: ArtifactTheme): string {
  return `<!doctype html><html><head>${previewHead("JavaScript Preview", theme)}<style>body{font:14px/1.5 system-ui,sans-serif}#root{min-height:100vh;padding:20px}.artifact-console{position:fixed;inset-inline:12px;bottom:12px;max-height:32vh;overflow:auto;border:1px solid var(--border,#ddd);border-radius:var(--radius-sm,10px);background:var(--surface-muted,#f4f4f5);padding:10px;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap}</style></head><body><div id="root"></div><pre id="artifact-console" class="artifact-console" hidden></pre><script>(()=>{const n=document.getElementById("artifact-console");const write=(level,values)=>{n.hidden=false;n.textContent+="["+level+"] "+values.map(value=>{try{return typeof value==="string"?value:JSON.stringify(value)}catch{return String(value)}}).join(" ")+"\\n"};for(const level of ["log","info","warn","error"]){const original=console[level].bind(console);console[level]=(...values)=>{write(level,values);original(...values)}}})();</script><script>${escapeScriptContent(code)}</script></body></html>`;
}

export function buildArtifactPreviewDocument(
  kind: ArtifactKind,
  code: string,
  theme: ArtifactTheme
): string {
  switch (kind) {
    case "html":
      return buildHtmlDocument(code, theme);
    case "css":
      return buildCssDocument(code, theme);
    case "javascript":
      return buildJavaScriptDocument(code, theme);
  }
}

export function artifactDownloadName(kind: ArtifactKind): string {
  switch (kind) {
    case "html":
      return "artifact-preview.html";
    case "css":
      return "artifact-css-preview.html";
    case "javascript":
      return "artifact-js-preview.html";
  }
}

export function downloadArtifact(fileName: string, documentHtml: string): void {
  const blob = new Blob([documentHtml], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
