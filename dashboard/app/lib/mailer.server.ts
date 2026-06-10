// System mailer for transactional auth emails (password reset). Uses SMTP_*
// env config; if unconfigured, it logs the message server-side (so the flow is
// still functional in dev / before SMTP is set) and returns false.
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const host = process.env.SMTP_HOST;
  if (!host) {
    console.log(`[mailer] SMTP not configured — would send to ${to}: ${subject}\n${text}`);
    return false;
  }
  try {
    const nodemailer = ((await import("nodemailer")) as any).default;
    const port = Number(process.env.SMTP_PORT || 587);
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    await transport.sendMail({ from: process.env.SMTP_FROM || "backwork <no-reply@backwork.dev>", to, subject, text });
    return true;
  } catch (e) {
    console.error("[mailer] send failed:", e);
    return false;
  }
}
