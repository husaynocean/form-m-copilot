/**
 * Sends reminder emails through Brevo's transactional API when BREVO_API_KEY
 * and MAIL_FROM are set. Without them, reminders are skipped and the tracker
 * offers calendar reminders instead.
 */
export const mailEnabled = () => Boolean(process.env.BREVO_API_KEY && process.env.MAIL_FROM);

export async function sendMail(to: string, subject: string, html: string, text: string) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY!, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME ?? "Form M Copilot" },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });
  if (!res.ok) throw new Error(`mail ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
