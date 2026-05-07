import React, { useState, useCallback, useRef } from 'react';
import { Camera, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChatClient } from '@ermis-network/ermis-chat-react';
import type { EditChannelModalProps, EditChannelData } from '@ermis-network/ermis-chat-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

export const UhmEditChannelModal: React.FC<EditChannelModalProps> = React.memo(({
  channel,
  onClose,
  onSave,
  AvatarComponent,
  title: propTitle,
  nameLabel: propNameLabel,
  descriptionLabel: propDescriptionLabel,
  namePlaceholder: propNamePlaceholder,
  descriptionPlaceholder: propDescriptionPlaceholder,
  publicLabel: propPublicLabel,
  saveLabel: propSaveLabel,
  cancelLabel: propCancelLabel,
  savingLabel: propSavingLabel,
  imageAccept = 'image/*',
}) => {
  const { t } = useTranslation();
  const { client } = useChatClient();

  // Use props if provided, otherwise use localized strings
  const title = propTitle || t('edit.edit_channel_title');
  const nameLabel = propNameLabel || t('edit.channel_name');
  const descriptionLabel = propDescriptionLabel || t('edit.description');
  const namePlaceholder = propNamePlaceholder || t('edit.channel_name_placeholder');
  const descriptionPlaceholder = propDescriptionPlaceholder || t('edit.description_placeholder');
  const publicLabel = propPublicLabel || t('edit.public_channel');
  const saveLabel = propSaveLabel || t('edit.save_changes');
  const cancelLabel = propCancelLabel || t('edit.cancel');
  const savingLabel = propSavingLabel || t('edit.saving');

  const [name, setName] = useState((channel?.data?.name as string) || '');
  const [description, setDescription] = useState((channel?.data?.description as string) || '');
  const [isPublic, setIsPublic] = useState(channel?.type === 'public');
  const [image, setImage] = useState((channel?.data?.image as string) || '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const imageInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setIsSaving(true);
      setError(null);
      const { file: url } = await channel.sendFile(file, file.name, file.type);
      setImage(url);
    } catch (err: any) {
      setError(err?.message || 'Failed to upload image');
    } finally {
      setIsSaving(false);
    }
  }, [client]);

  const handleSaveInternal = useCallback(async () => {
    if (!name.trim()) return;

    setIsSaving(true);
    setError(null);

    const data: EditChannelData = {
      name: name.trim(),
      description: description.trim(),
      public: isPublic,
      image: image,
    };

    try {
      if (onSave) {
        await onSave(data);
      } else {
        await channel.update(data);
      }
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  }, [channel, name, description, isPublic, image, onSave, onClose]);

  return (
    <Dialog open onOpenChange={(open) => !open && !isSaving && onClose()}>
      <DialogContent className="sm:max-w-[380px] p-0 overflow-hidden bg-white dark:bg-[#1a1828] border-zinc-200 dark:border-[#3a3555] shadow-2xl">
        <DialogHeader className="p-5 pb-1 text-center">
          <DialogTitle className="text-lg font-bold">{title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col">
          {/* Identity Area (Centered Avatar) */}
          <div className="py-4 flex flex-col items-center bg-zinc-50/50 dark:bg-zinc-800/10 gap-3">
            <div className="relative group">
              <div className="p-1 bg-white dark:bg-[#1a1828] rounded-xl shadow-xl border border-zinc-100 dark:border-zinc-800">
                <AvatarComponent image={image} name={name} size={80} className="rounded-lg !w-20 !h-20 object-cover" />
              </div>
              <button
                onClick={() => imageInputRef.current?.click()}
                className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center rounded-lg text-white gap-1"
              >
                <Camera className="w-5 h-5" />
                <span className="text-[9px] font-bold uppercase">{t('edit.change_avatar')}</span>
              </button>
              <input type="file" ref={imageInputRef} className="hidden" accept={imageAccept} onChange={handleFileChange} />
            </div>
            <div className="text-center px-4 w-full">
              <h3 className="font-bold text-base leading-none truncate w-full">{name || t('edit.new_name_fallback')}</h3>
            </div>
          </div>

          <div className="p-5 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="channel-name" className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">{nameLabel}</Label>
              <Input
                id="channel-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={namePlaceholder}
                className="h-10 bg-zinc-50/50 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700/50 text-sm font-medium"
                disabled={isSaving}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="channel-desc" className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">{descriptionLabel}</Label>
              <textarea
                id="channel-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={descriptionPlaceholder}
                rows={2}
                className="flex min-h-[70px] w-full rounded-md border border-zinc-200 bg-zinc-50/50 px-3 py-2 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50 resize-none dark:bg-zinc-800/50 dark:border-zinc-700/50"
                disabled={isSaving}
              />
            </div>

            <div className="flex items-center justify-between p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/30 border border-zinc-100 dark:border-zinc-800">
              <div className="space-y-0.5">
                <Label className="text-xs font-semibold">{publicLabel}</Label>
                <p className="text-[10px] text-zinc-500">{t('edit.workspace_visibility')}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={isPublic}
                onClick={() => setIsPublic(!isPublic)}
                className={`relative inline-flex h-4.5 w-8 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${isPublic ? 'bg-primary' : 'bg-zinc-300 dark:bg-zinc-700'}`}
                disabled={isSaving}
              >
                <span className={`pointer-events-none block h-3.5 w-3.5 rounded-full bg-white shadow-lg ring-0 transition-transform ${isPublic ? 'translate-x-3.5' : 'translate-x-0'}`} />
              </button>
            </div>

            {error && <div className="text-[10px] text-red-500 font-bold text-center bg-red-50 dark:bg-red-500/10 p-2 rounded-lg">{error}</div>}
          </div>
        </div>

        <DialogFooter className="p-5 pt-0 gap-2">
          <Button variant="ghost" onClick={onClose} disabled={isSaving} className="flex-1 h-10 text-xs font-bold">
            {cancelLabel}
          </Button>
          <Button onClick={handleSaveInternal} disabled={isSaving || !name.trim()} className="flex-1 h-10 bg-primary hover:bg-primary/90 text-white font-bold text-xs">
            {isSaving ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                {savingLabel}
              </>
            ) : (
              saveLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

UhmEditChannelModal.displayName = 'UhmEditChannelModal';
