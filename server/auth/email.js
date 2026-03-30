import nodemailer from 'nodemailer'

/**
 * Build the subject, plain-text, and HTML content for a verification email.
 *
 * @param {string} token
 * @param {string} appUrl - Public base URL of the application (no trailing slash)
 * @returns {{ subject: string, text: string, html: string }}
 */
export function buildVerificationEmailContent(token, appUrl) {
  const verificationUrl = `${appUrl}/api/auth/verify-email?token=${token}`

  const subject = 'Verify your Spades Online account'

  const text = [
    'Welcome to Spades Online!',
    '',
    'Please verify your email address by visiting the link below:',
    '',
    verificationUrl,
    '',
    'This link expires in 24 hours.',
    '',
    'If you did not create an account, you can safely ignore this email.',
  ].join('\n')

  const html = `
    <p>Welcome to <strong>Spades Online</strong>!</p>
    <p>Please verify your email address by clicking the button below:</p>
    <p>
      <a href="${verificationUrl}"
         style="display:inline-block;padding:10px 20px;background:#1a73e8;color:#fff;
                text-decoration:none;border-radius:4px;font-weight:bold;">
        Verify Email Address
      </a>
    </p>
    <p>Or copy and paste this URL into your browser:</p>
    <p>${verificationUrl}</p>
    <p>This link expires in 24 hours.</p>
    <p><small>If you did not create an account, you can safely ignore this email.</small></p>
  `.trim()

  return { subject, text, html }
}

function createTransport() {
  if (!process.env.EMAIL_HOST) return null

  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  })
}

/**
 * Send a verification email to the given address.
 * Falls back to console logging when EMAIL_HOST is not configured.
 *
 * @param {string} toEmail
 * @param {string} token
 */
export async function sendVerificationEmail(toEmail, token) {
  const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
  const fromAddress = process.env.EMAIL_FROM || 'noreply@spades.online'
  const { subject, text, html } = buildVerificationEmailContent(token, appUrl)

  const transport = createTransport()

  if (!transport) {
    console.log('Verification email (EMAIL_HOST not configured — logging instead):', {
      to: toEmail,
      subject,
      verificationUrl: `${appUrl}/api/auth/verify-email?token=${token}`,
    })
    return
  }

  await transport.sendMail({ from: fromAddress, to: toEmail, subject, text, html })
}
