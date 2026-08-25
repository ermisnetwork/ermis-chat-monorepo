import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, Loader2, Mail, Phone, Hash, Copy, Music, Play, RotateCcw } from 'lucide-react';
import { useChatCore, useChatUser, Avatar, getUserDisplayName } from '@ermis-network/ermis-chat-react';
import { toast } from 'sonner';
import { UhmModal } from '@/components/custom/UhmModal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { processAvatarFile } from '@/utils/image';

interface ProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ProfileModal: React.FC<ProfileModalProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation();
  const { client } = useChatCore();
  const { user } = useChatUser();
  const userDisplayName = getUserDisplayName(user, user?.id);
  const [name, setName] = useState(userDisplayName);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewAvatar, setPreviewAvatar] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [customSound, setCustomSound] = useState<string | null>(null);
  const [initialSound, setInitialSound] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const handleCopy = (text: string) => {
    if (text) {
      navigator.clipboard.writeText(text);
      toast.success(t('message_actions.copy_success', 'Copied to clipboard'));
    }
  };

  useEffect(() => {
    if (isOpen) {
      setName(userDisplayName);
      setPreviewAvatar(null);
      setSelectedFile(null);
      setError(null);
      const currentSound = localStorage.getItem('custom_notification_sound');
      setCustomSound(currentSound);
      setInitialSound(currentSound);
    }
    // Only reset when isOpen changes to true. 
    // We don't include 'user' here because updating the user profile 
    // would trigger this and reset isSuccess prematurely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setIsProcessingImage(true);
      setError(null);
      
      const processedFile = await processAvatarFile(file);
      setSelectedFile(processedFile);

      // Show preview
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreviewAvatar(reader.result as string);
      };
      reader.readAsDataURL(processedFile);
    } catch (err: any) {
      console.error('Lỗi khi xử lý ảnh:', err);
      setError(t('edit.error_processing_image', 'Lỗi khi xử lý ảnh'));
    } finally {
      setIsProcessingImage(false);
    }
  };

  const handleAudioClick = () => {
    audioInputRef.current?.click();
  };

  const handleAudioChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 1024 * 1024) { // 1MB limit
      setError(t('profile.error_sound_large'));
      return;
    }

    try {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = reader.result as string;
        setCustomSound(dataUrl);
        setError(null);
        // preview the sound
        const tempAudio = new Audio(dataUrl);
        tempAudio.play().catch(console.error);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error(err);
    }
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
      if (trimmedName !== userDisplayName) {
        await client.updateProfile({ name: trimmedName });
      }

      // 3. Save custom sound
      if (customSound !== initialSound) {
        if (customSound) {
          localStorage.setItem('custom_notification_sound', customSound);
        } else {
          localStorage.removeItem('custom_notification_sound');
        }
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
        <div 
          className={`relative group ${isSaving || isProcessingImage ? 'cursor-wait' : 'cursor-pointer'}`} 
          onClick={() => !isSaving && !isProcessingImage && handleAvatarClick()}
        >
          <div className="relative">
            <Avatar
              image={previewAvatar || user?.avatar}
              name={userDisplayName}
              size={100}
              className="ring-4 ring-background shadow-lg"
            />
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
              <Camera className="w-8 h-8 text-white" />
            </div>
            {(isSaving || isProcessingImage) && (
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
            {isProcessingImage ? t('edit.processing_image') : t('profile.edit_avatar')}
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

        {/* Contact Info Section — read-only email/phone/id */}
        {(user?.email || user?.phone || user?.id) && (
          <div className="w-full space-y-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {t('profile.contact_info_label')}
            </span>
            {user?.id && (
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-[#1a1828] border border-zinc-200/60 dark:border-zinc-800/60 group">
                <Hash className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-tight">
                    {t('profile.user_id_label', 'User ID')}
                  </span>
                  <span className="text-xs text-zinc-700 dark:text-zinc-200 break-all font-mono leading-relaxed mt-0.5">
                    {user.id}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy(user.id)}
                  className="p-1.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  title={t('message_actions.copy', 'Copy')}
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {user?.email && (
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-[#1a1828] border border-zinc-200/60 dark:border-zinc-800/60 group">
                <Mail className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-tight">
                    {t('profile.email_label')}
                  </span>
                  <span className="text-sm text-zinc-700 dark:text-zinc-200 truncate">
                    {user.email}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy(user.email!)}
                  className="p-1.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  title={t('message_actions.copy', 'Copy')}
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            {user?.phone && (
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-[#1a1828] border border-zinc-200/60 dark:border-zinc-800/60 group">
                <Phone className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-tight">
                    {t('profile.phone_label')}
                  </span>
                  <span className="text-sm text-zinc-700 dark:text-zinc-200 truncate">
                    {user.phone}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopy(user.phone!)}
                  className="p-1.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  title={t('message_actions.copy', 'Copy')}
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {/* Notification Sound Section */}
        <div className="w-full space-y-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            {t('profile.notification_sound_label')}
          </span>
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-zinc-50 dark:bg-[#1a1828] border border-zinc-200/60 dark:border-zinc-800/60 group">
            <Music className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" />
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-sm text-zinc-700 dark:text-zinc-200 truncate">
                {customSound ? t('profile.upload_sound') : t('profile.default_sound')}
              </span>
            </div>
            {customSound && (
              <button
                type="button"
                onClick={() => {
                  const tempAudio = new Audio(customSound);
                  tempAudio.play().catch(console.error);
                }}
                className="p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md text-zinc-400 hover:text-primary transition-colors"
                title="Play"
              >
                <Play className="w-3.5 h-3.5" />
              </button>
            )}
            {customSound && (
              <button
                type="button"
                onClick={() => setCustomSound(null)}
                className="p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded-md text-zinc-400 hover:text-destructive transition-colors"
                title="Reset"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs bg-white dark:bg-zinc-900"
              onClick={handleAudioClick}
              disabled={isSaving}
            >
              {t('profile.upload_sound')}
            </Button>
            <input
              type="file"
              ref={audioInputRef}
              className="hidden"
              accept="audio/*"
              onChange={handleAudioChange}
              disabled={isSaving}
            />
          </div>
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
            disabled={isSaving || !name.trim() || (name.trim() === user?.name && !selectedFile && customSound === initialSound)}
          >
            {isSaving || isProcessingImage ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {isProcessingImage ? t('edit.processing_image') : t('profile.saving')}
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
