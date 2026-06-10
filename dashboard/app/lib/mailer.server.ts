// System mailer for transactional auth emails (password reset, invites).
// Prefers AWS SES (the same path the rest of inkress uses — SES SDK + the
// ms.mailtrooper.com verified sender), falls back to SMTP, and finally logs the
// message server-side if nothing is configured (so the flow still works in dev).
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const from = process.env.SES_FROM_EMAIL || process.env.SMTP_FROM || "backwork.dev@ms.mailtrooper.com";

  // 1) AWS SES (SendEmail API)
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    try {
      const { SESClient, SendEmailCommand } = (await import("@aws-sdk/client-ses")) as any;
      const client = new SESClient({
        region: process.env.AWS_REGION || "us-east-1",
        credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY },
      });
      await client.send(new SendEmailCommand({
        Source: from,
        Destination: { ToAddresses: [to] },
        Message: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: text, Charset: "UTF-8" } } },
      }));
      return true;
    } catch (e) {
      console.error("[mailer] SES send failed:", e);
      // fall through to SMTP / log
    }
  }

  // 2) SMTP (nodemailer)
  if (process.env.SMTP_HOST) {
    try {
      const nodemailer = ((await import("nodemailer")) as any).default;
      const port = Number(process.env.SMTP_PORT || 587);
      const transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
      await transport.sendMail({ from, to, subject, text });
      return true;
    } catch (e) {
      console.error("[mailer] SMTP send failed:", e);
    }
  }

  // 3) no transport configured — log so the flow is still usable
  console.log(`[mailer] no transport configured — would send to ${to}: ${subject}\n${text}`);
  return false;
}
