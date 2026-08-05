import nodemailer from 'nodemailer'
import type { SmtpRuntimeSettings } from '../settings/settings-admin-service.js'

export type OutboundEmail = Readonly<{
  recipientName: string
  recipientEmail: string
  subject: string
  html: string
  text: string
}>

export interface AccountMailer {
  send(message: OutboundEmail, settings: SmtpRuntimeSettings): Promise<boolean>
}

export class NodemailerAccountMailer implements AccountMailer {
  public async send(message: OutboundEmail, settings: SmtpRuntimeSettings): Promise<boolean> {
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: !settings.startTls,
      requireTLS: settings.startTls,
      auth: { user: settings.username, pass: settings.password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      tls: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        servername: settings.host
      }
    })

    try {
      const result = await transport.sendMail({
        from: { name: safeHeader(settings.senderName), address: settings.username },
        replyTo: { name: safeHeader(settings.replyName), address: settings.replyEmail },
        to: { name: safeHeader(message.recipientName), address: message.recipientEmail },
        subject: safeHeader(message.subject),
        html: message.html,
        text: message.text
      })
      return result.accepted.length > 0
    } catch {
      return false
    } finally {
      transport.close()
    }
  }
}

function safeHeader(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 998)
}
