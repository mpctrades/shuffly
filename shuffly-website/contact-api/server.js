// Contact endpoint for shuffly.mpctrades.com.
//
// The marketing site is a static file served by nginx; this is the one bit of
// backend behind it, so "Send message" actually sends. nginx proxies
// /api/contact on the same host to this service, which keeps the browser
// request same-origin (no CORS, no third-party form relay).
//
// Mail goes out over Gmail SMTP as team@mpctrades.com. That matters for
// deliverability: mpctrades.com's SPF record is `include:_spf.google.com`
// only, so sending straight from this VPS would fail SPF and land in spam.

const express = require('express');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3007;

// nginx is the only thing in front of us, so believe exactly one hop of
// X-Forwarded-For. Without this every request looks like it came from
// 127.0.0.1 and the rate limiter below would lock out the whole internet
// after five submissions.
app.set('trust proxy', 1);

app.use(express.json({ limit: '64kb' }));

const TO = process.env.SMTP_TO || process.env.SMTP_USER;
const FROM = process.env.SMTP_FROM || process.env.SMTP_USER;

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages from this address. Try again later.' },
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Keep header-bound values on one line; a newline here could otherwise be
// used to inject extra mail headers.
function oneLine(s, max) {
  return String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/api/contact', limiter, async (req, res) => {
  try {
    const body = req.body || {};

    // Honeypot: the form ships a field no human can see. If it's filled in,
    // answer 200 so the bot thinks it worked, and send nothing.
    if (body.botcheck) return res.json({ ok: true });

    const name = oneLine(body.name, 100);
    const email = oneLine(body.email, 200);
    const store = oneLine(body.store, 200);
    const topic = oneLine(body.topic, 80) || 'General question';
    const message = String(body.message || '').trim().slice(0, 5000);

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Please fill in your name, email and message.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'That email address doesn’t look right.' });
    }

    const subject = `Shuffly — ${topic}${store ? ' — ' + store : ''} — ${name}`;

    const rows = [
      ['Topic', topic],
      ['Name', name],
      ['Email', email],
      ...(store ? [['Store', store]] : []),
    ];

    const html = `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:620px;padding:24px">
        <h2 style="margin:0 0 4px;color:#131110;border-bottom:2px solid #FF4B1F;padding-bottom:8px">
          New Shuffly enquiry
        </h2>
        <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px">
          ${rows.map(([k, v], i) => `
          <tr${i % 2 ? ' style="background:#fafafa"' : ''}>
            <td style="padding:8px;color:#737373;font-size:13px;width:110px">${k}</td>
            <td style="padding:8px">${k === 'Email'
              ? `<a href="mailto:${escapeHtml(v)}">${escapeHtml(v)}</a>`
              : escapeHtml(v)}</td>
          </tr>`).join('')}
          <tr${rows.length % 2 ? ' style="background:#fafafa"' : ''}>
            <td style="padding:8px;color:#737373;font-size:13px;vertical-align:top">Message</td>
            <td style="padding:8px;white-space:pre-wrap">${escapeHtml(message)}</td>
          </tr>
        </table>
        <p style="margin-top:24px;font-size:12px;color:#737373">
          Sent from the contact form on shuffly.mpctrades.com &middot; ${new Date().toISOString()}
        </p>
      </div>`;

    const text = [
      'New Shuffly enquiry',
      '',
      ...rows.map(([k, v]) => `${k}: ${v}`),
      '',
      'Message:',
      message,
      '',
      'Sent from the contact form on shuffly.mpctrades.com',
    ].join('\n');

    await transporter.sendMail({
      from: `"Shuffly site" <${FROM}>`,
      to: TO,
      replyTo: `"${name.replace(/"/g, '')}" <${email}>`,
      subject,
      text,
      html,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[contact] send failed:', err && err.message);
    res.status(502).json({ error: 'Could not send the message.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[contact] listening on ${PORT}, delivering to ${TO}`);
});
