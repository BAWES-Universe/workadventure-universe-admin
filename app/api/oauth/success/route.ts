import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * GET /api/oauth/success
 *
 * Minimal success page displayed in the OAuth popup after a successful token
 * exchange. Renders a dark-themed confirmation message and immediately closes
 * the popup via window.close(). If the browser blocks window.close() for
 * non-script-opened windows, a fallback close button is shown.
 *
 * This replaces the previous behavior of redirecting back to the game URL
 * with ?oauth=success, which caused the full game to render in the popup
 * window before onMount could close it — leading to a sluggish experience
 * where the user briefly saw the game world inside the popup.
 */
export async function GET() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OAuth Connected</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0e0e10;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      text-align: center;
      padding: 2rem;
    }
    .container {
      max-width: 480px;
    }
    .checkmark {
      width: 80px;
      height: 80px;
      margin: 0 auto 1.5rem;
      background: #10b981;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 2.5rem;
      color: #fff;
      line-height: 1;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
      margin-bottom: 0.75rem;
      color: #f0f0f0;
    }
    p {
      font-size: 1.1rem;
      color: #9ca3af;
      margin-bottom: 2rem;
    }
    .close-btn {
      display: none;
      padding: 0.75rem 2rem;
      font-size: 1rem;
      font-weight: 600;
      color: #fff;
      background: #3b82f6;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .close-btn:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">&#10003;</div>
    <h1>OAuth Connected</h1>
    <p>Successfully authenticated. This window will close automatically.</p>
    <button class="close-btn" id="closeBtn" onclick="window.close()">
      Close Window
    </button>
  </div>
  <script>
    // Attempt to close immediately — works for popups opened via window.open
    window.close();
    // If window.close() was blocked (some browsers require user gesture for
    // windows not opened by script), show the close button after a short delay
    setTimeout(function() {
      document.getElementById('closeBtn').style.display = 'inline-block';
    }, 300);
  </script>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
  });
}
