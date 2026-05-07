import React, { useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TopicModalProps } from '@ermis-network/ermis-chat-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useChatClient } from '@ermis-network/ermis-chat-react';

const DEFAULT_TOPIC_ICONS = ['💬', '🔥', '🚀', '⭐', '💡', '🎉', '📌', '📁', '🎨', '💻', '📈', '🤝', '🌈', '⚡', '🤖', '🎮', '🎧', '📚', '🍕', '⚽'];

export const UhmEditTopicModal: React.FC<TopicModalProps> = React.memo(({
  isOpen,
  onClose,
  topic,
  title: propTitle,
  nameLabel: propNameLabel,
  namePlaceholder: propNamePlaceholder,
  descriptionLabel: propDescriptionLabel,
  descriptionPlaceholder: propDescriptionPlaceholder,
  cancelButtonLabel: propCancelLabel,
  saveButtonLabel: propSaveLabel,
  savingButtonLabel: propSavingLabel,
}) => {
  const { t } = useTranslation();
  const { client, activeChannel } = useChatClient();
  
  // Use props if provided, otherwise use localized strings
  const title = propTitle || (topic ? t('edit.edit_topic_title') : t('edit.create_topic_title'));
  const nameLabel = propNameLabel || t('edit.topic_name');
  const descriptionLabel = propDescriptionLabel || t('edit.description');
  const namePlaceholder = propNamePlaceholder || t('edit.topic_name_placeholder');
  const descriptionPlaceholder = propDescriptionPlaceholder || t('edit.topic_description_placeholder');
  const cancelLabel = propCancelLabel || t('edit.cancel');
  const saveLabel = propSaveLabel || (topic ? t('edit.save') : t('edit.create'));
  const savingLabel = propSavingLabel || (topic ? t('edit.saving') : t('edit.creating'));

  const originalName = (topic?.data?.name as string) || '';
  const originalImage = (topic?.data?.image as string) || '';
  const originalEmoji = originalImage.startsWith('emoji://') ? originalImage.replace('emoji://', '') : '💬';
  const originalDescription = (topic?.data?.description as string) || '';

  const [name, setName] = useState(originalName);
  const [emoji, setEmoji] = useState(originalEmoji);
  const [description, setDescription] = useState(originalDescription);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    if (!name.trim() || !emoji) return;

    setIsSaving(true);
    setError(null);

    try {
      if (topic) {
        // Edit Mode
        const parentCid = topic.data?.parent_cid as string;
        const parentChannel = client.activeChannels[parentCid] || activeChannel;
        
        if (!parentChannel) throw new Error("Parent channel not found");

        const payload: any = {};
        if (name.trim() !== originalName) payload.name = name.trim();
        if (emoji !== originalEmoji) payload.image = `emoji://${emoji}`;
        if (description.trim() !== originalDescription) payload.description = description.trim();

        if (Object.keys(payload).length > 0 && topic.cid) {
          await parentChannel.editTopic(topic.cid, payload);
        }
      } else {
        // Create Mode
        if (!activeChannel) throw new Error("Active channel not found");
        
        const payload: any = {
          name: name.trim(),
          image: `emoji://${emoji}`,
          description: description.trim(),
        };

        await activeChannel.createTopic(payload);
      }
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to save topic');
    } finally {
      setIsSaving(false);
    }
  }, [client.activeChannels, activeChannel, topic, name, emoji, description, originalName, originalEmoji, originalDescription, onClose]);

  const isValid = name.trim().length > 0 && emoji.length > 0;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !isSaving && onClose()}>
      <DialogContent className="sm:max-w-[380px] bg-white dark:bg-[#1a1828] border-zinc-200 dark:border-[#3a3555] shadow-2xl p-0 overflow-hidden">
        <DialogHeader className="p-4 pb-0 text-center">
          <DialogTitle className="text-base font-bold">{title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col p-4 space-y-4">
          {/* Top Row: Icon + Name */}
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1.5 shrink-0">
              <Label className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">Icon</Label>
              <div className="w-12 h-12 flex items-center justify-center text-2xl bg-zinc-50/50 dark:bg-zinc-800/50 rounded-xl border border-zinc-200 dark:border-zinc-700/50 shadow-sm">
                {emoji || '💬'}
              </div>
            </div>
            <div className="flex-1 flex flex-col gap-1.5">
              <Label htmlFor="topic-name" className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">{nameLabel}</Label>
              <Input
                id="topic-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={namePlaceholder}
                className="h-12 bg-zinc-50/50 dark:bg-zinc-800/50 border-zinc-200 dark:border-zinc-700/50 text-sm font-bold"
                disabled={isSaving}
                maxLength={100}
              />
            </div>
          </div>

          {/* Compact Emoji Grid */}
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">{t('edit.choose_icon')}</Label>
            <div className="grid grid-cols-10 gap-1 p-1.5 bg-zinc-50/30 dark:bg-zinc-800/20 rounded-lg border border-zinc-100 dark:border-zinc-800/50">
              {DEFAULT_TOPIC_ICONS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  onClick={() => setEmoji(icon)}
                  className={`w-7.5 h-7.5 flex items-center justify-center text-base rounded-md transition-all hover:bg-white dark:hover:bg-zinc-700 ${emoji === icon ? 'bg-white dark:bg-zinc-700 shadow-sm scale-110 border border-primary/20' : 'opacity-60 hover:opacity-100'}`}
                  disabled={isSaving}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="topic-desc" className="text-[10px] uppercase tracking-widest font-bold text-zinc-500">{descriptionLabel}</Label>
            <textarea
              id="topic-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={descriptionPlaceholder}
              disabled={isSaving}
              rows={2}
              maxLength={500}
              className="flex min-h-[70px] w-full rounded-md border border-zinc-200 bg-zinc-50/50 px-3 py-2 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50 resize-none dark:bg-zinc-800/50 dark:border-zinc-700/50"
            />
          </div>

          {error && <div className="text-[10px] text-red-500 font-bold text-center bg-red-50 dark:bg-red-500/10 p-2 rounded-lg">{error}</div>}
        </div>

        <DialogFooter className="p-4 pt-0 gap-2">
          <Button variant="ghost" onClick={onClose} disabled={isSaving} className="flex-1 h-10 text-xs font-bold">
            {cancelLabel}
          </Button>
          <Button onClick={handleSave} disabled={isSaving || !isValid} className="flex-1 h-10 bg-primary hover:bg-primary/90 text-white font-bold text-xs">
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

UhmEditTopicModal.displayName = 'UhmEditTopicModal';
