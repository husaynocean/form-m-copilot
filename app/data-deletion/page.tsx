import type { Metadata } from "next";
import s from "../legal.module.css";

export const metadata: Metadata = { title: "Data deletion · Form M Copilot" };

export default function DataDeletion() {
  return (
    <main className={s.page}>
      <a className={s.back} href="/">← Form M Copilot</a>
      <h1>Delete your data</h1>
      <p>You can remove everything Form M Copilot holds about you at any time.</p>
      <h2>On WhatsApp</h2>
      <ol>
        <li>Send <b>new</b> to the Form M Copilot number to clear the documents from your current check.</li>
        <li>To remove your number and language setting as well, send <b>delete my data</b>.</li>
      </ol>
      <h2>By email</h2>
      <p>
        Email <a href="mailto:husseinitijani8632@gmail.com">husseinitijani8632@gmail.com</a> with the phone number you used. We
        delete all records for that number within 7 days and confirm by email.
      </p>
      <p>Website uploads are never stored, so there is nothing to delete for them.</p>
    </main>
  );
}
