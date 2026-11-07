import { useState } from 'react';
import { useAccountsStore } from '../../store/accountsStore';
import { useTranslation } from '../../i18n';
import './ProfileSettings.css';

interface ProfileSettingsProps {
  onClose: () => void;
}

export const ProfileSettings = ({ onClose }: ProfileSettingsProps) => {
  const { t } = useTranslation();
  const { getActiveAccount } = useAccountsStore();
  const activeAccount = getActiveAccount();

  const [firstName, setFirstName] = useState(activeAccount?.userInfo?.first_name || '');
  const [lastName, setLastName] = useState(activeAccount?.userInfo?.last_name || '');
  const [bio, setBio] = useState('');
  const [username, setUsername] = useState(activeAccount?.userInfo?.username || '');

  const handleSave = () => {
    onClose();
  };

  return (
    <div className="profile-settings-overlay" onClick={onClose}>
      <div className="profile-settings" onClick={(e) => e.stopPropagation()}>
        <header className="profile-settings-header">
          <button className="profile-back-button" onClick={onClose}>
            ‹
          </button>
          <h2>{t('edit_profile')}</h2>
          <button className="profile-save-button" onClick={handleSave}>
            {t('done')}
          </button>
        </header>

        <div className="profile-settings-content">
          <div className="profile-avatar-section">
            <div className="profile-avatar-large">
              {activeAccount?.userInfo?.first_name?.substring(0, 1)?.toUpperCase() || 'ME'}
            </div>
            <button className="profile-avatar-upload">{t('upload_photo')}</button>
          </div>

          <div className="profile-form">
            <div className="profile-form-group">
              <label htmlFor="firstName">{t('first_name')}</label>
              <input
                id="firstName"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder={t('first_name_placeholder')}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>

            <div className="profile-form-group">
              <label htmlFor="lastName">{t('last_name')}</label>
              <input
                id="lastName"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder={t('last_name_placeholder')}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>

            <div className="profile-form-group">
              <label htmlFor="bio">{t('bio')}</label>
              <textarea
                id="bio"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder={t('bio_placeholder')}
                rows={4}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>

            <div className="profile-form-group">
              <label htmlFor="username">{t('username_label')}</label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="@username"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <span className="profile-form-hint">
                {t('username_hint')}
              </span>
            </div>
          </div>

          <div className="profile-info-section">
            <h3>{t('information')}</h3>
            <div className="profile-info-item">
              <span className="profile-info-label">{t('phone')}</span>
              <span className="profile-info-value">{activeAccount?.userInfo?.phone || t('not_set')}</span>
            </div>
            <div className="profile-info-item">
              <span className="profile-info-label">{t('account_id')}</span>
              <span className="profile-info-value">{activeAccount?.id || t('not_set')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
