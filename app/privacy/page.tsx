import type { Metadata } from "next";
import s from "../legal.module.css";

export const metadata: Metadata = { title: "Privacy policy · Form M Copilot" };

export default function Privacy() {
  return (
    <main className={s.page}>
      <a className={s.back} href="/">← Form M Copilot</a>
      <h1>Privacy policy</h1>
      <p>Last updated: 14 November 2026</p>
      <p>
        Form M Copilot is a prototype by Husseini Tijani, started at the Meta Global AI Developer Hackathon. It checks photos of
        trade and foreign-exchange documents (Form M, Form NXP, Form Q and Form A) for errors and drafts the form for review.
      </p>
      <h2>What we collect</h2>
      <ul>
        <li><b>Document photos</b> you upload on the website or send on WhatsApp.</li>
        <li><b>Your WhatsApp phone number</b> and chosen reply language, so the bot can keep your documents together and reply to you.</li>
        <li><b>Fields read from your documents</b> (names, amounts, ports, item descriptions) while a check is in progress.</li>
        <li><b>Saved deadlines</b>, only if you tap &ldquo;Save &amp; track&rdquo;: a summary (names, reference, amount, dates) and, if you add it, an email address for reminders.</li>
      </ul>
      <h2>How we use it</h2>
      <p>
        Only to read your documents, check them, and send you the result. Images are processed by Google&apos;s Gemini API
        on its free tier. We do not sell data or use it for advertising. Google may use free-tier requests to improve its
        products, so please send test documents only, not real customer paperwork.
      </p>
      <h2>Storage and retention</h2>
      <ul>
        <li>Website uploads are processed in memory and not stored.</li>
        <li>For WhatsApp, the extracted fields and your language choice are kept in a private database until you start a new check or ask for deletion. Images are not stored after reading.</li>
        <li>Saved deadlines stay until you delete them in the tracker (&ldquo;Delete&rdquo; or &ldquo;Delete everything&rdquo;). They are reachable only with your private tracker link. Reminder emails are sent through Brevo.</li>
        <li>For Form A, do not upload passports or tax documents: the app lists them as things to bring to the bank and never needs them.</li>
      </ul>
      <h2>Please don&apos;t send real customer documents</h2>
      <p>This is a prototype. Use sample or synthetic documents only.</p>
      <h2>Your choices</h2>
      <p>
        Send <b>new</b> on WhatsApp to clear your current documents, or see <a href="/data-deletion">data deletion</a> to remove
        everything. Contact: husseinitijani8632@gmail.com
      </p>
    </main>
  );
}
