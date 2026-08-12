// Outbound email for vote results.
//
// Two transports, picked by whichever env vars are present:
//
//   RESEND_API_KEY              → Resend's HTTP API over plain fetch (no SMTP,
//                                 nothing to configure on Google's side)
//   SMTP_HOST/USER/PASS         → any SMTP server via nodemailer, including
//                                 Gmail with an app password
//
// If neither is configured this no-ops with a warning rather than throwing, so
// the poll still closes and the results still land on the admin page — the same
// pattern routes/push.js uses for missing VAPID keys.

'use strict';

const RESEND_KEY = process.env.RESEND_API_KEY;
const SMTP_HOST  = process.env.SMTP_HOST;
const SMTP_PORT  = Number(process.env.SMTP_PORT || 587);
const SMTP_USER  = process.env.SMTP_USER;
const SMTP_PASS  = process.env.SMTP_PASS;

const FROM = process.env.MAIL_FROM || SMTP_USER || 'onboarding@resend.dev';

function isConfigured() {
  return !!(RESEND_KEY || (SMTP_HOST && SMTP_USER && SMTP_PASS));
}

function transportName() {
  if (RESEND_KEY) return 'resend';
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) return 'smtp';
  return null;
}

async function _sendResend({ to, subject, text, html }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to: Array.isArray(to) ? to : [to], subject, text, html }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Resend ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

async function _sendSmtp({ to, subject, text, html }) {
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transport.sendMail({ from: FROM, to, subject, text, html });
}

async function sendMail({ to, subject, text, html }) {
  const kind = transportName();
  if (!kind) {
    console.warn('[mail] not configured (set RESEND_API_KEY or SMTP_HOST/USER/PASS) — skipping:', subject);
    return { sent: false, skipped: 'unconfigured' };
  }
  try {
    if (kind === 'resend') await _sendResend({ to, subject, text, html });
    else await _sendSmtp({ to, subject, text, html });
    console.log(`[mail] sent via ${kind} to ${to}: ${subject}`);
    return { sent: true, transport: kind };
  } catch (err) {
    console.error('[mail] send failed:', err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { sendMail, isConfigured, transportName };
