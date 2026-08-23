import nodemailer from 'nodemailer';
import { env } from './env';

let transporter: nodemailer.Transporter | null = null;

function isAlertingConfigured(): boolean {
  return Boolean(env.smtpHost && env.smtpUser && env.smtpPass && env.alertEmailTo);
}

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtpHost!,
      port: env.smtpPort,
      secure: env.smtpPort === 465,
      auth: { user: env.smtpUser!, pass: env.smtpPass! },
    });
  }
  return transporter;
}

/**
 * Webhook処理失敗・抽選処理失敗など、運営者が把握すべき重大エラーをメールで通知する。
 * SMTP_HOST/SMTP_USER/SMTP_PASS/ALERT_EMAIL_TO が未設定の場合は何もしない
 * (アラート機能自体を必須にしないため)。
 * メール送信自体が失敗しても、呼び出し元の処理には影響させない。
 */
export async function sendAlertEmail(subject: string, body: string): Promise<void> {
  if (!isAlertingConfigured()) {
    return;
  }
  try {
    await getTransporter().sendMail({
      from: env.alertEmailFrom!,
      to: env.alertEmailTo!,
      subject: `[ガチャアプリ] ${subject}`,
      text: body,
    });
  } catch (err) {
    console.error('alert email send failed', err);
  }
}
