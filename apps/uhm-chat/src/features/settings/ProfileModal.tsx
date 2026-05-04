import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Loader2 } from 'lucide-react';
import { useChatClient, useChatUser, Avatar } from '@ermis-network/ermis-chat-react';
import { toast } from 'sonner';
import { UhmModal } from '@/components/custom/UhmModal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ProfileModal: React.FC<ProfileModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const { client } = useChatClient();
  const { user } = useChatUser();
  const [name, setName] = useState(user?.name || '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewAvatar, setPreviewAvatar] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName(user?.name || '');
      setPreviewAvatar(null);
      setSelectedFile(null);
      setError(null);
    }
    // Only reset when isOpen changes to true. 
    // We don't include 'user' here because updating the user profile 
    // would trigger this and reset isSuccess prematurely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFile(file);
    setError(null);

    // Show preview
    const reader = new FileReader();
    reader.onloadend = () => {
      setPreviewAvatar(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    // 1. Normalize and check for invalid patterns
    const normalized = name.normalize('NFC');
    
    // Regex for control characters and invisible markers
    const controlCharsRegex = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/;
    // Regex for Zalgo (3+ consecutive combining marks)
    const zalgoRegex = /[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]{3,}/;

    if (controlCharsRegex.test(normalized) || zalgoRegex.test(normalized)) {
      setError(t('profile.error_invalid_name'));
      return;
    }

    const trimmedName = normalized.replace(/\s+/g, ' ').trim();
    
    if (!client || !trimmedName) return;

    // 2. Validate length
    if (trimmedName.length < 2) {
      setError(t('profile.error_name_short'));
      return;
    }

    if (trimmedName.length > 50) {
      setError(t('profile.error_name_long'));
      return;
    }

    try {
      setIsSaving(true);
      setError(null);

      // 1. Upload avatar if selected
      if (selectedFile) {
        await client.uploadAvatar(selectedFile);
      }

      // 2. Update name if changed
      if (trimmedName !== user?.name) {
        await client.updateProfile({ name: trimmedName });
      }

      toast.success(t('profile.success'));
      onClose();
    } catch (err) {
      console.error('Failed to update profile:', err);
      setError(t('profile.error'));
      toast.error(t('profile.error'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <UhmModal
      isOpen={isOpen}
      onClose={onClose}
      title={t('profile.title')}
      maxWidth="400px"
    >
      <form 
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
        className="flex flex-col items-center gap-6 py-2"
      >
        {/* Avatar Section */}
        <div className="relative group cursor-pointer" onClick={handleAvatarClick}>
          <div className="relative">
            <Avatar
              image={previewAvatar || user?.avatar}
              name={user?.name || user?.id}
              size={100}
              className="ring-4 ring-background shadow-lg"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
              <Camera className="w-8 h-8 text-white" />
            </div>
            {(isSaving) && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-full">
                <Loader2 className="w-8 h-8 text-white animate-spin" />
              </div>
            )}
          </div>
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept="image/*"
            onChange={handleFileChange}
            disabled={isSaving}
          />
          <p className="text-xs text-zinc-500 mt-2 text-center group-hover:text-primary transition-colors">
            {t('profile.edit_avatar')}
          </p>
        </div>

        {/* Name Section */}
        <div className="w-full space-y-1.5">
          <Label htmlFor="profile-name" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {t('profile.name_label')}
          </Label>
          <Input
            id="profile-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder={t('profile.name_placeholder')}
            maxLength={50}
            className={`h-10 bg-zinc-50 dark:bg-[#1a1828] border transition-all ${
              error 
                ? 'border-destructive focus-visible:ring-destructive/20 ring-destructive/10' 
                : 'border-zinc-200 dark:border-zinc-800 focus-visible:ring-primary/20'
            }`}
            disabled={isSaving}
          />
          {error && (
            <p className="text-[11px] text-destructive font-medium animate-in fade-in slide-in-from-top-1 duration-200">
              {error}
            </p>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-3 w-full pt-4">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            className="flex-1 rounded-full h-11"
            disabled={isSaving}
          >
            {t('profile.cancel')}
          </Button>
          <Button
            type="submit"
            className="flex-1 rounded-full h-11 bg-primary hover:bg-primary/90 text-white"
            disabled={isSaving || !name.trim() || (name.trim() === user?.name && !selectedFile)}
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('profile.saving')}
              </>
            ) : (
              t('profile.save')
            )}
          </Button>
        </div>
      </form>
    </UhmModal>
  );
};
