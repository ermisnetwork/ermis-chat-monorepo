import React, { useEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface SlashCommandItem {
  command: string;
  label: string;
  description: string;
  icon?: LucideIcon;
  action: 'send' | 'poll';
}

export interface UhmSlashCommandSuggestionsProps {
  commands: SlashCommandItem[];
  highlightIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (cmd: SlashCommandItem, mode: 'send' | 'fill') => void;
}

export const UhmSlashCommandSuggestions: React.FC<UhmSlashCommandSuggestionsProps> = React.memo(
  ({ commands, highlightIndex, onHighlight, onSelect }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const itemsRef = useRef<Map<number, HTMLDivElement>>(new Map());

    useEffect(() => {
      const el = itemsRef.current.get(highlightIndex);
      if (el && containerRef.current) {
        const container = containerRef.current;
        const elementTop = el.offsetTop;
        const elementBottom = elementTop + el.offsetHeight;
        const containerTop = container.scrollTop;
        const containerBottom = containerTop + container.clientHeight;

        if (elementTop < containerTop) {
          container.scrollTop = elementTop;
        } else if (elementBottom > containerBottom) {
          container.scrollTop = elementBottom - container.clientHeight;
        }
      }
    }, [highlightIndex]);

    if (commands.length === 0) return null;

    return (
      <div
        ref={containerRef}
        className="absolute bottom-full left-2 mb-2 z-50 w-72 sm:w-80 max-h-60 overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-lg py-1 select-none"
      >
        {commands.map((cmd, index) => {
          const isHighlighted = index === highlightIndex;
          const Icon = cmd.icon;

          return (
            <div
              key={cmd.command}
              ref={(el) => {
                if (el) itemsRef.current.set(index, el);
                else itemsRef.current.delete(index);
              }}
              onMouseEnter={() => onHighlight(index)}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(cmd, 'send');
              }}
              className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors ${
                isHighlighted
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
              }`}
            >
              {Icon && <Icon className="w-4 h-4 text-zinc-400 shrink-0" />}
              <span className="font-mono text-sm font-semibold text-zinc-900 dark:text-zinc-100 shrink-0">
                {cmd.command}
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                {cmd.description}
              </span>
            </div>
          );
        })}
      </div>
    );
  }
);

UhmSlashCommandSuggestions.displayName = 'UhmSlashCommandSuggestions';
