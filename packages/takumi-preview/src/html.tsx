/** @jsxImportSource hono/jsx */

import { html } from 'hono/html';

import { fileURLToPath } from 'node:url';

export interface PreviewErrorLocation {
  filePath: string;
  line: number;
  column: number;
}

export interface PreviewErrorInfo {
  message: string;
  stack: string;
  location?: PreviewErrorLocation;
}

export function renderPreviewPage(filePath: string) {
  return html`<!doctype html>${<PreviewPage filePath={filePath} />}`;
}

function PreviewPage(props: { filePath: string }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Takumi Preview</title>
        {/** biome-ignore lint/security/noDangerouslySetInnerHtml: This is a static string, safe to use. */}
        <style dangerouslySetInnerHTML={{ __html: previewCss }} />
      </head>
      <body>
        <header>
          <div class="title">
            <h1>Takumi Preview</h1>
            <div class="path" title={props.filePath}>
              {props.filePath}
            </div>
          </div>
          <div class="meta" id="meta">
            Rendering...
          </div>
          <button type="button" id="refresh" title="Refresh preview" aria-label="Refresh preview">
            ↻
          </button>
        </header>
        <main>
          <div class="preview" id="preview">
            <img id="image" src={`/preview.png?t=${Date.now()}`} alt="Takumi preview" />
            <pre id="error" hidden></pre>
          </div>
        </main>
        {/** biome-ignore lint/security/noDangerouslySetInnerHtml: This is a static string, safe to use. */}
        <script dangerouslySetInnerHTML={{ __html: previewScript }} />
      </body>
    </html>
  );
}

export function renderErrorText(error: unknown) {
  const info = toPreviewErrorInfo(error);
  const location = info.location ? `\n${info.location.filePath}:${info.location.line}:${info.location.column}` : '';
  return `${info.message}${location}\n${info.stack}`;
}

export function toPreviewErrorInfo(error: unknown): PreviewErrorInfo {
  if (error instanceof Error) {
    const stack = error.stack ?? error.message;
    return {
      message: error.message,
      stack,
      location: extractPreviewErrorLocation(stack),
    };
  }

  const message = String(error);
  return {
    message,
    stack: message,
  };
}

function extractPreviewErrorLocation(stack: string) {
  const lines = stack.split('\n');

  for (const line of lines) {
    const match = line.match(/\(?((?:file:\/\/\/)?[A-Za-z]:[\\/][^():\n]+|\/[^():\n]+):(\d+):(\d+)\)?/);
    if (!match) {
      continue;
    }

    const filePath = match[1].startsWith('file://') ? fileURLToPath(match[1]) : match[1];
    return {
      filePath,
      line: Number(match[2]),
      column: Number(match[3]),
    };
  }

  return undefined;
}

const previewCss = `
:root {
  color-scheme: light dark;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #f6f7f9;
  color: #17191c;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr;
}

header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid #d8dde6;
  background: #fff;
}

.title {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

h1 {
  margin: 0;
  font-size: 15px;
  line-height: 1.3;
}

.path,
.meta {
  color: #646b76;
  font-size: 12px;
  line-height: 1.4;
}

.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

main {
  min-height: 0;
  display: grid;
  place-items: center;
  padding: 24px;
}

.preview {
  max-width: min(100%, 1200px);
  width: 100%;
  display: grid;
  gap: 12px;
}

img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid #d8dde6;
  background: #fff;
}

pre {
  overflow: auto;
  margin: 0;
  padding: 16px;
  border: 1px solid #e0b4b4;
  background: #fff5f5;
  color: #7a1f1f;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
}

button {
  min-width: 36px;
  height: 32px;
  border: 1px solid #c9d0da;
  border-radius: 6px;
  background: #fff;
  color: #17191c;
  font: inherit;
  cursor: pointer;
}

@media (prefers-color-scheme: dark) {
  :root {
    background: #111316;
    color: #eceff4;
  }

  header,
  button {
    background: #191c20;
    color: #eceff4;
  }

  header,
  img,
  button {
    border-color: #333941;
  }

  .path,
  .meta {
    color: #a3abb7;
  }

  pre {
    border-color: #6b3434;
    background: #2a1515;
    color: #ffd6d6;
  }
}
`;

const previewScript = `
const image = document.getElementById('image');
const meta = document.getElementById('meta');
const refresh = document.getElementById('refresh');
const errorBox = document.getElementById('error');
const events = new EventSource('/events');
let reloadNonce = 0;

async function loadMeta() {
  const response = await fetch('/meta.json?t=' + Date.now());
  const payload = await response.json();

  if (!response.ok) {
    throw payload.error || new Error('Render failed');
  }

  return payload;
}

function showMeta(data) {
  const options = data.renderOptions || {};
  meta.textContent = [
    options.width && options.height ? options.width + ' x ' + options.height : null,
    options.devicePixelRatio ? '@' + options.devicePixelRatio + 'x' : null,
    data.renderMs + 'ms',
  ].filter(Boolean).join('  ');
}

function showError(error) {
  const location = error && error.location
    ? error.location.filePath + ':' + error.location.line + ':' + error.location.column
    : '';
  meta.textContent = location ? 'Render failed at ' + location : 'Render failed';
  errorBox.hidden = false;
  const lines = [];

  if (error && error.message) {
    lines.push(error.message);
  } else {
    lines.push(String(error));
  }

  if (location) {
    lines.push('', 'Location: ' + location);
  }

  if (error && error.stack && error.stack !== error.message) {
    lines.push('', error.stack);
  }

  errorBox.textContent = lines.join('\\n');
}

async function reload() {
  errorBox.hidden = true;
  image.src = '/preview.png?t=' + String(++reloadNonce);

  try {
    const data = await loadMeta();
    showMeta(data);
  } catch (error) {
    showError(error);
  }
}

image.addEventListener('load', async () => {
  errorBox.hidden = true;
  try {
    const data = await loadMeta();
    showMeta(data);
  } catch (error) {
    showError(error);
  }
});

image.addEventListener('error', async () => {
  try {
    await loadMeta();
  } catch (error) {
    showError(error);
  }
});

refresh.addEventListener('click', () => {
  void reload();
});
events.addEventListener('reload', () => {
  void reload();
});
events.addEventListener('ready', () => {
  // no-op, connection established
});
events.addEventListener('error', () => {
  meta.textContent = 'Disconnected, retrying...';
});
`;
