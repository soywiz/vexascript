export function buildPreviewDocument(code: string, previewChannelId: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { color-scheme: dark; }
      html, body { margin: 0; min-height: 100%; background: #101113; color: #f3f4f6; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { padding: 16px; }
      #vexa-console {
        position: fixed;
        right: 12px;
        bottom: 12px;
        width: min(360px, calc(100vw - 24px));
        max-height: min(42vh, 260px);
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 12px;
        overflow: hidden;
        background: rgba(10, 12, 16, 0.72);
        backdrop-filter: blur(14px);
        box-shadow: 0 18px 40px rgba(0, 0, 0, 0.32);
      }
      #vexa-console.is-collapsed {
        grid-template-rows: auto 0fr;
      }
      #vexa-console-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.06);
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      #vexa-console-toggle {
        border: 0;
        border-radius: 999px;
        padding: 4px 10px;
        background: rgba(255, 255, 255, 0.1);
        color: #f3f4f6;
        font: inherit;
        cursor: pointer;
      }
      #vexa-console-output {
        overflow: auto;
        margin: 0;
        padding: 12px;
        color: #e5e7eb;
        font: 12px/1.5 "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <section id="vexa-console" aria-live="polite">
      <div id="vexa-console-header">
        <span>Console</span>
        <button id="vexa-console-toggle" type="button" aria-expanded="true">Hide</button>
      </div>
      <pre id="vexa-console-output"></pre>
    </section>
    <script type="module">
      const channelId = ${JSON.stringify(previewChannelId)};
      const consoleRoot = document.getElementById("vexa-console");
      const consoleOutput = document.getElementById("vexa-console-output");
      const consoleToggle = document.getElementById("vexa-console-toggle");
      const appendOutput = (level, args) => {
        const prefix = level === "log" ? "" : "[" + level + "] ";
        const message = args.map((arg) => {
          if (typeof arg === "string") return arg;
          if (typeof arg === "number" || typeof arg === "boolean" || arg == null) return String(arg);
          if (typeof arg === "object") {
            try { return JSON.stringify(arg, null, 2); } catch { return Object.prototype.toString.call(arg); }
          }
          return String(arg);
        }).join(" ");
        consoleOutput.textContent += prefix + message + "\\n";
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
      };
      consoleToggle.addEventListener("click", () => {
        const collapsed = consoleRoot.classList.toggle("is-collapsed");
        consoleToggle.textContent = collapsed ? "Show" : "Hide";
        consoleToggle.setAttribute("aria-expanded", String(!collapsed));
      });
      window.addEventListener("message", (event) => {
        const payload = event.data;
        if (!payload || typeof payload !== "object" || payload.type !== "vexa-preview-console-command" || payload.channelId !== channelId) {
          return;
        }
        if (payload.command === "clear") {
          consoleOutput.textContent = "";
        }
      });
      const forward = (level) => (...args) => appendOutput(level, args);
      console.log = forward("log");
      console.info = forward("info");
      console.warn = forward("warn");
      console.error = forward("error");
      window.onerror = (message, _source, _line, _column, error) => {
        appendOutput("error", [error?.stack || error?.message || String(message)]);
      };
      window.onunhandledrejection = (event) => {
        const reason = event.reason;
        appendOutput("error", [reason?.stack || reason?.message || String(reason)]);
      };
      const userCode = ${JSON.stringify(code)};
      const blob = new Blob([userCode], { type: "text/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      try {
        await import(blobUrl);
      } catch (error) {
        appendOutput("error", [error?.stack || error?.message || String(error)]);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    </script>
  </body>
</html>`;
}
