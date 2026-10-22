/** HTML shell that asks for the bridge token. The QR is not on this page. */
export function renderTokenForm(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>grokbot-weixin login</title>
  <style>
    body { font: 16px/1.45 system-ui, sans-serif; margin: 2rem auto; max-width: 28rem; padding: 0 1rem; color: #172026; background: #f6f7f4; }
    form { display: grid; gap: 0.75rem; }
    input { font: inherit; padding: 0.55rem 0.7rem; }
    button { font: inherit; padding: 0.55rem 0.8rem; background: #176b4a; color: white; border: 0; }
  </style>
</head>
<body>
  <h1>grokbot-weixin</h1>
  <p>Enter the bridge token to open the WeChat QR login. 输入桥接令牌后才会显示微信登录二维码。</p>
  <form method="post" action="/login/session">
    <label for="token">Bridge token</label>
    <input id="token" name="token" type="password" autocomplete="current-password" required>
    <button type="submit">Continue</button>
  </form>
</body>
</html>`;
}

/** Authenticated login page. The QR is fetched with the session cookie. */
export function renderLoginApp(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>grokbot-weixin login</title>
  <style>
    body { font: 16px/1.45 system-ui, sans-serif; margin: 2rem auto; max-width: 36rem; padding: 0 1rem; color: #172026; background: #f6f7f4; }
    #qr svg { width: min(100%, 280px); height: auto; background: white; }
    input, button { font: inherit; padding: 0.5rem 0.7rem; }
    button { background: #176b4a; color: white; border: 0; }
    .row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem; }
    code { word-break: break-all; }
  </style>
</head>
<body>
  <h1>Scan with WeChat</h1>
  <p>用微信扫描二维码并确认登录。If WeChat asks for a code, enter it below.</p>
  <div id="qr"></div>
  <p id="status">Starting…</p>
  <p id="account"></p>
  <form id="verify" hidden>
    <label for="code">Verification code</label>
    <div class="row">
      <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="16">
      <button type="submit">Submit</button>
    </div>
  </form>
  <div class="row"><button id="restart" type="button">New QR code</button></div>
  <script>
    const statusEl = document.getElementById("status");
    const qrEl = document.getElementById("qr");
    const accountEl = document.getElementById("account");
    const verifyForm = document.getElementById("verify");
    let generation = 0;
    function show(data) {
      statusEl.textContent = data.message || data.phase || "";
      if (data.qr_svg) qrEl.innerHTML = data.qr_svg;
      accountEl.textContent = data.account_id ? ("Account " + data.account_id) : "";
      verifyForm.hidden = data.phase !== "need_verifycode";
      return data;
    }
    async function poll(gen) {
      while (gen === generation) {
        const began = Date.now();
        const response = await fetch("/login/status");
        if (gen !== generation) return;
        if (response.status === 401) { statusEl.textContent = "Login session expired. Reload and enter the token again."; return; }
        if (!response.ok) { statusEl.textContent = "Status request failed (" + response.status + ")"; return; }
        const data = show(await response.json());
        if (data.phase === "confirmed" || data.phase === "failed" || data.already_connected || data.phase === "need_verifycode") return;
        if (Date.now() - began < 3000) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    async function start(force) {
      generation += 1;
      const gen = generation;
      const response = await fetch("/login/start" + (force ? "?force=1" : ""), { method: "POST" });
      if (response.status === 401) { statusEl.textContent = "Login session expired. Reload and enter the token again."; return; }
      show(await response.json());
      await poll(gen);
    }
    verifyForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const code = document.getElementById("code").value.trim();
      const response = await fetch("/login/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code })
      });
      if (!response.ok) { statusEl.textContent = "Could not submit the code"; return; }
      generation += 1;
      await poll(generation);
    });
    document.getElementById("restart").addEventListener("click", () => { start(true); });
    start(false);
  </script>
</body>
</html>`;
}
