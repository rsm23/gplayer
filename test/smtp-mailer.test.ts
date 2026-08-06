import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SmtpRuntimeSettings } from '../src/settings/settings-admin-service.js'

const smtp = vi.hoisted(() => ({
  close: vi.fn(),
  createTransport: vi.fn(),
  sendMail: vi.fn()
}))

vi.mock('nodemailer', () => ({ default: { createTransport: smtp.createTransport } }))

import { NodemailerAccountMailer, type OutboundEmail } from '../src/email/smtp-mailer.js'

const settings: SmtpRuntimeSettings = Object.freeze({
  host: 'smtp.example.test',
  port: 587,
  startTls: true,
  username: 'mailer@example.test',
  password: 'smtp-secret',
  senderName: 'GPlayer Mailer',
  replyEmail: 'support@example.test',
  replyName: 'Support'
})

const message: OutboundEmail = Object.freeze({
  recipientName: 'Test User',
  recipientEmail: 'user@example.test',
  subject: 'Confirm your account',
  html: '<p>Confirm your account.</p>',
  text: 'Confirm your account.'
})

describe('bounded SMTP account mailer', () => {
  beforeEach(() => {
    smtp.close.mockReset()
    smtp.createTransport.mockReset()
    smtp.sendMail.mockReset()
    smtp.createTransport.mockReturnValue({ close: smtp.close, sendMail: smtp.sendMail })
  })

  it('requires validated TLS, bounded timeouts, and disabled local/remote content access', async () => {
    smtp.sendMail.mockResolvedValue({ accepted: ['user@example.test'] })
    await expect(new NodemailerAccountMailer().send(message, settings)).resolves.toBe(true)

    expect(smtp.createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'mailer@example.test', pass: 'smtp-secret' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'smtp.example.test' }
    })
    expect(smtp.sendMail).toHaveBeenCalledWith({
      from: { name: 'GPlayer Mailer', address: 'mailer@example.test' },
      replyTo: { name: 'Support', address: 'support@example.test' },
      to: { name: 'Test User', address: 'user@example.test' },
      subject: 'Confirm your account',
      html: '<p>Confirm your account.</p>',
      text: 'Confirm your account.'
    })
    expect(smtp.close).toHaveBeenCalledOnce()
  })

  it('uses implicit TLS when STARTTLS is disabled and strips header control characters', async () => {
    smtp.sendMail.mockResolvedValue({ accepted: ['user@example.test'] })
    const implicitTls = { ...settings, port: 465, startTls: false, senderName: 'GPlayer\r\nBcc: attacker', replyName: 'Support\u0000Team' }
    const unsafeMessage = { ...message, recipientName: 'Test\nUser', subject: 'Confirm\r\nBcc: attacker' }

    await expect(new NodemailerAccountMailer().send(unsafeMessage, implicitTls)).resolves.toBe(true)
    expect(smtp.createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 465, secure: true, requireTLS: false }))
    expect(smtp.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: { name: 'GPlayer Bcc: attacker', address: 'mailer@example.test' },
      replyTo: { name: 'Support Team', address: 'support@example.test' },
      to: { name: 'Test User', address: 'user@example.test' },
      subject: 'Confirm Bcc: attacker'
    }))
    expect(smtp.close).toHaveBeenCalledOnce()
  })

  it('fails closed and closes the transport on rejection or delivery errors', async () => {
    smtp.sendMail.mockResolvedValueOnce({ accepted: [] }).mockRejectedValueOnce(new Error('unavailable'))
    const mailer = new NodemailerAccountMailer()
    await expect(mailer.send(message, settings)).resolves.toBe(false)
    await expect(mailer.send(message, settings)).resolves.toBe(false)
    expect(smtp.close).toHaveBeenCalledTimes(2)
  })
})
