import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useAccountsStore } from '../../store/accountsStore';
import { useTranslation } from '../../i18n';
import './MyQrCode.css';

interface MyQrCodeProps {
  onClose: () => void;
}

/**
 * "My QR code" — like the native Telegram app: a QR with the t.me deep link
 * to your profile that another phone can scan to open a chat with you.
 */
export const MyQrCode = ({ onClose }: MyQrCodeProps) => {
  const { t } = useTranslation();
  const account = useAccountsStore((s) => s.accounts.find((a) => a.id === s.activeAccountId) ?? null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!account) return null;

  const { username, phone, first_name: firstName, last_name: lastName } = account.userInfo;
  // Prefer the username link (works for everyone); fall back to the phone link
  // (resolves only if the user's privacy settings allow finding them by phone).
  const phoneDigits = (phone || '').replace(/\D/g, '');
  const link = username
    ? `https://t.me/${username}`
    : phoneDigits
      ? `https://t.me/+${phoneDigits}`
      : null;

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — nothing to do
    }
  };

  return (
    <div className="qr-overlay" onClick={onClose}>
      <div className="qr-card" onClick={(e) => e.stopPropagation()}>
        <button className="qr-close" onClick={onClose} title={t('close' as any)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <h3 className="qr-title">{t('my_qr_code' as any)}</h3>

        {link ? (
          <>
            <div className="qr-code-box">
              <QRCodeSVG value={link} size={220} level="M" marginSize={2} />
            </div>
            <div className="qr-name">
              {firstName} {lastName || ''}
            </div>
            <div className="qr-handle">{username ? `@${username}` : phone}</div>
            {!username && (
              <div className="qr-hint qr-hint-warn">{t('qr_phone_fallback_hint' as any)}</div>
            )}
            <div className="qr-hint">{t('qr_scan_hint' as any)}</div>
            <button className="qr-copy-btn" onClick={copyLink}>
              {copied ? t('qr_link_copied' as any) : t('qr_copy_link' as any)}
            </button>
          </>
        ) : (
          <div className="qr-hint">{t('qr_no_username' as any)}</div>
        )}
      </div>
    </div>
  );
};
